const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ────────────────────────────────────────────────────────────────
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ players: [], messages: [] }).write();

// ── Constants ────────────────────────────────────────────────────────────────
const GAME_TYPES = ['dodge', 'breakout', 'memory', 'quiz', 'snake', 'tetris'];
const ROOMS = ['arcade', 'lounge', 'arena', 'tavern', 'dungeon', 'nexus'];
const ROOM_MAX = 20; // 20 simultaneous players per room

// ── Game generation ─────────────────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function generateGameConfig(seed, type) {
  const rng = seededRandom(seed);
  const palettes = [
    { bg: '#0a0a1a', primary: '#ff3366', secondary: '#33ffcc', accent: '#ffcc00' },
    { bg: '#0d1117', primary: '#7c3aed', secondary: '#06b6d4', accent: '#f59e0b' },
    { bg: '#0f0f0f', primary: '#ef4444', secondary: '#22c55e', accent: '#3b82f6' },
    { bg: '#111827', primary: '#f97316', secondary: '#a855f7', accent: '#14b8a6' },
    { bg: '#1a0a2e', primary: '#ec4899', secondary: '#8b5cf6', accent: '#fbbf24' },
    { bg: '#0a1628', primary: '#00d4ff', secondary: '#ff6b35', accent: '#39ff14' },
    { bg: '#0d0a1a', primary: '#ff007f', secondary: '#00ffcc', accent: '#ffe600' },
    { bg: '#0a0f0a', primary: '#39ff14', secondary: '#ff3300', accent: '#00cfff' },
  ];
  const palette = palettes[Math.floor(rng() * palettes.length)];

  const configs = {
    dodge: {
      // Harder: higher speed, faster spawn, more obstacles simultaneously
      speed: 4 + Math.floor(rng() * 5),            // was 2-5, now 4-8
      obstacleRate: 0.6 + rng() * 1.2,             // was 0.3-1, now 0.6-1.8
      obstacleShape: ['circle', 'square', 'triangle', 'diamond', 'cross'][Math.floor(rng() * 5)],
      bgPattern: ['stars', 'grid', 'dots', 'waves', 'hex'][Math.floor(rng() * 5)],
      playerShape: ['ship', 'arrow', 'circle', 'star'][Math.floor(rng() * 4)],
      gravity: rng() > 0.4,                         // was 0.5, more gravity
      gravityPull: 0.08 + rng() * 0.1,
      sideObstacles: rng() > 0.5,                   // NEW: obstacles from sides
      accelerates: rng() > 0.4,                     // NEW: speed ramps up
      palette,
    },
    breakout: {
      // Harder: more bricks, faster ball, smaller paddle, multi-speed balls
      rows: 5 + Math.floor(rng() * 5),              // was 3-6, now 5-9
      cols: 7 + Math.floor(rng() * 5),              // was 5-9, now 7-11
      ballSpeed: 4 + Math.floor(rng() * 4),         // was 3-5, now 4-7
      paddleSize: 40 + Math.floor(rng() * 40),      // was 60-119, now 40-79 (smaller)
      brickPattern: ['solid', 'checkers', 'diagonal', 'random', 'fortress'][Math.floor(rng() * 5)],
      multiball: rng() > 0.5,                       // was 0.7, more frequent
      shrinkPaddle: rng() > 0.5,                    // NEW: paddle shrinks over time
      speedIncrease: rng() > 0.4,                   // NEW: ball speeds up on hits
      palette,
    },
    memory: {
      // Harder: bigger grid, shorter display time, no re-flip grace
      gridSize: [3, 4, 4][Math.floor(rng() * 3)],   // was 2-4, now min 3
      symbols: ['emoji', 'shapes', 'letters', 'numbers', 'kanji'][Math.floor(rng() * 5)],
      flipDelay: 400 + Math.floor(rng() * 600),     // was 500-1500, now 400-1000
      showTime: 400 + Math.floor(rng() * 600),      // was 800-2000, now 400-1000
      penalty: rng() > 0.5,                         // NEW: wrong match hides all
      timeLimit: rng() > 0.5 ? 60 + Math.floor(rng() * 60) : null, // NEW: optional timer
      palette,
    },
    quiz: {
      // Harder: less time, harder questions
      category: ['math', 'logic', 'anagram', 'sequence', 'wordplay'][Math.floor(rng() * 5)],
      difficulty: ['medium', 'hard', 'hard'][Math.floor(rng() * 3)], // less easy
      timeLimit: 6 + Math.floor(rng() * 10),        // was 10-30, now 6-15
      questionsCount: 8 + Math.floor(rng() * 10),   // was 5-14, now 8-17
      palette,
    },
    snake: {
      // Procedural snake
      startSpeed: 120 + Math.floor(rng() * 80),     // ms per tick (lower=faster)
      speedIncrease: rng() > 0.4,                   // gets faster over time
      wallWrap: rng() > 0.5,                        // wrap or die on walls
      obstacles: rng() > 0.5,                       // static obstacles
      ghostFood: rng() > 0.6,                       // food disappears
      palette,
    },
    tetris: {
      // Procedural tetris
      startSpeed: 600 + Math.floor(rng() * 400),    // ms per drop (lower=faster)
      speedIncrease: true,
      ghostPiece: rng() > 0.3,
      invisibleMode: rng() > 0.7,                   // pieces vanish after placing
      randomRotations: rng() > 0.6,                 // pieces start pre-rotated
      palette,
    },
  };

  return { type, seed, palette, ...configs[type] };
}

