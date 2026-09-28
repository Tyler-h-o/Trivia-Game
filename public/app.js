const socket = io();
const $ = id => document.getElementById(id);

const SUBJECTS = { history: 'History', math: 'Math', english: 'English', stem: 'STEM' };
const COUNTS = [5, 10, 15, 20];
const SHAPES = ['▲', '◆', '●', '■'];
const AVATAR_COLORS = ['#e84a5f', '#2f80ed', '#f2a93b', '#27ae60'];

let me = null;          // my playerId
let room = null;        // latest room_state
let clockOffset = 0;    // serverNow - Date.now()
let tick = null;

// ---- saved session, so a refresh drops you back into your game ----
function loadSession() {
  try { return JSON.parse(localStorage.getItem('trivia-session')) || {}; } catch { return {}; }
}
function saveSession(s) {
  try { localStorage.setItem('trivia-session', JSON.stringify(s)); } catch {}
}
function clearSession() {
  const { name } = loadSession();
  saveSession({ name });
}

// ---- helpers ----
function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${screen}`;
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 2200);
}
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}
function avatar(player) {
  const i = room.players.findIndex(p => p.id === player.id);
  return el('span', { class: 'avatar', style: `background:${AVATAR_COLORS[i % 4]}` }, player.name[0].toUpperCase());
}
function serverNow() { return Date.now() + clockOffset; }
function emit(event, data) {
  return new Promise(resolve => socket.emit(event, data, res => resolve(res || {})));
}

// ---- home ----
const params = new URLSearchParams(location.search);
$('name').value = loadSession().name || '';
if (params.get('room')) $('code').value = params.get('room').toUpperCase();

function enteredGame(res) {
  if (res.error) {
    $('home-error').textContent = res.error;
    return false;
  }
  me = res.playerId;
  saveSession({ name: $('name').value.trim(), code: res.code, playerId: res.playerId });
  history.replaceState(null, '', `?room=${res.code}`);
  render();
  return true;
}

$('home-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('home-error').textContent = '';
  enteredGame(await emit('create_room', { name: $('name').value }));
});

$('join-btn').addEventListener('click', async () => {
  $('home-error').textContent = '';
  const name = $('name').value.trim();
  const code = $('code').value.trim().toUpperCase();
  if (!name) return $('home-error').textContent = 'Enter your name.';
  if (code.length !== 4) return $('home-error').textContent = 'Room codes are 4 letters.';
  enteredGame(await emit('join_room', { name, code }));
});

$('code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('join-btn').click(); } });

// Rejoin automatically on page load and after a dropped connection.
socket.on('connect', async () => {
  const s = loadSession();
  if (!s.playerId || !s.code) return;
  const res = await emit('join_room', { code: s.code, playerId: s.playerId });
  if (res.error) {
    clearSession();
    me = null;
    room = null;
    show('home');
  } else {
    me = res.playerId;
    render();
  }
});

async function leave() {
  await emit('leave_room');
  clearSession();
  me = null;
  room = null;
  history.replaceState(null, '', location.pathname);
  show('home');
}
$('leave-btn').addEventListener('click', leave);
$('final-leave').addEventListener('click', leave);

// ---- lobby ----
$('copy-link').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
  catch { toast(link); }
});

$('start-btn').addEventListener('click', async () => {
  const res = await emit('start_game');
  $('lobby-error').textContent = res.error || '';
});

async function changeSettings(update) {
  const res = await emit('update_settings', update);
  $('lobby-error').textContent = res.error || '';
}

function renderLobby() {
  const isHost = room.hostId === me;
  $('lobby-code').textContent = room.code;
  $('player-count').textContent = `${room.players.length}/${room.maxPlayers}`;

  const slots = room.players.map(p => el('li', { class: `${p.id === me ? 'me' : ''} ${p.connected ? '' : 'offline'}`, title: p.id === me ? 'You' : p.name },
    avatar(p),
    el('span', { class: 'name' }, p.name),
    p.id === room.hostId ? el('span', { class: 'badge' }, 'HOST') : null));
  while (slots.length < room.maxPlayers) slots.push(el('li', { class: 'empty' }, 'Waiting…'));
  $('lobby-players').replaceChildren(...slots);

  const { subjects, count } = room.settings;
  $('subject-toggles').replaceChildren(...Object.entries(SUBJECTS).map(([key, label]) => {
    const on = subjects.includes(key);
    return el('button', {
      class: 'chip', 'aria-pressed': String(on), disabled: !isHost,
      onclick: () => changeSettings({ subjects: on ? subjects.filter(s => s !== key) : [...subjects, key] }),
    }, label);
  }));
  $('count-toggles').replaceChildren(...COUNTS.map(n => el('button', {
    class: 'chip', 'aria-pressed': String(n === count), disabled: !isHost,
    onclick: () => changeSettings({ count: n }),
  }, String(n))));

  $('start-btn').hidden = !isHost;
  $('start-btn').textContent = room.players.length < room.maxPlayers
    ? `Start with ${room.players.length} player${room.players.length === 1 ? '' : 's'}`
    : 'Start game';
  $('guest-wait').hidden = isHost;
}

// ---- question + reveal ----
async function pick(i) {
  $('choices').children[i]?.classList.add('picked');
  const res = await emit('answer', { choice: i });
  if (res.error) toast(res.error);
}

function renderQuestion() {
  const q = room.question;
  const revealed = room.state === 'reveal';
  const mine = room.players.find(p => p.id === me);

  $('q-subject').textContent = q.subjectName;
  $('q-subject').className = `subject-tag ${q.subject}`;
  $('q-number').textContent = `Question ${q.number} of ${q.total}`;

  // Only rebuild the prompt when the question changes, so it doesn't flicker.
  const key = `${q.number}`;
  if ($('choices').dataset.key !== key) {
    $('choices').dataset.key = key;
    $('q-prompt').textContent = q.prompt;
    $('choices').replaceChildren(...q.choices.map((c, i) => el('button', {
      class: 'choice', dataset: { i }, onclick: () => pick(i),
    }, el('span', { class: 'shape', 'aria-hidden': 'true' }, SHAPES[i]), el('span', {}, c), el('span', { class: 'who' }))));
  }

  const buttons = [...$('choices').children];
  const answered = mine && mine.answered;
  $('choices').classList.toggle('locked', !!answered && !revealed);
  $('choices').classList.toggle('revealed', revealed);
  buttons.forEach((b, i) => {
    b.disabled = answered || revealed;
    b.classList.toggle('correct', revealed && i === q.correctIndex);
    b.classList.toggle('picked', revealed ? mine?.answer === i : b.classList.contains('picked') && answered);
    const who = b.querySelector('.who');
    who.replaceChildren(...(revealed ? room.players.filter(p => p.answer === i).map(avatar) : []));
  });

  const status = $('q-status');
  status.className = 'q-status';
  if (revealed) {
    if (mine?.answer === q.correctIndex) {
      status.textContent = `Correct! +${mine.lastPoints}`;
      status.classList.add('good');
    } else {
      status.textContent = mine?.answer == null ? 'Time\'s up!' : 'Not quite.';
      status.classList.add('bad');
    }
  } else {
    const waiting = room.players.filter(p => p.connected && !p.answered).length;
    status.textContent = answered ? `Locked in. Waiting on ${waiting} player${waiting === 1 ? '' : 's'}…` : '';
  }

  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  $('q-players').replaceChildren(...sorted.map(p => el('li', { class: `${p.id === me ? 'me' : ''} ${p.connected ? '' : 'offline'}` },
    avatar(p),
    el('span', { class: 'name' }, p.name),
    revealed && p.lastPoints ? el('span', { class: 'gain' }, `+${p.lastPoints}`) : null,
    !revealed && p.answered ? el('span', { class: 'check', title: 'Answered' }, '✓') : null,
    el('span', { class: 'score' }, p.score.toLocaleString()))));

  startTicker();
}

function startTicker() {
  cancelAnimationFrame(tick);
  const frame = () => {
    if (!room || !room.question) return;
    const q = room.question;
    const fill = $('timer-fill');
    if (room.state === 'question') {
      const left = Math.max(0, q.endsAt - serverNow());
      fill.style.transform = `scaleX(${left / q.durationMs})`;
      fill.classList.toggle('low', left < 5000);
      $('q-timer').textContent = Math.ceil(left / 1000);
    } else {
      const left = Math.max(0, q.nextAt - serverNow());
      fill.style.transform = 'scaleX(0)';
      $('q-timer').textContent = '';
      if (q.number === q.total) $('q-number').textContent = 'Final question';
      else $('q-number').textContent = `Next question in ${Math.ceil(left / 1000)}`;
    }
    tick = requestAnimationFrame(frame);
  };
  frame();
}

// ---- pressing 1-4 answers too ----
document.addEventListener('keydown', e => {
  if (room?.state !== 'question' || e.target.tagName === 'INPUT') return;
  const i = ['1', '2', '3', '4'].indexOf(e.key);
  if (i >= 0) $('choices').children[i]?.click();
});

// ---- final ----
function renderFinal() {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const total = room.question?.total ?? room.settings.count;
  let place = 0;
  $('podium').replaceChildren(...sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) place = i + 1;
    return el('li', {},
      el('span', { class: 'place' }, String(place)),
      avatar(p),
      el('span', { class: 'name' }, p.name + (p.id === me ? ' (you)' : ''),
        el('div', { class: 'sub' }, `${p.correctCount} right`)),
      el('span', { class: 'score' }, p.score.toLocaleString()));
  }));
  const isHost = room.hostId === me;
  $('again-btn').hidden = !isHost;
  $('final-wait').hidden = isHost;
}

$('again-btn').addEventListener('click', () => emit('play_again'));

// ---- state from the server ----
socket.on('room_state', state => {
  room = state;
  clockOffset = state.serverNow - Date.now();
  render();
});

function render() {
  if (!me || !room) return;
  const state = room;
  if (state.state === 'lobby') { show('lobby'); renderLobby(); }
  else if (state.state === 'question' || state.state === 'reveal') { show('question'); renderQuestion(); }
  else if (state.state === 'finished') { cancelAnimationFrame(tick); show('final'); renderFinal(); }
}

socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));
