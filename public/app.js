// ---------------- ESTADO GLOBAL ----------------
const state = {
  token: localStorage_get('token'),
  user: null,
  socket: null,
  servers: [],
  currentServerId: null,   // null = modo DM
  currentChannelId: null,
  currentDmUserId: null,
  onlineUserIds: new Set(),
  dmContacts: [],
  messagesById: new Map(), // id -> {id, author, content} — usado para montar a prévia de "responder"
  replyingTo: null,        // { id, authorUsername, content }
  voice: {
    channelId: null,
    localStream: null,
    screenStream: null,
    peers: {},              // socketId -> RTCPeerConnection
    participants: new Map(), // socketId -> { userId, username, color, avatarUrl, muted }
    analysers: new Map(),    // analyser keys -> { analyser, dataArray }
    micDetected: new Set(),  // socketIds cujo track de microfone já foi identificado
    speakingCheckInterval: null,
    screenShareSocketId: null,
    muted: false,
  },
};

// Este projeto é feito para deploy próprio (fora do Claude.ai), então localStorage funciona normalmente.
function localStorage_get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function localStorage_set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
function localStorage_del(key) { try { localStorage.removeItem(key); } catch (e) {} }

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------- HELPERS DE API ----------------
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

function grayFromString(str) {
  const shades = ['#3a3a3a', '#454545', '#525252', '#5e5e5e', '#6b6b6b', '#777777'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return shades[Math.abs(hash) % shades.length];
}
function initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }

function avatarEl(user, size = '') {
  const span = document.createElement('span');
  span.className = 'avatar' + (size ? ' ' + size : '');
  if (user?.avatarUrl) {
    const img = document.createElement('img');
    img.src = user.avatarUrl;
    img.alt = user.username || '';
    span.appendChild(img);
  } else {
    span.style.background = user?.color || grayFromString(user?.username || '?');
    span.textContent = initials(user?.username);
  }
  return span;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function escapeAttr(str) { return (str || '').replace(/"/g, '&quot;'); }

// ---------------- EFEITOS SONOROS (sintetizados, sem depender de arquivos externos) ----------------
let sfxCtx = null;
function playTone(freqs, duration = 0.12, gain = 0.06) {
  try {
    sfxCtx = sfxCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = sfxCtx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = sfxCtx.createOscillator();
      const g = sfxCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.value = gain;
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + duration);
      osc.connect(g).connect(sfxCtx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + duration + 0.02);
    });
  } catch (e) { /* áudio indisponível, ignora silenciosamente */ }
}
function sfxJoinCall() { playTone([440, 660], 0.1, 0.05); }
function sfxLeaveCall() { playTone([440, 300], 0.1, 0.05); }
function sfxMessage() { playTone([700], 0.08, 0.04); }

// ---------------- PLANO DE FUNDO ----------------
function applyBackgroundPreset(preset) {
  document.body.dataset.bg = preset || 'none';
}
function initBackgroundPreset() {
  applyBackgroundPreset(localStorage_get('bgPreset') || 'none');
}
$('#backgroundBtn').addEventListener('click', () => openModal('#backgroundModal'));
$('#closeBackgroundModal').addEventListener('click', () => closeModal('#backgroundModal'));
$$('.bg-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.bg;
    applyBackgroundPreset(preset);
    localStorage_set('bgPreset', preset);
    closeModal('#backgroundModal');
  });
});
initBackgroundPreset();

// ---------------- AUTENTICAÇÃO ----------------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }),
    });
    onAuthSuccess(data);
  } catch (err) { showAuthError(err.message); }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: $('#registerUsername').value.trim(), password: $('#registerPassword').value }),
    });
    onAuthSuccess(data);
  } catch (err) { showAuthError(err.message); }
});

$$('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    $('#loginForm').classList.toggle('hidden', !isLogin);
    $('#registerForm').classList.toggle('hidden', isLogin);
    hideAuthError();
  });
});

function showAuthError(msg) { $('#authError').textContent = msg; $('#authError').classList.remove('hidden'); }
function hideAuthError() { $('#authError').classList.add('hidden'); }

function onAuthSuccess(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage_set('token', data.token);
  startApp();
}

$('#logoutBtn').addEventListener('click', () => {
  localStorage_del('token');
  window.location.reload();
});

