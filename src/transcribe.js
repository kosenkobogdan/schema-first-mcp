import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertFetchableUrl } from './oauth.js';

function extensionFor(contentType, url) {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'audio/mpeg' || type === 'audio/mp3') return '.mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') return '.wav';
  if (type === 'audio/flac') return '.flac';
  if (type === 'audio/ogg') return '.ogg';
  if (type === 'audio/webm' || type === 'video/webm') return '.webm';
  if (type === 'audio/mp4' || type === 'video/mp4') return '.m4a';
  const pathname = new URL(url).pathname.toLowerCase();
  const match = pathname.match(/\.(wav|mp3|flac|ogg|webm|m4a|mp4)$/);
  return match ? `.${match[1]}` : '.audio';
}

async function downloadAudio(url) {
  let current = await assertFetchableUrl(url);
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { accept: 'audio/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('audio redirect was empty');
      current = await assertFetchableUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`audio download failed (${response.status}) for ${url}`);
    const type = response.headers.get('content-type') || '';
    if (type.includes('text/html') || type.includes('application/json')) {
      throw new Error(`url did not return audio: ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error(`audio file was empty: ${url}`);
    if (bytes.length > 25_000_000) throw new Error(`audio file is too large: ${url}`);
    return { bytes, type, finalUrl: current.href };
  }
  throw new Error('too many audio redirects');
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim() || `${bin} exited ${code}`));
    });
  });
}

function stampSeconds(value) {
  if (typeof value === 'number') return value;
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(String(value ?? ''));
  if (!match) return 0;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]) + (Number(match[4]) / 1000);
}

function segmentsFrom(doc) {
  const rows = Array.isArray(doc?.transcription) ? doc.transcription : [];
  const segments = [];
  for (const row of rows) {
    const text = String(row.text ?? '').trim();
    if (!text) continue;
    const start = typeof row.offsets?.from === 'number'
      ? row.offsets.from / 1000
      : stampSeconds(row.timestamps?.from);
    const end = typeof row.offsets?.to === 'number'
      ? row.offsets.to / 1000
      : stampSeconds(row.timestamps?.to);
    segments.push({ start, end: Number.isFinite(end) ? end : start, text });
  }
  return segments;
}

let transcribeQueue = Promise.resolve();

function enqueue(task) {
  const run = transcribeQueue.then(task, task);
  transcribeQueue = run.then(() => {}, () => {});
  return run;
}

function segmentsFromServer(doc) {
  const rows = Array.isArray(doc?.segments) ? doc.segments : [];
  const segments = [];
  for (const row of rows) {
    const text = String(row.text ?? '').trim();
    if (!text) continue;
    const start = Number(row.start);
    const end = Number(row.end);
    segments.push({
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0),
      text,
    });
  }
  return segments;
}

async function transcribeWithCli(wavPath) {
  const model = process.env.WHISPER_MODEL;
  const whisper = process.env.WHISPER_BIN || 'whisper-cli';
  if (!model) throw new Error('WHISPER_MODEL is not set');
  const jsonBase = wavPath.replace(/\.wav$/, '');
  await run(whisper, [
    '-m', model,
    '-f', wavPath,
    '-l', 'auto',
    '-t', '1',
    '-bs', '1',
    '-bo', '1',
    '-nf',
    '-oj',
    '-of', jsonBase,
    '-np',
  ]);
  const doc = JSON.parse(await readFile(`${jsonBase}.json`, 'utf8'));
  await unlink(`${jsonBase}.json`).catch(() => {});
  return segmentsFrom(doc);
}

async function transcribeWithServer(wavBytes, url) {
  const form = new FormData();
  form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'verbose_json');
  form.append('language', 'auto');
  form.append('beam_size', '1');
  form.append('best_of', '1');
  form.append('no_fallback', 'true');
  form.append('no_language_probabilities', 'true');
  form.append('temperature', '0');
  form.append('temperature_inc', '0');
  const response = await fetch(process.env.WHISPER_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(110000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`audio transcription failed for ${url}: ${detail || response.status}`);
  }
  return segmentsFromServer(await response.json());
}

const transcriptCache = new Map();

export async function transcribeUrl(url) {
  const cached = transcriptCache.get(url);
  if (cached) return cached.map(segment => ({ ...segment }));
  const audio = await downloadAudio(url);
  const segments = await enqueue(() => decodeAudio(url, audio));
  transcriptCache.set(url, segments);
  return segments.map(segment => ({ ...segment }));
}

export async function warmTranscription() {
  const url = process.env.TRANSCRIBE_WARM_URL;
  if (!url || !process.env.WHISPER_URL) return;
  const started = Date.now();
  const segments = await transcribeUrl(url);
  console.log(`warmed transcription in ${Date.now() - started}ms (${segments.length} segments)`);
}

async function decodeAudio(url, audio) {
  const id = randomBytes(8).toString('hex');
  const source = path.join(tmpdir(), `schema-first-${id}.src${extensionFor(audio.type, audio.finalUrl)}`);
  const wavPath = path.join(tmpdir(), `schema-first-${id}.out.wav`);
  await writeFile(source, audio.bytes);
  try {
    await run(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath,
    ]);
    if (process.env.WHISPER_URL) {
      const wavBytes = await readFile(wavPath);
      return await transcribeWithServer(wavBytes, url);
    }
    return await transcribeWithCli(wavPath);
  } finally {
    await unlink(source).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}
