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
  dmContacts: [],          // usuários com quem já houve troca de DM (guardado localmente na sessão)
  voice: {
    channelId: null,
    localStream: null,
    peers: {}, // socketId -> RTCPeerConnection
  },
};

// Artifacts do Claude não podem usar localStorage; como este é um projeto standalone
// para deploy próprio do usuário (fora do Claude.ai), localStorage funciona normalmente aqui.
function localStorage_get(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function localStorage_set(key, val) {
  try { localStorage.setItem(key, val); } catch (e) {}
}
function localStorage_del(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

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

function colorFromString(str) {
  const colors = ['#7c5cff', '#3ddc97', '#ff8a5c', '#5b8def', '#ff5c8a', '#ffd15c'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
function initials(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}
function avatarEl(user, size = '') {
  const span = document.createElement('span');
  span.className = 'avatar' + (size ? ' ' + size : '');
  span.style.background = user?.color || colorFromString(user?.username || '?');
  span.textContent = initials(user?.username);
  return span;
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ---------------- AUTENTICAÇÃO ----------------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#loginUsername').value.trim(),
        password: $('#loginPassword').value,
      }),
    });
    onAuthSuccess(data);
  } catch (err) {
    showAuthError(err.message);
  }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#registerUsername').value.trim(),
        password: $('#registerPassword').value,
      }),
    });
    onAuthSuccess(data);
  } catch (err) {
    showAuthError(err.message);
  }
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

function showAuthError(msg) {
  $('#authError').textContent = msg;
  $('#authError').classList.remove('hidden');
}
function hideAuthError() {
  $('#authError').classList.add('hidden');
}

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
    return; // fica na tela de login
  }

  $('#authScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');

  $('#myUsername').textContent = state.user.username;
  $('#myAvatar').style.background = state.user.color;
  $('#myAvatar').textContent = initials(state.user.username);

  connectSocket();
  await loadServers();
  showDmView();
}

// tenta autologin se já houver token salvo
if (state.token) startApp();

// ---------------- SOCKET.IO ----------------
function connectSocket() {
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('connect_error', (err) => {
    console.error('Erro de conexão socket:', err.message);
  });

  state.socket.on('presence:update', ({ userId, online }) => {
    if (online) state.onlineUserIds.add(userId);
    else state.onlineUserIds.delete(userId);
    renderMembersPanel();
  });

  state.socket.on('channel:message', (msg) => {
    if (msg.targetId === state.currentChannelId) appendMessage(msg);
  });

  state.socket.on('dm:message', (msg) => {
    const dmId = [state.user.id, state.currentDmUserId].sort().join(':');
    if (state.currentDmUserId && msg.targetId === dmId) appendMessage(msg);
    upsertDmContact(msg.author.id === state.user.id ? null : msg.author);
  });

  // Sinalização de voz (WebRTC)
  state.socket.on('voice:peers', (peers) => {
    peers.forEach(p => createPeerConnection(p.socketId, true));
  });
  state.socket.on('voice:peer-joined', (p) => {
    createPeerConnection(p.socketId, false);
    addVoiceParticipantChip(p.socketId, p.username);
  });
  state.socket.on('voice:peer-left', ({ socketId }) => {
    closePeerConnection(socketId);
  });
  state.socket.on('voice:signal', async ({ fromSocketId, signal }) => {
    const pc = state.voice.peers[fromSocketId] || createPeerConnection(fromSocketId, false);
    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit('voice:signal', { toSocketId: fromSocketId, signal: pc.localDescription });
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(signal); } catch (e) { /* ignore */ }
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
  await api(`/api/servers/${state.currentServerId}/channels`, {
    method: 'POST',
    body: JSON.stringify({ name, type }),
  });
  $('#newChannelName').value = '';
  closeModal('#channelModal');
  await loadServers();
  const srv = state.servers.find(s => s.id === state.currentServerId);
  renderChannelLists(srv);
});

// ---------------- MODAL DE SERVIDOR (criar / entrar) ----------------
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
  } catch (err) {
    showModalError('#serverModalError', err.message);
  }
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
  } catch (err) {
    showModalError('#serverModalError', err.message);
  }
});

function showModalError(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---------------- CANAIS DE TEXTO ----------------
async function selectChannel(channel) {
  if (state.currentChannelId) state.socket.emit('channel:leave', state.currentChannelId);
  state.currentChannelId = channel.id;
  state.currentDmUserId = null;

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
      el.addEventListener('click', () => {
        closeModal('#dmModal');
        selectDm(u);
      });
      list.appendChild(el);
    });
  }, 250);
});

// ---------------- MENSAGENS (renderização) ----------------
function clearChatView(placeholder) {
  $('#chatHeaderIcon').textContent = '';
  $('#chatHeaderTitle').textContent = placeholder;
  $('#messageForm').classList.add('hidden');
  $('#messages').innerHTML = `<p class="message-empty">${escapeHtml(placeholder)}</p>`;
}

