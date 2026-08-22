require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');

const { readDB, writeDB } = require('./lib/db');
const { hashPassword, checkPassword, signToken, verifyToken, requireAuth } = require('./lib/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AVATAR_COLORS = ['#7c5cff', '#3ddc97', '#ff8a5c', '#5b8def', '#ff5c8a', '#ffd15c'];
function randomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}
function inviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, color: u.color };
}

// ---------- AUTH ----------

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  if (username.length < 3) return res.status(400).json({ error: 'Usuário deve ter ao menos 3 caracteres' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres' });

  const db = readDB();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'Esse nome de usuário já existe' });
  }

  const user = {
    id: uuid(),
    username,
    passwordHash: hashPassword(password),
    color: randomColor(),
    createdAt: Date.now(),
  };
  db.users.push(user);
  await writeDB(db);

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const db = readDB();
  const user = db.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  if (!user || !checkPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json({ user: publicUser(user) });
});

// ---------- SERVERS (guilds) ----------

app.get('/api/servers', requireAuth, (req, res) => {
  const db = readDB();
  const mine = db.servers.filter(s => s.memberIds.includes(req.user.id));
  res.json({ servers: mine });
});

app.post('/api/servers', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome do servidor é obrigatório' });

  const db = readDB();
  const newServer = {
    id: uuid(),
    name: name.trim(),
    ownerId: req.user.id,
    inviteCode: inviteCode(),
    memberIds: [req.user.id],
    channels: [
      { id: uuid(), name: 'geral', type: 'text' },
      { id: uuid(), name: 'Sala de voz', type: 'voice' },
    ],
  };
  db.servers.push(newServer);
  await writeDB(db);
  res.json({ server: newServer });
});

app.post('/api/servers/join', requireAuth, async (req, res) => {
  const { inviteCode: code } = req.body || {};
  const db = readDB();
  const target = db.servers.find(s => s.inviteCode === (code || '').toUpperCase().trim());
  if (!target) return res.status(404).json({ error: 'Código de convite inválido' });

  if (!target.memberIds.includes(req.user.id)) {
    target.memberIds.push(req.user.id);
    await writeDB(db);
  }
  res.json({ server: target });
});

app.post('/api/servers/:serverId/channels', requireAuth, async (req, res) => {
  const { name, type } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome do canal é obrigatório' });

  const db = readDB();
  const srv = db.servers.find(s => s.id === req.params.serverId);
  if (!srv || !srv.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Servidor não encontrado' });

  const channel = { id: uuid(), name: name.trim(), type: type === 'voice' ? 'voice' : 'text' };
  srv.channels.push(channel);
  await writeDB(db);
  res.json({ channel });
});

app.get('/api/servers/:serverId/members', requireAuth, (req, res) => {
  const db = readDB();
  const srv = db.servers.find(s => s.id === req.params.serverId);
  if (!srv || !srv.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Servidor não encontrado' });
  const members = srv.memberIds.map(id => publicUser(db.users.find(u => u.id === id))).filter(Boolean);
  res.json({ members });
});

// ---------- MESSAGES ----------

app.get('/api/channels/:channelId/messages', requireAuth, (req, res) => {
  const db = readDB();
  const srv = db.servers.find(s => s.channels.some(c => c.id === req.params.channelId));
  if (!srv || !srv.memberIds.includes(req.user.id)) return res.status(404).json({ error: 'Canal não encontrado' });

  const msgs = db.messages
    .filter(m => m.scope === 'channel' && m.targetId === req.params.channelId)
    .slice(-200)
    .map(m => ({ ...m, author: publicUser(db.users.find(u => u.id === m.authorId)) }));
  res.json({ messages: msgs });
});

app.get('/api/dm/:userId/messages', requireAuth, (req, res) => {
  const db = readDB();
  const dmId = [req.user.id, req.params.userId].sort().join(':');
  const msgs = db.messages
    .filter(m => m.scope === 'dm' && m.targetId === dmId)
    .slice(-200)
    .map(m => ({ ...m, author: publicUser(db.users.find(u => u.id === m.authorId)) }));
  res.json({ messages: msgs });
});

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const db = readDB();
  const results = db.users
    .filter(u => u.id !== req.user.id && u.username.toLowerCase().includes(q))
    .slice(0, 10)
    .map(publicUser);
  res.json({ users: results });
});

