const crypto = require('crypto');
const bank = require('../data/questions.json');

// Category key -> display name, in the order the lobby shows them.
const SUBJECTS = bank._categories;
const MAX_PLAYERS = 4;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they look like 1 and 0

const defaultTiming = {
  questionMs: 15000,
  revealMs: 5000,
  lobbyGraceMs: 15000, // how long a disconnected lobby player keeps their seat (covers a page refresh)
  emptyRoomMs: 5 * 60 * 1000,
};

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Room timers never need to keep the process alive on their own; the HTTP server does that.
function later(fn, ms) {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || null;
}

class Room {
  constructor(code, timing, onChange, onEmpty) {
    this.code = code;
    this.timing = timing;
    this.onChange = onChange;
    this.onEmpty = onEmpty;
    this.players = new Map();
    this.hostId = null;
    this.state = 'lobby';
    this.settings = { subjects: Object.keys(SUBJECTS), count: 10 };
    this.used = new Set();
    this.questions = [];
    this.index = -1;
    this.endsAt = 0;
    this.timer = null;
    this.emptyTimer = null;
  }

  addPlayer(name) {
    const id = crypto.randomUUID();
    this.players.set(id, {
      id, name, score: 0, connected: true,
      answer: null, answeredAt: null, lastPoints: 0, correctCount: 0, removeTimer: null,
    });
    if (!this.hostId) this.hostId = id;
    this.clearEmptyTimer();
    return id;
  }

  isFull() {
    return this.players.size >= MAX_PLAYERS;
  }

  connect(id) {
    const p = this.players.get(id);
    if (!p) return false;
    p.connected = true;
    clearTimeout(p.removeTimer);
    p.removeTimer = null;
    this.clearEmptyTimer();
    return true;
  }

  disconnect(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    if (this.state === 'lobby') {
      p.removeTimer = later(() => this.removePlayer(id), this.timing.lobbyGraceMs);
    }
    if (this.hostId === id) this.passHost();
    this.checkEmpty();
    // A disconnected player shouldn't hold up everyone else's question.
    if (this.state === 'question') this.maybeEndQuestion();
    this.onChange(this);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    clearTimeout(p.removeTimer);
    this.players.delete(id);
    if (this.hostId === id) this.passHost();
    if (this.players.size === 0) {
      this.destroy();
      return;
    }
    this.checkEmpty();
    if (this.state === 'question') this.maybeEndQuestion();
    this.onChange(this);
  }

  passHost() {
    const next = [...this.players.values()].find(p => p.connected && p.id !== this.hostId)
      || [...this.players.values()].find(p => p.id !== this.hostId);
    this.hostId = next ? next.id : null;
  }

  checkEmpty() {
    const anyone = [...this.players.values()].some(p => p.connected);
    if (!anyone && !this.emptyTimer) {
      this.emptyTimer = later(() => this.destroy(), this.timing.emptyRoomMs);
    }
  }

  clearEmptyTimer() {
    clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  destroy() {
    clearTimeout(this.timer);
    this.clearEmptyTimer();
    for (const p of this.players.values()) clearTimeout(p.removeTimer);
    this.onEmpty(this);
  }

  updateSettings(id, { subjects, count } = {}) {
    if (id !== this.hostId) return 'Only the host can change settings.';
    if (this.state !== 'lobby') return 'Settings can only change in the lobby.';
    if (Array.isArray(subjects)) {
      const valid = subjects.filter(s => SUBJECTS[s]);
      if (valid.length === 0) return 'Pick at least one category.';
      this.settings.subjects = [...new Set(valid)];
    }
    if (count !== undefined) {
      const n = Number(count);
      if (![5, 10, 15, 20].includes(n)) return 'Choose 5, 10, 15 or 20 questions.';
      this.settings.count = n;
    }
    this.onChange(this);
    return null;
  }

  pickQuestions() {
    const { subjects, count } = this.settings;
    const perSubject = {};
    for (const s of subjects) {
      let pool = bank[s].map((q, i) => ({ key: `${s}:${i}`, subject: s, q }));
      let fresh = pool.filter(x => !this.used.has(x.key));
      if (fresh.length < Math.ceil(count / subjects.length)) {
        // Ran out of unseen questions for this subject; allow repeats again.
        for (const x of pool) this.used.delete(x.key);
        fresh = pool;
      }
      perSubject[s] = shuffle(fresh);
    }
    // Deal round-robin so the subjects stay evenly mixed.
    const picked = [];
    const order = shuffle(subjects);
    for (let i = 0; picked.length < count; i++) {
      const list = perSubject[order[i % order.length]];
      if (list.length) picked.push(list.shift());
      if (order.every(s => perSubject[s].length === 0)) break;
    }
    return shuffle(picked).map(({ key, subject, q }) => {
      this.used.add(key);
      const [prompt, correct, ...wrong] = q;
      const choices = shuffle([correct, ...wrong]);
      return { subject, prompt, choices, correctIndex: choices.indexOf(correct) };
    });
  }

  start(id) {
    if (id !== this.hostId) return 'Only the host can start the game.';
    if (this.state !== 'lobby') return 'The game has already started.';
    this.questions = this.pickQuestions();
    for (const p of this.players.values()) {
      p.score = 0;
      p.correctCount = 0;
      p.lastPoints = 0;
    }
    this.index = -1;
    this.nextQuestion();
    return null;
  }

  nextQuestion() {
    clearTimeout(this.timer);
    this.index++;
    if (this.index >= this.questions.length) {
      this.state = 'finished';
      this.onChange(this);
      return;
    }
    for (const p of this.players.values()) {
      p.answer = null;
      p.answeredAt = null;
      p.lastPoints = 0;
    }
    this.state = 'question';
    this.startedAt = Date.now();
    this.endsAt = this.startedAt + this.timing.questionMs;
    this.timer = later(() => this.reveal(), this.timing.questionMs);
    this.onChange(this);
  }

  answer(id, choice) {
    const p = this.players.get(id);
    if (!p || this.state !== 'question') return 'No question is open right now.';
    if (p.answer !== null) return 'You already answered.';
    const q = this.questions[this.index];
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.choices.length) return 'Invalid answer.';
    p.answer = choice;
    p.answeredAt = Date.now();
    this.maybeEndQuestion();
    if (this.state === 'question') this.onChange(this);
    return null;
  }