// ---------------- INICIALIZAÇÃO DO APP ----------------
async function startApp() {
  try {
    if (!state.user) {
      const me = await api('/api/me');
      state.user = me.user;
    }
  } catch (e) {
    localStorage_del('token');
    return;
  }

  $('#authScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderMyAvatar();
  $('#myUsername').textContent = state.user.username;

  connectSocket();
  await loadServers();
  showDmView();
}

if (state.token) startApp();

function renderMyAvatar() {
  const holder = $('#myAvatar');
  holder.innerHTML = '';
  const el = avatarEl(state.user);
  holder.replaceWith(el);
  el.id = 'myAvatar';
}

// ---------------- FOTO DE PERFIL ----------------
$('#myAvatarBtn').addEventListener('click', () => $('#avatarFileInput').click());

$('#avatarFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImageToDataUrl(file, 256);
    const data = await api('/api/me/avatar', { method: 'POST', body: JSON.stringify({ image: dataUrl }) });
    state.user.avatarUrl = data.avatarUrl;
    renderMyAvatar();
    if (state.currentServerId) await renderMembersPanel();
  } catch (err) {
    alert('Não foi possível atualizar a foto: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

function resizeImageToDataUrl(file, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      canvas.width = maxSize;
      canvas.height = maxSize;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------- SOCKET.IO ----------------
function connectSocket() {
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('connect_error', (err) => console.error('Erro de conexão socket:', err.message));

  state.socket.on('presence:update', ({ userId, online }) => {
    if (online) state.onlineUserIds.add(userId);
    else state.onlineUserIds.delete(userId);
    renderMembersPanel();
  });

  state.socket.on('channel:message', (msg) => {
    if (msg.targetId === state.currentChannelId) appendMessage(msg, true);
    if (msg.author?.id !== state.user.id) sfxMessage();
  });

  state.socket.on('dm:message', (msg) => {
    const dmId = [state.user.id, state.currentDmUserId].sort().join(':');
    if (state.currentDmUserId && msg.targetId === dmId) appendMessage(msg, true);
    upsertDmContact(msg.author.id === state.user.id ? null : msg.author);
    if (msg.author?.id !== state.user.id) sfxMessage();
  });

  // ---- Sinalização de voz (WebRTC, com negociação "perfeita" p/ suportar renegociação da tela) ----
  state.socket.on('voice:peers', (peers) => {
    peers.forEach(p => {
      state.voice.participants.set(p.socketId, { userId: p.userId, username: p.username, color: p.color, avatarUrl: p.avatarUrl });
      createPeerConnection(p.socketId, true);
    });
    renderVoiceGrid();
  });

  state.socket.on('voice:peer-joined', (p) => {
    state.voice.participants.set(p.socketId, { userId: p.userId, username: p.username, color: p.color, avatarUrl: p.avatarUrl });
    createPeerConnection(p.socketId, false);
    renderVoiceGrid();
  });

  state.socket.on('voice:peer-left', ({ socketId }) => {
    closePeerConnection(socketId);
    state.voice.participants.delete(socketId);
    state.voice.micDetected.delete(socketId);
    if (state.voice.screenShareSocketId === socketId) hideScreenShareStage();
    renderVoiceGrid();
  });

  state.socket.on('voice:peer-mute', ({ socketId, muted }) => {
    const p = state.voice.participants.get(socketId);
    if (p) { p.muted = muted; renderVoiceGrid(); }
  });

  state.socket.on('voice:signal', async ({ fromSocketId, signal }) => {
    const pc = state.voice.peers[fromSocketId] || createPeerConnection(fromSocketId, false);
    try {
      if (signal.candidate) {
        try { await pc.addIceCandidate(signal.candidate); } catch (e) { if (!pc.ignoreOffer) console.error(e); }
        return;
      }
      const offerCollision = signal.type === 'offer' && (pc.makingOffer || pc.signalingState !== 'stable');
      pc.ignoreOffer = !pc.polite && offerCollision;
      if (pc.ignoreOffer) return;

      if (offerCollision) {
        await Promise.all([pc.setLocalDescription({ type: 'rollback' }), pc.setRemoteDescription(signal)]);
      } else {
        await pc.setRemoteDescription(signal);
      }

      if (signal.type === 'offer') {
        await pc.setLocalDescription();
        state.socket.emit('voice:signal', { toSocketId: fromSocketId, signal: pc.localDescription });
      }
    } catch (err) {
      console.error('Erro de sinalização de voz:', err);
    }
  });
}

// ---------------- SERVIDORES ----------------
async function loadServers() {
  const data = await api('/api/servers');
  state.servers = data.servers;
  renderServerRail();
}

function renderServerRail() {
  const list = $('#serverList');
  list.innerHTML = '';
  state.servers.forEach(srv => {
    const btn = document.createElement('button');
    btn.className = 'server-icon' + (srv.id === state.currentServerId ? ' active' : '');
    btn.textContent = initials(srv.name);
    btn.title = srv.name;
    btn.addEventListener('click', () => selectServer(srv.id));
    list.appendChild(btn);
  });
  $('#dmRailBtn').classList.toggle('active', !state.currentServerId);
}

$('#dmRailBtn').addEventListener('click', showDmView);
$('#addServerBtn').addEventListener('click', () => openModal('#serverModal'));

function showDmView() {
  state.currentServerId = null;
  state.currentChannelId = null;
  renderServerRail();
  $('#sideTitle').textContent = 'Mensagens diretas';
  $('#dmPanel').classList.remove('hidden');
  $('#channelPanel').classList.add('hidden');
  $('#membersPanel').classList.add('hidden');
  renderDmList();
  clearChatView('Selecione uma conversa à esquerda, ou inicie uma nova.');
}

async function selectServer(serverId) {
  state.currentServerId = serverId;
  const srv = state.servers.find(s => s.id === serverId);
  renderServerRail();
  $('#sideTitle').textContent = srv.name;
  $('#dmPanel').classList.add('hidden');
  $('#channelPanel').classList.remove('hidden');
  $('#membersPanel').classList.remove('hidden');
  renderChannelLists(srv);
  await renderMembersPanel();

  const firstText = srv.channels.find(c => c.type === 'text');
  if (firstText) selectChannel(firstText);
  else clearChatView('Este servidor ainda não tem canais de texto.');
}

function renderChannelLists(srv) {
  const textList = $('#textChannelList');
  const voiceList = $('#voiceChannelList');
  textList.innerHTML = '';
  voiceList.innerHTML = '';

  srv.channels.filter(c => c.type === 'text').forEach(ch => {
    const el = document.createElement('div');
    el.className = 'channel-item' + (ch.id === state.currentChannelId ? ' active' : '');
    el.innerHTML = `<span class="channel-hash">#</span><span>${escapeHtml(ch.name)}</span>`;
    el.addEventListener('click', () => selectChannel(ch));
    textList.appendChild(el);
  });

  srv.channels.filter(c => c.type === 'voice').forEach(ch => {
    const el = document.createElement('div');
    el.className = 'channel-item' + (state.voice.channelId === ch.id ? ' active' : '');
    el.innerHTML = `<span class="channel-hash">🔊</span><span>${escapeHtml(ch.name)}</span>`;
    el.addEventListener('click', () => joinVoiceChannel(ch));
    voiceList.appendChild(el);
  });
}

$('#addChannelBtn').addEventListener('click', () => openModal('#channelModal'));

$('#createChannelBtn').addEventListener('click', async () => {
  const name = $('#newChannelName').value.trim();
  const type = document.querySelector('input[name="chType"]:checked').value;
  if (!name || !state.currentServerId) return;
  await api(`/api/servers/${state.currentServerId}/channels`, { method: 'POST', body: JSON.stringify({ name, type }) });
  $('#newChannelName').value = '';
  closeModal('#channelModal');
  await loadServers();
  const srv = state.servers.find(s => s.id === state.currentServerId);
  renderChannelLists(srv);
});

// ---------------- MODAL DE SERVIDOR ----------------
$$('.modal-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.modal-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('#createServerTab').classList.toggle('hidden', tab.dataset.mtab !== 'create');
    $('#joinServerTab').classList.toggle('hidden', tab.dataset.mtab !== 'join');
  });
});

$('#createServerBtn').addEventListener('click', async () => {
  const name = $('#newServerName').value.trim();
  if (!name) return;
  try {
    const data = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name }) });
    $('#newServerName').value = '';
    closeModal('#serverModal');
    await loadServers();
    selectServer(data.server.id);
    $('#inviteCodeDisplay').textContent = data.server.inviteCode;
    openModal('#inviteModal');
  } catch (err) { showModalError('#serverModalError', err.message); }
});

