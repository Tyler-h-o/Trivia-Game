const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Lobby, SUBJECTS } = require('./src/game');

function createServer(timing = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/api/subjects', (req, res) => res.json(SUBJECTS));
  app.get('/healthz', (req, res) => res.send('ok'));

  // playerId -> socket id, so a second tab replaces the first instead of fighting it.
  const sockets = new Map();

  const lobby = new Lobby(timing, room => io.to(room.code).emit('room_state', room.publicState()));

  io.on('connection', socket => {
    let room = null;
    let playerId = null;

    function enter(result, ack) {
      if (result.error) return ack?.({ error: result.error });
      room = result.room;
      playerId = result.playerId;
      const old = sockets.get(playerId);
      if (old && old !== socket.id) io.sockets.sockets.get(old)?.disconnect(true);
      sockets.set(playerId, socket.id);
      socket.join(room.code);
      ack?.({ code: room.code, playerId });
      io.to(room.code).emit('room_state', room.publicState());
    }

    function hostAction(fn, ack) {
      if (!room) return ack?.({ error: 'You are not in a game.' });
      const error = fn();
      ack?.(error ? { error } : { ok: true });
    }

    socket.on('create_room', ({ name } = {}, ack) => {
      if (room) return ack?.({ error: 'You are already in a game.' });
      enter(lobby.create(name), ack);
    });

    socket.on('join_room', ({ code, name, playerId: id } = {}, ack) => {
      if (room) return ack?.({ error: 'You are already in a game.' });
      enter(lobby.join(code, name, id), ack);
    });

    socket.on('update_settings', (settings, ack) => hostAction(() => room.updateSettings(playerId, settings), ack));
    socket.on('start_game', (_, ack) => hostAction(() => room.start(playerId), ack));
    socket.on('play_again', (_, ack) => hostAction(() => room.backToLobby(playerId), ack));
    socket.on('answer', ({ choice } = {}, ack) => hostAction(() => room.answer(playerId, choice), ack));

    socket.on('leave_room', (_, ack) => {
      if (room) {
        sockets.delete(playerId);
        socket.leave(room.code);
        room.removePlayer(playerId);
        room = null;
        playerId = null;
      }
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      if (!room || sockets.get(playerId) !== socket.id) return;
      sockets.delete(playerId);
      room.disconnect(playerId);
    });
  });

  return { app, server, io, lobby };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().server.listen(port, () => console.log(`Live Trivia running at http://localhost:${port}`));
}

module.exports = { createServer };
