const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

function setup(timing) {
  const { server, io } = createServer({ questionMs: 400, revealMs: 100, lobbyGraceMs: 200, ...timing });
  return new Promise(resolve => server.listen(0, () => {
    const url = `http://localhost:${server.address().port}`;
    const clients = [];
    const client = () => {
      const c = connect(url, { forceNew: true, transports: ['websocket'] });
      c.last = null;
      c.on('room_state', s => { c.last = s; });
      clients.push(c);
      return c;
    };
    const close = () => { clients.forEach(c => c.close()); io.close(); server.close(); };
    resolve({ client, close });
  }));
}

const call = (c, event, data) => new Promise(r => c.emit(event, data, r));
const waitFor = (c, pred) => new Promise(resolve => {
  if (c.last && pred(c.last)) return resolve(c.last);
  const h = s => { if (pred(s)) { c.off('room_state', h); resolve(s); } };
  c.on('room_state', h);
});

test('four players play a full game', async () => {
  const { client, close } = await setup();
  try {
    const host = client();
    const { code, playerId: hostId, error } = await call(host, 'create_room', { name: 'Ada' });
    assert.ifError(error);
    assert.match(code, /^[A-Z]{4}$/);

    const others = [client(), client(), client()];
    for (const [i, c] of others.entries()) {
      const res = await call(c, 'join_room', { code: code.toLowerCase(), name: `P${i}` });
      assert.ifError(res.error);
    }
    const fifth = client();
    assert.match((await call(fifth, 'join_room', { code, name: 'Late' })).error, /full/);

    // Only the host can change settings or start.
    assert.match((await call(others[0], 'start_game')).error, /host/);
    assert.ifError((await call(host, 'update_settings', { subjects: ['science', 'geography'], count: 5 })).error);

    const players = [host, ...others];
    assert.ifError((await call(host, 'start_game')).error);

    for (let n = 1; n <= 5; n++) {
      const q = await waitFor(host, s => s.state === 'question' && s.question.number === n);
      assert.ok(['science', 'geography'].includes(q.question.subject));
      assert.strictEqual(q.question.correctIndex, undefined, 'answer must stay hidden during the question');
      assert.strictEqual(q.question.choices.length, 4);
      // Everyone answers choice 0; the round should end early once all four are in.
      assert.ifError((await call(host, 'answer', { choice: 0 })).error);
      assert.match((await call(host, 'answer', { choice: 1 })).error, /already/);
      for (const c of others) assert.ifError((await call(c, 'answer', { choice: 0 })).error);
      const r = await waitFor(host, s => s.state === 'reveal' && s.question.number === n);
      assert.ok(Number.isInteger(r.question.correctIndex));
      for (const p of r.players) {
        assert.strictEqual(p.answer, 0);
        assert.strictEqual(p.lastPoints > 0, r.question.correctIndex === 0);
      }
    }

    const final = await waitFor(host, s => s.state === 'finished');
    assert.strictEqual(final.players.length, 4);
    const correct = new Set(final.players.map(p => p.correctCount));
    assert.strictEqual(correct.size, 1, 'everyone gave the same answers');

    assert.ifError((await call(host, 'play_again')).error);
    const lobby = await waitFor(host, s => s.state === 'lobby');
    assert.ok(lobby.players.every(p => p.score === 0));
    assert.strictEqual(lobby.hostId, hostId);
  } finally {
    close();
  }
});

test('unanswered question times out and a refreshed player rejoins', async () => {
  const { client, close } = await setup();
  try {
    const a = client();
    const { code } = await call(a, 'create_room', { name: 'Ada' });
    let b = client();
    const { playerId: bId } = await call(b, 'join_room', { code, name: 'Bo' });
    assert.match((await call(client(), 'join_room', { code, name: 'bo' })).error, /name/);

    await call(a, 'update_settings', { count: 5 });
    await call(a, 'start_game');
    await waitFor(a, s => s.state === 'question');
    await call(a, 'answer', { choice: 2 });

    // Bo "refreshes": old socket closes, a new one rejoins with the saved player id.
    b.close();
    b = client();
    const rejoin = await call(b, 'join_room', { code, playerId: bId });
    assert.strictEqual(rejoin.playerId, bId);

    // Nobody else answers, so the timer ends the question.
    const r = await waitFor(a, s => s.state === 'reveal');
    assert.strictEqual(r.players.find(p => p.id === bId).answer, null);

    // Late joiners can't enter a game in progress.
    assert.match((await call(client(), 'join_room', { code, name: 'Cy' })).error, /started/);
  } finally {
    close();
  }
});

test('host leaving passes host to the next player', async () => {
  const { client, close } = await setup();
  try {
    const a = client();
    const { code } = await call(a, 'create_room', { name: 'Ada' });
    const b = client();
    const { playerId: bId } = await call(b, 'join_room', { code, name: 'Bo' });
    await call(a, 'leave_room');
    const s = await waitFor(b, s => s.players.length === 1);
    assert.strictEqual(s.hostId, bId);
    assert.match((await call(client(), 'join_room', { code: 'ZZZZ', name: 'X' })).error, /No game/);
  } finally {
    close();
  }
});
