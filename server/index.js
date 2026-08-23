const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GameEngine } = require('./game/engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function broadcastState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [socketId, playerId] of Object.entries(room.socketMap)) {
    const state = room.engine.getStateForPlayer(playerId);
    state.roomCode = roomCode;
    state.hostId = room.hostId;
    io.to(socketId).emit('game-state', state);
  }
}

const ROOM_GRACE_MS = 2 * 60 * 1000;

function keepRoom(room) {
  if (room && room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.engine.players.some(p => p.connected)) return keepRoom(room);
  if (room.emptyTimer) return;
  // Hold the room open for a while: everyone can briefly drop at once on a
  // flaky network or a server hiccup, and deleting immediately throws away a
  // game that all five players are about to rejoin.
  room.emptyTimer = setTimeout(() => {
    const r = rooms.get(roomCode);
    if (r && !r.engine.players.some(p => p.connected)) rooms.delete(roomCode);
  }, ROOM_GRACE_MS);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = null;

  socket.on('create-room', ({ playerName, gameMode, playerCount }, ack) => {
    playerCount = parseInt(playerCount);
    if (![4, 5, 6].includes(playerCount)) return ack?.({ error: 'Player count must be 4, 5 or 6' });
    if (playerCount === 6 && gameMode !== '3v3') gameMode = '3v3';
    if (playerCount === 5) gameMode = 'ffa'; // 5P_FFA is free-for-all only
    if (playerCount === 4 && !['2v2', 'ffa'].includes(gameMode)) return ack?.({ error: 'Invalid mode' });

    const code = generateCode();
    const engine = new GameEngine(gameMode, playerCount);
    const playerId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    engine.addPlayer(playerId, playerName);

    const room = {
      engine,
      hostId: playerId,
      socketMap: { [socket.id]: playerId },
      playerSockets: { [playerId]: socket.id },
    };
    rooms.set(code, room);

    currentRoom = code;
    currentPlayerId = playerId;
    socket.join(code);

    ack?.({ ok: true, roomCode: code, playerId });
    broadcastState(code);
  });

  socket.on('join-room', ({ roomCode, playerName }, ack) => {
    const code = roomCode?.toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack?.({ error: 'Room not found' });

    const engine = room.engine;

    keepRoom(room);

    if (engine.phase !== 'lobby') {
      // Match the empty seat by name. Taking the first disconnected seat
      // regardless of who is asking hands a stranger somebody else's hand.
      const wanted = String(playerName || '').trim().toLowerCase();
      const seat = engine.players.find(p => !p.connected && p.name.trim().toLowerCase() === wanted);

      if (seat) {
        // Keep the original player id. Hands, calls, tricks and scores are all
        // keyed by it, so minting a new one silently orphaned every one of them.
        const pid = seat.id;
        engine.reconnectPlayer(pid, pid);

        const staleSocket = room.playerSockets[pid];
        if (staleSocket) delete room.socketMap[staleSocket];
        room.socketMap[socket.id] = pid;
        room.playerSockets[pid] = socket.id;

        currentRoom = code;
        currentPlayerId = pid;
        socket.join(code);
        ack?.({ ok: true, roomCode: code, playerId: pid });
        broadcastState(code);
        return;
      }

      const missing = engine.players.filter(p => !p.connected).map(p => p.name);
      return ack?.({
        error: missing.length
          ? `Game in progress. To rejoin use your exact name: ${missing.join(', ')}`
          : 'Game in progress',
      });
    }

    if (engine.players.length >= engine.playerCount) return ack?.({ error: 'Room is full' });

    const playerId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    engine.addPlayer(playerId, playerName);
    room.socketMap[socket.id] = playerId;
    room.playerSockets[playerId] = socket.id;

    currentRoom = code;
    currentPlayerId = playerId;
    socket.join(code);

    ack?.({ ok: true, roomCode: code, playerId });
    broadcastState(code);
  });

  socket.on('start-game', (_, ack) => {
    const room = rooms.get(currentRoom);
    if (!room) return ack?.({ error: 'No room' });
    if (currentPlayerId !== room.hostId) return ack?.({ error: 'Only host can start' });
    const result = room.engine.startGame();
    if (result.error) return ack?.({ error: result.error });
    ack?.({ ok: true });
    broadcastState(currentRoom);
  });

  socket.on('submit-call', ({ call }, ack) => {
    const room = rooms.get(currentRoom);
    if (!room) return ack?.({ error: 'No room' });
    const result = room.engine.submitCall(currentPlayerId, call);
    if (result.error) return ack?.({ error: result.error });
    ack?.({ ok: true });
    broadcastState(currentRoom);
  });

  socket.on('play-card', ({ cardId }, ack) => {
    const room = rooms.get(currentRoom);
    if (!room) return ack?.({ error: 'No room' });
    const roomCode = currentRoom;
    const result = room.engine.playCard(currentPlayerId, cardId);
    if (result.error) return ack?.({ error: result.error });
    ack?.({ ok: true });
    broadcastState(roomCode);

    if (result.pending) {
      room.trickTimer = setTimeout(() => {
        const r = rooms.get(roomCode);
        if (!r) return;
        r.trickTimer = null;
        r.engine.resolvePendingTrick();
        broadcastState(roomCode);
      }, 20000);
    }
  });

  socket.on('next-trick', (_, ack) => {
    const room = rooms.get(currentRoom);
    if (!room) return ack?.({ error: 'No room' });
    if (!room.engine.pendingTrickWinner) return ack?.({ ok: true });
    clearTimeout(room.trickTimer);
    room.trickTimer = null;
    room.engine.resolvePendingTrick();
    ack?.({ ok: true });
    broadcastState(currentRoom);
  });

  socket.on('next-round', (_, ack) => {
    const room = rooms.get(currentRoom);
    if (!room) return ack?.({ error: 'No room' });
    if (currentPlayerId !== room.hostId) return ack?.({ error: 'Only host can advance' });
    const result = room.engine.nextRound();
    if (result.error) return ack?.({ error: result.error });
    ack?.({ ok: true });
    broadcastState(currentRoom);
  });

  socket.on('request-end-game', (_, ack) => {
    const room = rooms.get(currentRoom);
    if (!room) return ack?.({ error: 'No room' });
    const result = room.engine.requestEndGame(currentPlayerId);
    ack?.({ ok: true });
    broadcastState(currentRoom);
  });

  socket.on('cancel-end-game', (_, ack) => {
    const room = rooms.get(currentRoom);
    if (!room) return ack?.({ error: 'No room' });
    room.engine.cancelEndGame(currentPlayerId);
    ack?.({ ok: true });
    broadcastState(currentRoom);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !currentPlayerId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.engine.removePlayer(currentPlayerId);
    delete room.socketMap[socket.id];
    delete room.playerSockets[currentPlayerId];
    // Without this the host role stays with someone who has left and nobody
    // can start the next round or end the game.
    if (room.hostId === currentPlayerId) {
      const heir = room.engine.players.find(p => p.connected);
      if (heir) room.hostId = heir.id;
    }
    broadcastState(currentRoom);
    cleanupRoom(currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Trump Card Royal running on port ${PORT}`);
});