// ---------- SOCKET.IO (tempo real + sinalização de voz) ----------

const onlineUsers = new Map(); // userId -> Set(socketId)

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return next(new Error('unauthorized'));
  socket.userId = payload.id;
  socket.username = payload.username;
  next();
});

io.on('connection', (socket) => {
  const db = readDB();
  const user = db.users.find(u => u.id === socket.userId);
  if (!user) return socket.disconnect();

  if (!onlineUsers.has(socket.userId)) onlineUsers.set(socket.userId, new Set());
  onlineUsers.get(socket.userId).add(socket.id);

  // Entra nas salas de todos os servidores dos quais faz parte
  const myServers = db.servers.filter(s => s.memberIds.includes(socket.userId));
  myServers.forEach(s => socket.join('server:' + s.id));
  socket.join('user:' + socket.userId);

  io.emit('presence:update', { userId: socket.userId, online: true });

  socket.on('channel:join', (channelId) => {
    socket.join('channel:' + channelId);
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave('channel:' + channelId);
  });

  socket.on('channel:message', async ({ channelId, content }) => {
    if (!content || !content.trim()) return;
    const dbNow = readDB();
    const srv = dbNow.servers.find(s => s.channels.some(c => c.id === channelId));
    if (!srv || !srv.memberIds.includes(socket.userId)) return;

    const msg = {
      id: uuid(),
      scope: 'channel',
      targetId: channelId,
      authorId: socket.userId,
      content: content.trim().slice(0, 4000),
      createdAt: Date.now(),
    };
    dbNow.messages.push(msg);
    await writeDB(dbNow);

    io.to('channel:' + channelId).emit('channel:message', { ...msg, author: publicUser(user) });
  });

  socket.on('dm:message', async ({ toUserId, content }) => {
    if (!content || !content.trim() || !toUserId) return;
    const dmId = [socket.userId, toUserId].sort().join(':');
    const msg = {
      id: uuid(),
      scope: 'dm',
      targetId: dmId,
      authorId: socket.userId,
      content: content.trim().slice(0, 4000),
      createdAt: Date.now(),
    };
    const dbNow = readDB();
    dbNow.messages.push(msg);
    await writeDB(dbNow);

    const payload = { ...msg, author: publicUser(user) };
    io.to('user:' + toUserId).emit('dm:message', payload);
    io.to('user:' + socket.userId).emit('dm:message', payload);
  });

  // ---- Voz (WebRTC signaling, malha simples P2P) ----
  socket.on('voice:join', (channelId) => {
    socket.join('voice:' + channelId);
    socket.voiceChannel = channelId;
    const room = io.sockets.adapter.rooms.get('voice:' + channelId) || new Set();
    const peers = [...room].filter(id => id !== socket.id).map(id => {
      const s = io.sockets.sockets.get(id);
      return { socketId: id, userId: s?.userId, username: s?.username };
    });
    socket.emit('voice:peers', peers);
    socket.to('voice:' + channelId).emit('voice:peer-joined', { socketId: socket.id, userId: socket.userId, username: socket.username });
  });

  socket.on('voice:leave', (channelId) => {
    socket.leave('voice:' + channelId);
    socket.to('voice:' + channelId).emit('voice:peer-left', { socketId: socket.id });
    socket.voiceChannel = null;
  });

  socket.on('voice:signal', ({ toSocketId, signal }) => {
    io.to(toSocketId).emit('voice:signal', { fromSocketId: socket.id, userId: socket.userId, signal });
  });

  socket.on('disconnect', () => {
    if (socket.voiceChannel) {
      socket.to('voice:' + socket.voiceChannel).emit('voice:peer-left', { socketId: socket.id });
    }
    const set = onlineUsers.get(socket.userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(socket.userId);
        io.emit('presence:update', { userId: socket.userId, online: false });
      }
    }
  });
});

app.get('/api/online', requireAuth, (req, res) => {
  res.json({ userIds: [...onlineUsers.keys()] });
});

server.listen(PORT, () => {
  console.log(`Concord rodando em http://localhost:${PORT}`);
});