function renderMessages(msgs) {
  const box = $('#messages');
  box.innerHTML = '';
  if (msgs.length === 0) {
    box.innerHTML = '<p class="message-empty">Nenhuma mensagem ainda. Diga oi! 👋</p>';
    return;
  }
  msgs.forEach(m => appendMessage(m, false));
  box.scrollTop = box.scrollHeight;
}

function appendMessage(msg, scroll = true) {
  const box = $('#messages');
  if (box.querySelector('.message-empty')) box.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'message-row';
  row.appendChild(avatarEl(msg.author));

  const body = document.createElement('div');
  body.className = 'message-body';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('span');
  author.className = 'message-author';
  author.style.color = msg.author?.color || 'inherit';
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
  box.appendChild(row);

  if (scroll) box.scrollTop = box.scrollHeight;
}

$('#messageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#messageInput');
  const content = input.value;
  if (!content.trim()) return;
  input.value = '';

  if (state.currentChannelId) {
    state.socket.emit('channel:message', { channelId: state.currentChannelId, content });
  } else if (state.currentDmUserId) {
    state.socket.emit('dm:message', { toUserId: state.currentDmUserId, content });
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

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

async function joinVoiceChannel(channel) {
  if (state.voice.channelId === channel.id) return;
  if (state.voice.channelId) leaveVoiceChannel();

  try {
    state.voice.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('Não foi possível acessar o microfone: ' + e.message);
    return;
  }

  state.voice.channelId = channel.id;
  state.socket.emit('voice:join', channel.id);

  $('#voiceBar').classList.remove('hidden');
  $('#voiceBarLabel').textContent = 'Conectado à voz — ' + channel.name;
  $('#voiceParticipants').innerHTML = '';
  addVoiceParticipantChip('me', state.user.username + ' (você)');

  const srv = state.servers.find(s => s.id === state.currentServerId);
  if (srv) renderChannelLists(srv);
}

function leaveVoiceChannel() {
  if (!state.voice.channelId) return;
  state.socket.emit('voice:leave', state.voice.channelId);
  Object.keys(state.voice.peers).forEach(closePeerConnection);
  if (state.voice.localStream) {
    state.voice.localStream.getTracks().forEach(t => t.stop());
    state.voice.localStream = null;
  }
  state.voice.channelId = null;
  $('#voiceBar').classList.add('hidden');

  const srv = state.servers.find(s => s.id === state.currentServerId);
  if (srv) renderChannelLists(srv);
}

$('#leaveVoiceBtn').addEventListener('click', leaveVoiceChannel);

function createPeerConnection(socketId, isInitiator) {
  if (state.voice.peers[socketId]) return state.voice.peers[socketId];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.voice.peers[socketId] = pc;

  if (state.voice.localStream) {
    state.voice.localStream.getTracks().forEach(track => pc.addTrack(track, state.voice.localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.socket.emit('voice:signal', { toSocketId: socketId, signal: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    let audioEl = document.getElementById('audio-' + socketId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'audio-' + socketId;
      audioEl.autoplay = true;
      $('#remoteAudioContainer').appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('voice:signal', { toSocketId: socketId, signal: pc.localDescription });
    };
  }

  return pc;
}

function closePeerConnection(socketId) {
  const pc = state.voice.peers[socketId];
  if (pc) {
    pc.close();
    delete state.voice.peers[socketId];
  }
  const audioEl = document.getElementById('audio-' + socketId);
  if (audioEl) audioEl.remove();
  const chip = document.getElementById('voicechip-' + socketId);
  if (chip) chip.remove();
}

function addVoiceParticipantChip(socketId, username) {
  if (document.getElementById('voicechip-' + socketId)) return;
  const chip = document.createElement('span');
  chip.id = 'voicechip-' + socketId;
  chip.className = 'avatar avatar-sm';
  chip.title = username;
  chip.style.background = colorFromString(username);
  chip.textContent = initials(username);
  $('#voiceParticipants').appendChild(chip);
}

// ---------------- MODAL HELPERS ----------------
function openModal(sel) {
  $(sel).classList.remove('hidden');
  const err = $(sel).querySelector('.auth-error');
  if (err) err.classList.add('hidden');
}
function closeModal(sel) {
  $(sel).classList.add('hidden');
}
$('#closeServerModal').addEventListener('click', () => closeModal('#serverModal'));
$('#closeChannelModal').addEventListener('click', () => closeModal('#channelModal'));
$('#closeDmModal').addEventListener('click', () => closeModal('#dmModal'));
$('#closeInviteModal').addEventListener('click', () => closeModal('#inviteModal'));
