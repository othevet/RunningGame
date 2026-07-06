import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  connectionStateRecovery: {},
});

app.use(express.static(__dirname));

// ── Room management ──────────────────────
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

function roomData(room) {
  return {
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id, name: p.name, km: p.km, totalTime: p.totalTime,
      energy: p.energy, finished: p.finished, finishTime: p.finishTime, disconnected: p.disconnected,
    })),
    hostId: room.hostId,
    config: room.config,
    status: room.status,
    startTime: room.startTime,
  };
}

// ── Socket handlers ──────────────────────
io.on('connection', (socket) => {
  // ── Create room ──
  socket.on('create-room', ({ config, playerName }, callback) => {
    const code = generateCode();
    const room = {
      code,
      config,
      hostId: socket.id,
      status: 'waiting',
      startTime: null,
      players: new Map(),
    };
    room.players.set(socket.id, {
      name: playerName || 'Anonyme',
      km: 0, totalTime: 0, energy: 100,
      finished: false, finishTime: null, disconnected: false,
    });
    rooms.set(code, room);
    socket.join(code);
    callback({ ok: true, roomCode: code });
    socket.emit('room-refresh', { ...roomData(room), roomCode: code });
  });

  // ── Join room ──
  socket.on('join-room', ({ roomCode, playerName }, callback) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    if (!room) { callback({ ok: false, error: 'Code invalide' }); return; }
    if (room.status !== 'waiting') { callback({ ok: false, error: 'Course déjà commencée' }); return; }
    if (room.players.size >= 50) { callback({ ok: false, error: 'Course complète (50 max)' }); return; }

    room.players.set(socket.id, {
      name: playerName || 'Anonyme',
      km: 0, totalTime: 0, energy: 100,
      finished: false, finishTime: null, disconnected: false,
    });
    socket.join(code);
    callback({ ok: true, roomCode: code });
    socket.to(code).emit('player-joined', { playerId: socket.id, name: playerName || 'Anonyme' });
    socket.emit('room-refresh', { ...roomData(room), roomCode: code });
  });

  // ── Update config (host only) ──
  socket.on('update-config', ({ roomCode, config }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'waiting') return;
    room.config = config;
    io.to(roomCode).emit('config-updated', config);
  });

  // ── Start race ──
  socket.on('start-race', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.status = 'racing';
    room.startTime = Date.now();
    io.to(roomCode).emit('race-started', {
      startTime: room.startTime,
      config: room.config,
    });
  });

  // ── Player progress ──
  socket.on('km-complete', ({ roomCode, km, totalTime, energy }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.km = km;
    p.totalTime = totalTime;
    p.energy = energy;
    io.to(roomCode).emit('player-progress', {
      playerId: socket.id, name: p.name,
      km, totalTime, energy,
    });
  });

  // ── Player finished ──
  socket.on('race-finished', ({ roomCode, totalTime }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.finished = true;
    p.finishTime = totalTime;
    io.to(roomCode).emit('player-finished', {
      playerId: socket.id, name: p.name, totalTime,
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      if (!room.players.has(socket.id)) continue;
      const p = room.players.get(socket.id);
      p.disconnected = true;

      socket.to(code).emit('player-left', { playerId: socket.id, name: p.name });

      // Transfer host if needed
      if (room.hostId === socket.id) {
        const active = Array.from(room.players.entries()).find(([, pl]) => !pl.disconnected);
        if (active) {
          room.hostId = active[0];
          io.to(code).emit('host-changed', { hostId: active[0] });
        }
      }

      // Clean empty rooms
      const allGone = Array.from(room.players.values()).every(pl => pl.disconnected);
      if (allGone) rooms.delete(code);
      break;
    }
  });
});

// ── Start ──
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🏃 Le Dé du Coureur — serveur lancé sur http://localhost:${PORT}`);
});