  maybeEndQuestion() {
    const active = [...this.players.values()].filter(p => p.connected);
    if (active.length > 0 && active.every(p => p.answer !== null)) this.reveal();
  }

  reveal() {
    if (this.state !== 'question') return;
    clearTimeout(this.timer);
    const q = this.questions[this.index];
    for (const p of this.players.values()) {
      if (p.answer === q.correctIndex) {
        // 500 for being right, plus up to 500 more for answering fast.
        const left = Math.max(0, this.endsAt - p.answeredAt) / this.timing.questionMs;
        p.lastPoints = 500 + Math.round(500 * left);
        p.score += p.lastPoints;
        p.correctCount++;
      } else {
        p.lastPoints = 0;
      }
    }
    this.state = 'reveal';
    this.nextAt = Date.now() + this.timing.revealMs;
    this.timer = later(() => this.nextQuestion(), this.timing.revealMs);
    this.onChange(this);
  }

  backToLobby(id) {
    if (id !== this.hostId) return 'Only the host can start a new game.';
    if (this.state !== 'finished') return 'The game is still going.';
    clearTimeout(this.timer);
    this.state = 'lobby';
    this.questions = [];
    this.index = -1;
    for (const p of [...this.players.values()]) {
      p.score = 0;
      p.lastPoints = 0;
      p.correctCount = 0;
      if (!p.connected) p.removeTimer = later(() => this.removePlayer(p.id), this.timing.lobbyGraceMs);
    }
    this.onChange(this);
    return null;
  }

  // What every client is allowed to see. The correct answer stays secret until the reveal.
  publicState() {
    const q = this.questions[this.index];
    const showing = this.state === 'question' || this.state === 'reveal';
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      settings: this.settings,
      maxPlayers: MAX_PLAYERS,
      serverNow: Date.now(),
      players: [...this.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        answered: p.answer !== null,
        answer: this.state === 'reveal' ? p.answer : undefined,
        lastPoints: p.lastPoints,
        correctCount: p.correctCount,
      })),
      question: showing ? {
        number: this.index + 1,
        total: this.questions.length,
        subject: q.subject,
        subjectName: SUBJECTS[q.subject],
        prompt: q.prompt,
        choices: q.choices,
        endsAt: this.endsAt,
        durationMs: this.timing.questionMs,
        correctIndex: this.state === 'reveal' ? q.correctIndex : undefined,
        nextAt: this.state === 'reveal' ? this.nextAt : undefined,
      } : null,
    };
  }
}

class Lobby {
  constructor(timing = {}, onChange = () => {}) {
    this.timing = { ...defaultTiming, ...timing };
    this.rooms = new Map();
    this.onChange = onChange;
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  create(name) {
    const n = cleanName(name);
    if (!n) return { error: 'Enter your name.' };
    const code = this.newCode();
    const room = new Room(code, this.timing, r => this.onChange(r), r => this.rooms.delete(r.code));
    this.rooms.set(code, room);
    const playerId = room.addPlayer(n);
    return { room, playerId };
  }

  join(code, name, playerId) {
    const room = this.rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) return { error: 'No game found with that code.' };
    if (playerId && room.players.has(playerId)) {
      room.connect(playerId);
      return { room, playerId };
    }
    const n = cleanName(name);
    if (!n) return { error: 'Enter your name.' };
    if (room.state !== 'lobby') return { error: 'That game has already started.' };
    if (room.isFull()) return { error: 'That game is full (4 players max).' };
    const taken = [...room.players.values()].some(p => p.name.toLowerCase() === n.toLowerCase());
    if (taken) return { error: 'Someone in that game already has that name.' };
    return { room, playerId: room.addPlayer(n) };
  }
}

module.exports = { Lobby, Room, SUBJECTS, MAX_PLAYERS };