$('#joinServerBtn').addEventListener('click', async () => {
  const code = $('#joinServerCode').value.trim();
  if (!code) return;
  try {
    const data = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: code }) });
    $('#joinServerCode').value = '';
    closeModal('#serverModal');
    await loadServers();
    selectServer(data.server.id);
  } catch (err) { showModalError('#serverModalError', err.message); }
});

function showModalError(sel, msg) { const el = $(sel); el.textContent = msg; el.classList.remove('hidden'); }

// ---------------- CANAIS DE TEXTO ----------------
async function selectChannel(channel) {
  if (state.currentChannelId) state.socket.emit('channel:leave', state.currentChannelId);
  state.currentChannelId = channel.id;
  state.currentDmUserId = null;
  clearReply();

  const srv = state.servers.find(s => s.id === state.currentServerId);
  renderChannelLists(srv);

  $('#chatHeaderIcon').textContent = '#';
  $('#chatHeaderTitle').textContent = channel.name;
  $('#messageForm').classList.remove('hidden');

  state.socket.emit('channel:join', channel.id);
  const data = await api(`/api/channels/${channel.id}/messages`);
  renderMessages(data.messages);
}

// ---------------- DMs ----------------
function renderDmList() {
  const list = $('#dmList');
  list.innerHTML = '';
  if (state.dmContacts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'message-empty';
    empty.style.margin = '12px 8px';
    empty.style.fontSize = '12px';
    empty.textContent = 'Nenhuma conversa ainda. Clique em + para começar.';
    list.appendChild(empty);
    return;
  }
  state.dmContacts.forEach(u => {
    const el = document.createElement('div');
    el.className = 'dm-item' + (u.id === state.currentDmUserId ? ' active' : '');
    el.appendChild(avatarEl(u, 'avatar-sm'));
    const span = document.createElement('span');
    span.textContent = u.username;
    el.appendChild(span);
    el.addEventListener('click', () => selectDm(u));
    list.appendChild(el);
  });
}

