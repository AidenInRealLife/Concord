// Banco de dados simples baseado em arquivo JSON.
// Suficiente para um grupo pequeno de amigos (até dezenas de usuários).
// Se um dia precisar escalar muito, trocar por Postgres/Mongo é o próximo passo.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    const initial = {
      users: [],       // { id, username, passwordHash, color, createdAt }
      servers: [],      // { id, name, ownerId, inviteCode, memberIds: [], channels: [{id,name,type}] }
      messages: [],      // { id, scope: 'channel'|'dm', targetId, authorId, content, createdAt }
    };
    fs.writeFileSync(FILE, JSON.stringify(initial, null, 2));
  }
}

function readDB() {
  ensureFile();
  const raw = fs.readFileSync(FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('db.json corrompido: ' + e.message);
  }
}

let writeQueue = Promise.resolve();
function writeDB(data) {
  // Serializa escritas para evitar corrida entre requisições concorrentes.
  writeQueue = writeQueue.then(() => {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  });
  return writeQueue;
}

module.exports = { readDB, writeDB };
