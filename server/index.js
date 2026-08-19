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

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const hasConnected = room.engine.players.some(p => p.connected);
  if (!hasConnected) {
    rooms.delete(roomCode);
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = null;

  socket.on('create-room', ({ playerName, gameMode, playerCount }, ack) => {
    playerCount = parseInt(playerCount);
    if (![4, 6].includes(playerCount)) return ack?.({ error: 'Player count must be 4 or 6' });
    if (playerCount === 6 && gameMode !== '3v3') gameMode = '3v3';
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

    if (engine.phase !== 'lobby') {
      const disconnected = engine.players.find(p => !p.connected);
      if (disconnected) {
        const oldId = disconnected.id;
        const newId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        engine.reconnectPlayer(oldId, newId);
        disconnected.name = playerName;

        delete room.socketMap[room.playerSockets[oldId]];
        delete room.playerSockets[oldId];
        room.socketMap[socket.id] = newId;
        room.playerSockets[newId] = socket.id;

        if (room.hostId === oldId) room.hostId = newId;

        currentRoom = code;
        currentPlayerId = newId;
        socket.join(code);
        ack?.({ ok: true, roomCode: code, playerId: newId });
        broadcastState(code);
        return;
      }
      return ack?.({ error: 'Game in progress' });
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
    const result = room.engine.playCard(currentPlayerId, cardId);
    if (result.error) return ack?.({ error: result.error });
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
    broadcastState(currentRoom);
    cleanupRoom(currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Trump Card Royal running on port ${PORT}`);
});