function upsertDmContact(user) {
  if (!user) return;
  if (!state.dmContacts.some(u => u.id === user.id)) {
    state.dmContacts.push(user);
    renderDmList();
  }
}

async function selectDm(user) {
  if (state.currentChannelId) {
    state.socket.emit('channel:leave', state.currentChannelId);
    state.currentChannelId = null;
  }
  state.currentDmUserId = user.id;
  clearReply();
  upsertDmContact(user);
  renderDmList();

  $('#chatHeaderIcon').textContent = '@';
  $('#chatHeaderTitle').textContent = user.username;
  $('#messageForm').classList.remove('hidden');

  const data = await api(`/api/dm/${user.id}/messages`);
  renderMessages(data.messages);
}

$('#newDmBtn').addEventListener('click', () => {
  $('#dmSearchInput').value = '';
  $('#dmSearchResults').innerHTML = '';
  openModal('#dmModal');
  $('#dmSearchInput').focus();
});

let dmSearchTimeout;
$('#dmSearchInput').addEventListener('input', () => {
  clearTimeout(dmSearchTimeout);
  const q = $('#dmSearchInput').value.trim();
  dmSearchTimeout = setTimeout(async () => {
    if (!q) { $('#dmSearchResults').innerHTML = ''; return; }
    const data = await api('/api/users/search?q=' + encodeURIComponent(q));
    const list = $('#dmSearchResults');
    list.innerHTML = '';
    data.users.forEach(u => {
      const el = document.createElement('div');
      el.className = 'dm-item';
      el.appendChild(avatarEl(u, 'avatar-sm'));
      const span = document.createElement('span');
      span.textContent = u.username;
      el.appendChild(span);
      el.addEventListener('click', () => { closeModal('#dmModal'); selectDm(u); });
      list.appendChild(el);
    });
  }, 250);
});

// ---------------- MENSAGENS ----------------
function clearChatView(placeholder) {
  $('#chatHeaderIcon').textContent = '';
  $('#chatHeaderTitle').textContent = placeholder;
  $('#messageForm').classList.add('hidden');
  $('#messages').innerHTML = `<p class="message-empty">${escapeHtml(placeholder)}</p>`;
  clearReply();
}

