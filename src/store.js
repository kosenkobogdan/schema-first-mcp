import { Buffer } from 'node:buffer';

// A D1 row holds at most 2,000,000 bytes, so files are kept as base64 pieces under that.
const CHUNK_CHARS = 1_800_000;
const MAX_STORED_BYTES = 300_000_000;
const MAX_NOTES = 20_000;

export function randomId(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + Buffer.from(bytes).toString('base64url');
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(digest).toString('hex');
}

export async function addNote(db, text) {
  const { n } = await db.prepare('SELECT count(*) AS n FROM notes').first();
  if (n >= MAX_NOTES) throw new Error('the note store is full');
  const id = randomId('n_');
  await db.prepare('INSERT INTO notes (id, text, search, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, text, text.toLowerCase(), new Date().toISOString())
    .run();
  return id;
}

export async function searchNotes(db, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const clauses = words.map(() => "search LIKE ? ESCAPE '\\'");
  const params = words.map(word => `%${word.replace(/[\\%_]/g, '\\$&')}%`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await db.prepare(`SELECT id, text, created_at FROM notes ${where} ORDER BY seq DESC LIMIT 100`)
    .bind(...params)
    .all();
  return results.map(row => ({ id: row.id, text: row.text, createdAt: row.created_at }));
}

export async function saveFile(db, { filename, mediaType, base64, bytes }) {
  const { total } = await db.prepare('SELECT coalesce(sum(bytes), 0) AS total FROM files').first();
  if (total + bytes > MAX_STORED_BYTES) throw new Error('the file store is full');
  const id = randomId('f_');
  const chunks = Math.ceil(base64.length / CHUNK_CHARS);
  for (let n = 0; n < chunks; n += 1) {
    await db.prepare('INSERT INTO file_chunks (file_id, n, data) VALUES (?, ?, ?)')
      .bind(id, n, base64.slice(n * CHUNK_CHARS, (n + 1) * CHUNK_CHARS))
      .run();
  }
  await db.prepare('INSERT INTO files (id, filename, media_type, bytes, chunks, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, filename, mediaType, bytes, chunks, new Date().toISOString())
    .run();
  return id;
}

export function getFile(db, id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
}

export async function fileChunk(db, id, n) {
  const row = await db.prepare('SELECT data FROM file_chunks WHERE file_id = ? AND n = ?').bind(id, n).first();
  return Buffer.from(row.data, 'base64');
}

export async function fileBytes(db, file) {
  const parts = [];
  for (let n = 0; n < file.chunks; n += 1) parts.push(await fileChunk(db, file.id, n));
  return Buffer.concat(parts);
}

export async function hit(db, key, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const row = await db.prepare(`INSERT INTO rate (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET count = count + 1 RETURNING count`)
    .bind(`${key}:${bucket}`, (bucket + 2) * windowMs)
    .first();
  return row.count;
}

export async function prune(db) {
  const now = Date.now();
  await db.batch(['pending', 'codes', 'tokens', 'rate'].map(table => (
    db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).bind(now)
  )));
}
