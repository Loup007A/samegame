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

// ── Game generation ─────────────────────────────────────────────────────────
const GAME_TYPES = ['dodge', 'breakout', 'memory', 'quiz'];
const ROOMS = ['arcade', 'lounge', 'arena', 'tavern'];

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
  ];
  const palette = palettes[Math.floor(rng() * palettes.length)];

  const configs = {
    dodge: {
      speed: 2 + Math.floor(rng() * 4),
      obstacleRate: 0.3 + rng() * 0.7,
      obstacleShape: ['circle', 'square', 'triangle', 'diamond'][Math.floor(rng() * 4)],
      bgPattern: ['stars', 'grid', 'dots', 'waves'][Math.floor(rng() * 4)],
      playerShape: ['ship', 'arrow', 'circle', 'star'][Math.floor(rng() * 4)],
      gravity: rng() > 0.5,
      palette,
    },
    breakout: {
      rows: 3 + Math.floor(rng() * 4),
      cols: 5 + Math.floor(rng() * 5),
      ballSpeed: 3 + Math.floor(rng() * 3),
      paddleSize: 60 + Math.floor(rng() * 60),
      brickPattern: ['solid', 'checkers', 'diagonal', 'random'][Math.floor(rng() * 4)],
      multiball: rng() > 0.7,
      palette,
    },
    memory: {
      gridSize: [2, 3, 4][Math.floor(rng() * 3)],
      symbols: ['emoji', 'shapes', 'letters', 'numbers'][Math.floor(rng() * 4)],
      flipDelay: 500 + Math.floor(rng() * 1000),
      showTime: 800 + Math.floor(rng() * 1200),
      palette,
    },
    quiz: {
      category: ['math', 'logic', 'anagram', 'sequence'][Math.floor(rng() * 4)],
      difficulty: ['easy', 'medium', 'hard'][Math.floor(rng() * 3)],
      timeLimit: 10 + Math.floor(rng() * 20),
      questionsCount: 5 + Math.floor(rng() * 10),
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

// ── WebSocket ─────────────────────────────────────────────────────────────────
const rooms = {};

wss.on('connection', (ws) => {
  ws.room = null; ws.playerId = null; ws.nickname = 'Anonymous';

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      ws.room = msg.room; ws.playerId = msg.playerId; ws.nickname = msg.nickname || `Player_${msg.playerId?.slice(0, 4)}`;
      if (!rooms[ws.room]) rooms[ws.room] = new Set();
      rooms[ws.room].add(ws);
      broadcast(ws.room, { type: 'system', content: `${ws.nickname} has joined the room.` }, null);
      broadcastCount(ws.room);
    }

    if (msg.type === 'chat' && ws.room) {
      const content = String(msg.content || '').trim().slice(0, 300);
      if (!content) return;
      db.get('messages').push({ room: ws.room, playerId: ws.playerId, nickname: ws.nickname, content, ts: Date.now() }).write();
      broadcast(ws.room, { type: 'chat', nickname: ws.nickname, content, playerId: ws.playerId, ts: Date.now() }, null);
    }

    if (msg.type === 'score_update' && ws.room) {
      broadcast(ws.room, { type: 'score_update', nickname: ws.nickname, score: msg.score }, ws);
    }
  });

  ws.on('close', () => {
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room].delete(ws);
      broadcast(ws.room, { type: 'system', content: `${ws.nickname} left the room.` }, null);
      broadcastCount(ws.room);
    }
  });
});

function broadcast(room, data, excludeWs) {
  if (!rooms[room]) return;
  const payload = JSON.stringify(data);
  rooms[room].forEach(client => { if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(payload); });
}

function broadcastCount(room) {
  broadcast(room, { type: 'online_count', count: rooms[room]?.size || 0 }, null);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 SAME GAME → http://localhost:${PORT}`));