function renderMessages(msgs) {
  const box = $('#messages');
  box.innerHTML = '';
  state.messagesById.clear();
  if (msgs.length === 0) {
    box.innerHTML = '<p class="message-empty">Nenhuma mensagem ainda. Diga oi! 👋</p>';
    return;
  }
  msgs.forEach(m => appendMessage(m, false));
  box.scrollTop = box.scrollHeight;
}

function appendMessage(msg, animate) {
  const box = $('#messages');
  if (box.querySelector('.message-empty')) box.innerHTML = '';

  state.messagesById.set(msg.id, { id: msg.id, authorUsername: msg.author?.username, content: msg.content });

  const row = document.createElement('div');
  row.className = 'message-row' + (animate ? ' msg-animate' : '');
  row.dataset.messageId = msg.id;
  row.appendChild(avatarEl(msg.author));

  const body = document.createElement('div');
  body.className = 'message-body';

  if (msg.replyPreview) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    quote.innerHTML = `↩ <b>${escapeHtml(msg.replyPreview.authorUsername)}</b> ${escapeHtml(msg.replyPreview.content)}`;
    body.appendChild(quote);
  }

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = msg.author?.username || 'desconhecido';
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(msg.createdAt);
  meta.appendChild(author);
  meta.appendChild(time);

  const text = document.createElement('div');
  text.className = 'message-text';
  text.textContent = msg.content;

  body.appendChild(meta);
  body.appendChild(text);
  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const replyBtn = document.createElement('button');
  replyBtn.textContent = '↩ Responder';
  replyBtn.addEventListener('click', () => startReply(msg.id));
  actions.appendChild(replyBtn);
  row.appendChild(actions);

  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

$('#messageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#messageInput');
  const content = input.value;
  if (!content.trim()) return;
  input.value = '';
  const replyTo = state.replyingTo ? state.replyingTo.id : null;

  if (state.currentChannelId) {
    state.socket.emit('channel:message', { channelId: state.currentChannelId, content, replyTo });
  } else if (state.currentDmUserId) {
    state.socket.emit('dm:message', { toUserId: state.currentDmUserId, content, replyTo });
  }
  clearReply();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------- RESPONDER MENSAGEM ----------------
function startReply(messageId) {
  const msg = state.messagesById.get(messageId);
  if (!msg) return;
  state.replyingTo = msg;
  $('#replyPreviewAuthor').textContent = msg.authorUsername || 'alguém';
  $('#replyPreviewText').textContent = msg.content;
  $('#replyPreviewBar').classList.remove('hidden');
  $('#messageInput').focus();
}
function clearReply() {
  state.replyingTo = null;
  $('#replyPreviewBar').classList.add('hidden');
}
$('#cancelReplyBtn').addEventListener('click', clearReply);

// ---------------- MEMBROS ----------------
async function renderMembersPanel() {
  if (!state.currentServerId) return;
  const data = await api(`/api/servers/${state.currentServerId}/members`);
  const list = $('#membersList');
  list.innerHTML = '';
  data.members
    .sort((a, b) => Number(state.onlineUserIds.has(b.id)) - Number(state.onlineUserIds.has(a.id)))
    .forEach(u => {
      const el = document.createElement('div');
      el.className = 'member-item';
      const dot = document.createElement('span');
      dot.className = 'status-dot' + (state.onlineUserIds.has(u.id) ? ' online' : '');
      el.appendChild(dot);
      el.appendChild(avatarEl(u, 'avatar-sm'));
      const span = document.createElement('span');
      span.textContent = u.username;
      el.appendChild(span);
      list.appendChild(el);
    });
}

// ---------------- VOZ (WebRTC) ----------------
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
// Sem "max": exigir um teto rígido faz alguns navegadores rejeitarem a captura
// inteira e caírem num padrão baixo. Com "ideal", o navegador busca chegar
// o mais perto possível — o resultado real ainda depende do monitor, da
// placa de vídeo e da própria capacidade de captura do sistema operacional.
const SCREEN_QUALITY_PRESETS = {
  high: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
  medium: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  low: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
};

function currentMicConstraints(deviceId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: $('#noiseSuppressionToggle').checked,
    autoGainControl: true,
  };
}