function getOrCreatePlayer(ip, fingerprint) {
  const id = crypto.createHash('sha256').update(`${ip}:${fingerprint}`).digest('hex').slice(0, 16);
  let player = db.get('players').find({ id }).value();

  if (!player) {
    const seed = Math.floor(Math.random() * 2147483647);
    const type = GAME_TYPES[Math.floor(Math.random() * GAME_TYPES.length)];
    const room = ROOMS[Math.floor(Math.random() * ROOMS.length)];
    player = {
      id, ip, fingerprint, game_seed: seed, game_type: type, room,
      score: 0, nickname: `Player_${id.slice(0, 4)}`, created_at: Date.now()
    };
    db.get('players').push(player).write();
  } else {
    db.get('players').find({ id }).assign({ last_seen: Date.now() }).write();
  }
  return player;
}

// ── REST API ─────────────────────────────────────────────────────────────────
app.post('/api/session', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '0.0.0.0';
  const { fingerprint, nickname } = req.body;
  try {
    const player = getOrCreatePlayer(ip, fingerprint || 'default');
    const config = generateGameConfig(player.game_seed, player.game_type);
    if (nickname) db.get('players').find({ id: player.id }).assign({ nickname }).write();
    res.json({ playerId: player.id, room: player.room, gameConfig: config, nickname: nickname || player.nickname });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Session error' });
  }
});

app.post('/api/score', (req, res) => {
  const { playerId, score } = req.body;
  const player = db.get('players').find({ id: playerId }).value();
  if (player && score > player.score) db.get('players').find({ id: playerId }).assign({ score }).write();
  res.json({ ok: true });
});

app.get('/api/room/:room/scores', (req, res) => {
  const scores = db.get('players').filter({ room: req.params.room }).sortBy('score').reverse().take(10).map(p => ({ nickname: p.nickname, score: p.score })).value();
  res.json(scores);
});

app.get('/api/room/:room/history', (req, res) => {
  const msgs = db.get('messages').filter({ room: req.params.room }).takeRight(50).value();
  res.json(msgs);
});

// Room occupancy endpoint
app.get('/api/room/:room/count', (req, res) => {
  const room = req.params.room;
  const count = rooms[room]?.size || 0;
  res.json({ count, max: ROOM_MAX, available: count < ROOM_MAX });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const rooms = {};        // room -> Set of ws clients
const waitingQueues = {}; // room -> array of ws clients waiting

wss.on('connection', (ws) => {
  ws.room = null; ws.playerId = null; ws.nickname = 'Anonymous'; ws.waiting = false;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      ws.room = msg.room; ws.playerId = msg.playerId; ws.nickname = msg.nickname || `Player_${msg.playerId?.slice(0, 4)}`;
      if (!rooms[ws.room]) rooms[ws.room] = new Set();
      if (!waitingQueues[ws.room]) waitingQueues[ws.room] = [];

      const roomSize = rooms[ws.room].size;

      if (roomSize >= ROOM_MAX) {
        // Room full — add to waiting queue
        ws.waiting = true;
        waitingQueues[ws.room].push(ws);
        const position = waitingQueues[ws.room].indexOf(ws) + 1;
        ws.send(JSON.stringify({ type: 'waiting', position, max: ROOM_MAX, current: roomSize }));
      } else {
        // Join normally
        admitPlayer(ws);
      }
    }

    if (msg.type === 'chat' && ws.room && !ws.waiting) {
      const content = String(msg.content || '').trim().slice(0, 300);
      if (!content) return;
      db.get('messages').push({ room: ws.room, playerId: ws.playerId, nickname: ws.nickname, content, ts: Date.now() }).write();
      broadcast(ws.room, { type: 'chat', nickname: ws.nickname, content, playerId: ws.playerId, ts: Date.now() }, null);
    }

    if (msg.type === 'score_update' && ws.room && !ws.waiting) {
      broadcast(ws.room, { type: 'score_update', nickname: ws.nickname, score: msg.score }, ws);
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;

    if (ws.waiting) {
      // Remove from queue
      const q = waitingQueues[ws.room];
      if (q) {
        const idx = q.indexOf(ws);
        if (idx !== -1) q.splice(idx, 1);
        // Update queue positions
        q.forEach((client, i) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'waiting', position: i + 1, max: ROOM_MAX, current: rooms[ws.room]?.size || 0 }));
          }
        });
      }
    } else if (rooms[ws.room]) {
      rooms[ws.room].delete(ws);
      broadcast(ws.room, { type: 'system', content: `${ws.nickname} left the room.` }, null);
      broadcastCount(ws.room);

      // Admit next in queue if space
      admitFromQueue(ws.room);
    }
  });
});

function admitPlayer(ws) {
  ws.waiting = false;
  rooms[ws.room].add(ws);
  ws.send(JSON.stringify({ type: 'admitted' }));
  broadcast(ws.room, { type: 'system', content: `${ws.nickname} has joined the room.` }, null);
  broadcastCount(ws.room);
}

function admitFromQueue(room) {
  if (!waitingQueues[room] || waitingQueues[room].length === 0) return;
  if ((rooms[room]?.size || 0) >= ROOM_MAX) return;

  const next = waitingQueues[room].shift();
  if (next && next.readyState === WebSocket.OPEN) {
    admitPlayer(next);
    // Update remaining queue positions
    waitingQueues[room].forEach((client, i) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'waiting', position: i + 1, max: ROOM_MAX, current: rooms[room]?.size || 0 }));
      }
    });
  }
}

function broadcast(room, data, excludeWs) {
  if (!rooms[room]) return;
  const payload = JSON.stringify(data);
  rooms[room].forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

function broadcastCount(room) {
  const count = rooms[room]?.size || 0;
  const queued = waitingQueues[room]?.length || 0;
  broadcast(room, { type: 'online_count', count, queued }, null);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 SAME GAME → http://localhost:${PORT}`));
