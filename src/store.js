import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

const dbPath = path.join(dir, 'db.json');

function empty() {
  return { notes: [], clients: {}, codes: {}, tokens: {}, pending: {}, files: {} };
}

let db = empty();
let chain = Promise.resolve();

export function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function randomId(prefix = '') {
  return prefix + randomBytes(16).toString('base64url');
}

export function secretMatches(presented, storedHash) {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(tokenHash(presented));
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function prune(state, now = Date.now()) {
  for (const [key, row] of Object.entries(state.codes)) {
    if (row.expiresAt <= now) delete state.codes[key];
  }
  for (const [key, row] of Object.entries(state.pending)) {
    if (row.expiresAt <= now) delete state.pending[key];
  }
  for (const [key, row] of Object.entries(state.tokens)) {
    if (row.expiresAt <= now) delete state.tokens[key];
  }
}

async function persist() {
  await mkdir(dir, { recursive: true });
  const tmp = `${dbPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(db));
  await rename(tmp, dbPath);
}

function update(mutator) {
  const run = chain.then(async () => {
    prune(db);
    const result = await mutator(db);
    await persist();
    return result;
  });
  chain = run.then(() => {}, () => {});
  return run;
}

export async function loadStore() {
  await mkdir(dir, { recursive: true });
  try {
    db = { ...empty(), ...JSON.parse(await readFile(dbPath, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    db = empty();
    await persist();
  }
  prune(db);
  return db;
}

export function readState() {
  return db;
}

export async function addNote(text) {
  const note = {
    id: randomId('n_'),
    text,
    createdAt: new Date().toISOString(),
  };
  await update(state => {
    state.notes.unshift(note);
  });
  return note;
}

export function searchNotes(query) {
  const needle = query.toLowerCase();
  return db.notes
    .filter(note => note.text.toLowerCase().includes(needle))
    .slice(0, 100)
    .map(note => ({ id: note.id, text: note.text, createdAt: note.createdAt }));
}

export async function saveClient(client) {
  await update(state => {
    state.clients[client.clientId] = client;
  });
}

export function getClient(clientId) {
  return db.clients[clientId] ?? null;
}

export async function savePending(row) {
  await update(state => {
    state.pending[row.id] = row;
  });
}

export function getPending(id) {
  const row = db.pending[id];
  if (!row || row.expiresAt <= Date.now()) return null;
  return row;
}

export async function deletePending(id) {
  await update(state => {
    delete state.pending[id];
  });
}

export async function saveCode(rawCode, row) {
  await update(state => {
    state.codes[tokenHash(rawCode)] = row;
  });
}

export async function takeCode(rawCode) {
  const key = tokenHash(rawCode);
  let row = null;
  await update(state => {
    row = state.codes[key] ?? null;
    delete state.codes[key];
  });
  if (!row || row.expiresAt <= Date.now()) return null;
  return row;
}

export async function saveToken(rawToken, row) {
  await update(state => {
    state.tokens[tokenHash(rawToken)] = row;
  });
}

export function getToken(rawToken) {
  const row = db.tokens[tokenHash(rawToken)];
  if (!row || row.expiresAt <= Date.now()) return null;
  return row;
}

export async function deleteToken(rawToken) {
  const key = tokenHash(rawToken);
  await update(state => {
    delete state.tokens[key];
  });
}

export async function saveFile({ filename, mediaType, bytes }) {
  const id = randomId('f_');
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
  const rel = path.join('uploads', id, safe);
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  const row = {
    id,
    filename: safe,
    mediaType,
    rel,
    bytes: bytes.length,
    createdAt: new Date().toISOString(),
  };
  await update(state => {
    state.files[id] = row;
  });
  return row;
}

export function getFile(id) {
  return db.files[id] ?? null;
}

export function filePath(row) {
  const full = path.resolve(dir, row.rel);
  const root = path.resolve(dir, 'uploads');
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}