async function joinVoiceChannel(channel) {
  if (state.voice.channelId === channel.id) return;
  if (state.voice.channelId) leaveVoiceChannel();

  try {
    state.voice.localStream = await navigator.mediaDevices.getUserMedia({ audio: currentMicConstraints($('#micSelect').value) });
  } catch (e) {
    alert('Não foi possível acessar o microfone: ' + e.message);
    return;
  }

  state.voice.channelId = channel.id;
  state.voice.muted = false;
  updateMuteButton();
  state.socket.emit('voice:join', channel.id);
  setupSpeakingDetection('me', state.voice.localStream);
  sfxJoinCall();

  $('#voicePanel').classList.remove('hidden');
  $('#voiceBarLabel').textContent = 'Conectado à voz — ' + channel.name;
  renderVoiceGrid();
  refreshMicList();

  const srv = state.servers.find(s => s.id === state.currentServerId);
  if (srv) renderChannelLists(srv);
}

function leaveVoiceChannel() {
  if (!state.voice.channelId) return;
  if (state.voice.screenStream) stopScreenShare();

  state.socket.emit('voice:leave', state.voice.channelId);
  Object.keys(state.voice.peers).forEach(closePeerConnection);
  if (state.voice.localStream) {
    state.voice.localStream.getTracks().forEach(t => t.stop());
    state.voice.localStream = null;
  }
  stopSpeakingDetection('me');
  state.voice.participants.clear();
  state.voice.micDetected.clear();
  state.voice.channelId = null;
  sfxLeaveCall();
  $('#voicePanel').classList.add('hidden');
  $('#voiceGrid').innerHTML = '';

  const srv = state.servers.find(s => s.id === state.currentServerId);
  if (srv) renderChannelLists(srv);
}
$('#leaveVoiceBtn').addEventListener('click', leaveVoiceChannel);

// ---- Mutar / desmutar ----
function updateMuteButton() {
  const btn = $('#muteBtn');
  btn.textContent = state.voice.muted ? '🔇 Desmutar' : '🎙 Mutar';
  btn.classList.toggle('btn-muted', state.voice.muted);
}
$('#muteBtn').addEventListener('click', () => {
  if (!state.voice.localStream) return;
  state.voice.muted = !state.voice.muted;
  state.voice.localStream.getAudioTracks().forEach(t => { t.enabled = !state.voice.muted; });
  updateMuteButton();
  state.socket.emit('voice:mute', { muted: state.voice.muted });
  renderVoiceGrid();
});

// ---- Escolha de microfone (ex: Voicemeeter, fones USB, etc.) ----
async function refreshMicList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const select = $('#micSelect');
    const currentValue = select.value;
    select.innerHTML = '';
    mics.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microfone ${i + 1}`;
      select.appendChild(opt);
    });
    if (mics.some(d => d.deviceId === currentValue)) select.value = currentValue;
  } catch (e) {
    console.warn('Não foi possível listar microfones:', e.message);
  }
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (state.voice.channelId) refreshMicList(); });

$('#micSelect').addEventListener('change', async (e) => {
  if (!state.voice.localStream) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: currentMicConstraints(e.target.value) });
    const newTrack = newStream.getAudioTracks()[0];
    const oldTrack = state.voice.localStream.getAudioTracks()[0];
    newTrack.enabled = !state.voice.muted;

    Object.values(state.voice.peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track === oldTrack);
      if (sender) sender.replaceTrack(newTrack);
    });

    state.voice.localStream.removeTrack(oldTrack);
    oldTrack.stop();
    state.voice.localStream.addTrack(newTrack);
    setupSpeakingDetection('me', state.voice.localStream);
  } catch (err) {
    alert('Não foi possível trocar de microfone: ' + err.message);
  }
});

function createPeerConnection(socketId, isInitiator) {
  if (state.voice.peers[socketId]) return state.voice.peers[socketId];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.polite = !isInitiator;
  pc.makingOffer = false;
  state.voice.peers[socketId] = pc;

  if (state.voice.localStream) {
    state.voice.localStream.getTracks().forEach(track => pc.addTrack(track, state.voice.localStream));
  }
  if (state.voice.screenStream) {
    state.voice.screenStream.getTracks().forEach(track => pc.addTrack(track, state.voice.screenStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) state.socket.emit('voice:signal', { toSocketId: socketId, signal: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      showRemoteScreenShare(socketId, e.streams[0]);
      e.track.addEventListener('ended', () => {
        if (state.voice.screenShareSocketId === socketId) hideScreenShareStage();
      });
    } else {
      // A primeira faixa de áudio de cada participante é o microfone; faixas de
      // áudio que chegarem depois (quando alguém compartilha som da tela) usam
      // uma chave própria, só pra tocar — sem contar como "está falando".
      const isMic = !state.voice.micDetected.has(socketId);
      const audioKey = isMic ? socketId : socketId + '-' + e.track.id;
      attachRemoteAudio(audioKey, e.streams[0]);
      if (isMic) {
        state.voice.micDetected.add(socketId);
        setupSpeakingDetection(socketId, e.streams[0]);
      }
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      pc.makingOffer = true;
      await pc.setLocalDescription();
      state.socket.emit('voice:signal', { toSocketId: socketId, signal: pc.localDescription });
    } catch (err) {
      console.error('Erro ao negociar conexão de voz:', err);
    } finally {
      pc.makingOffer = false;
    }
  };

  return pc;
}

function closePeerConnection(socketId) {
  const pc = state.voice.peers[socketId];
  if (pc) { pc.close(); delete state.voice.peers[socketId]; }
  $$(`audio[id^="audio-${CSS.escape(socketId)}"]`).forEach(el => el.remove());
  stopSpeakingDetection(socketId);
}

function attachRemoteAudio(key, stream) {
  let audioEl = document.getElementById('audio-' + key);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = 'audio-' + key;
    audioEl.autoplay = true;
    $('#remoteAudioContainer').appendChild(audioEl);
  }
  audioEl.srcObject = stream;
}

// ---------------- INTERFACE DA CHAMADA (grid de participantes) ----------------
function renderVoiceGrid() {
  const grid = $('#voiceGrid');
  grid.innerHTML = '';

  const meTile = buildVoiceTile('me', { username: state.user.username + ' (você)', color: state.user.color, avatarUrl: state.user.avatarUrl, muted: state.voice.muted });
  grid.appendChild(meTile);

  state.voice.participants.forEach((p, socketId) => {
    grid.appendChild(buildVoiceTile(socketId, p));
  });
}

function buildVoiceTile(socketId, p) {
  const tile = document.createElement('div');
  tile.className = 'voice-tile';
  tile.id = 'voicetile-' + socketId;
  tile.appendChild(avatarEl(p, 'avatar-lg'));
  const name = document.createElement('span');
  name.className = 'voice-tile-name';
  name.textContent = p.username || 'Participante';
  tile.appendChild(name);
  if (p.muted) {
    const badge = document.createElement('span');
    badge.className = 'voice-tile-badge';
    badge.textContent = '🔇 mudo';
    tile.appendChild(badge);
  }
  if (state.voice.screenShareSocketId === socketId) {
    const badge = document.createElement('span');
    badge.className = 'voice-tile-badge';
    badge.textContent = '🖥 compartilhando';
    tile.appendChild(badge);
  }
  return tile;
}

// ---- Detecção de quem está falando (Web Audio API) ----
function setupSpeakingDetection(key, stream) {
  try {
    const audioCtx = setupSpeakingDetection._ctx || (setupSpeakingDetection._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    state.voice.analysers.set(key, { analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) });
    ensureSpeakingLoop();
  } catch (e) {
    console.warn('Detecção de fala indisponível:', e.message);
  }
}
function stopSpeakingDetection(key) {
  state.voice.analysers.delete(key);
}
function ensureSpeakingLoop() {
  if (state.voice.speakingCheckInterval) return;
  state.voice.speakingCheckInterval = setInterval(() => {
    state.voice.analysers.forEach((entry, key) => {
      entry.analyser.getByteFrequencyData(entry.dataArray);
      const avg = entry.dataArray.reduce((a, b) => a + b, 0) / entry.dataArray.length;
      const tile = document.getElementById('voicetile-' + key);
      const isMuted = key === 'me' ? state.voice.muted : state.voice.participants.get(key)?.muted;
      if (tile) tile.classList.toggle('speaking', avg > 14 && !isMuted);
    });
    if (state.voice.analysers.size === 0 && !state.voice.channelId) {
      clearInterval(state.voice.speakingCheckInterval);
      state.voice.speakingCheckInterval = null;
    }
  }, 200);
}

// ---------------- COMPARTILHAMENTO DE TELA ----------------
$('#shareScreenBtn').addEventListener('click', async () => {
  if (!state.voice.channelId) { alert('Entre em um canal de voz primeiro.'); return; }
  const quality = $('#screenShareQuality').value;
  const videoConstraints = SCREEN_QUALITY_PRESETS[quality] || SCREEN_QUALITY_PRESETS.medium;
  const includeAudio = $('#shareAudioToggle').checked;

  try {
    state.voice.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      // systemAudio:'include' é um hint do Chrome/Edge para priorizar áudio do
      // sistema na caixa de seleção; navegadores que não suportam ignoram o campo.
      audio: includeAudio ? { systemAudio: 'include' } : false,
    });
  } catch (e) {
    return; // usuário cancelou a seleção de tela
  }

  const videoTrack = state.voice.screenStream.getVideoTracks()[0];
  videoTrack.contentHint = 'motion'; // prioriza fluidez de movimento sobre nitidez estática

  state.voice.screenStream.getTracks().forEach(track => {
    Object.values(state.voice.peers).forEach(pc => pc.addTrack(track, state.voice.screenStream));
  });

  if (includeAudio && state.voice.screenStream.getAudioTracks().length === 0) {
    console.warn('O navegador não conseguiu capturar áudio do sistema nessa sessão de compartilhamento.');
  }

  showLocalScreenShare(state.voice.screenStream);
  $('#shareScreenBtn').classList.add('hidden');
  $('#stopShareScreenBtn').classList.remove('hidden');

  videoTrack.addEventListener('ended', stopScreenShare);
});

$('#stopShareScreenBtn').addEventListener('click', stopScreenShare);

function stopScreenShare() {
  if (!state.voice.screenStream) return;
  const tracks = state.voice.screenStream.getTracks();

  Object.values(state.voice.peers).forEach(pc => {
    tracks.forEach(track => {
      const sender = pc.getSenders().find(s => s.track === track);
      if (sender) pc.removeTrack(sender);
    });
  });

  tracks.forEach(t => t.stop());
  state.voice.screenStream = null;

  if (state.voice.screenShareSocketId === 'me') hideScreenShareStage();
  $('#shareScreenBtn').classList.remove('hidden');
  $('#stopShareScreenBtn').classList.add('hidden');
  renderVoiceGrid();
}

function showLocalScreenShare(stream) {
  state.voice.screenShareSocketId = 'me';
  $('#screenShareVideo').srcObject = stream;
  $('#screenShareLabel').textContent = 'Você está compartilhando a tela';
  $('#screenShareStage').classList.remove('hidden');
  renderVoiceGrid();
}

function showRemoteScreenShare(socketId, stream) {
  state.voice.screenShareSocketId = socketId;
  $('#screenShareVideo').srcObject = stream;
  const p = state.voice.participants.get(socketId);
  $('#screenShareLabel').textContent = (p?.username || 'Alguém') + ' está compartilhando a tela';
  $('#screenShareStage').classList.remove('hidden');
  renderVoiceGrid();
}

function hideScreenShareStage() {
  state.voice.screenShareSocketId = null;
  $('#screenShareVideo').srcObject = null;
  $('#screenShareStage').classList.add('hidden');
  renderVoiceGrid();
}

// ---------------- SUPRESSÃO DE RUÍDO (toggle ao vivo, quando suportado) ----------------
$('#noiseSuppressionToggle').addEventListener('change', async (e) => {
  if (!state.voice.localStream) return;
  const track = state.voice.localStream.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ noiseSuppression: e.target.checked });
  } catch (err) {
    console.warn('Este navegador não permite alternar a supressão de ruído durante a chamada. Reentre na call para aplicar.');
  }
});


// ---------------- MODAL HELPERS ----------------
function openModal(sel) {
  $(sel).classList.remove('hidden');
  const err = $(sel).querySelector('.auth-error');
  if (err) err.classList.add('hidden');
}
function closeModal(sel) { $(sel).classList.add('hidden'); }
$('#closeServerModal').addEventListener('click', () => closeModal('#serverModal'));
$('#closeChannelModal').addEventListener('click', () => closeModal('#channelModal'));
$('#closeDmModal').addEventListener('click', () => closeModal('#dmModal'));
$('#closeInviteModal').addEventListener('click', () => closeModal('#inviteModal'));
