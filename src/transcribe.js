import { Buffer } from 'node:buffer';

import { readLimited, safeUrl } from './net.js';
import { fileBytes, getFile } from './store.js';

export const MAX_AUDIO_BYTES = 10_000_000;
const MODEL = '@cf/openai/whisper-large-v3-turbo';
const TOO_LARGE = `the audio is larger than the ${MAX_AUDIO_BYTES / 1_000_000} MB limit`;

// A Worker cannot fetch its own hostname, so links from upload are read from the store.
async function ownFile(env, url) {
  const match = /^\/files\/([^/]+)\/[^/]+$/.exec(url.pathname);
  const file = match ? await getFile(env.DB, decodeURIComponent(match[1])) : null;
  if (!file) throw new Error('no file at that URL on this server');
  if (file.bytes > MAX_AUDIO_BYTES) throw new Error(TOO_LARGE);
  return fileBytes(env.DB, file);
}

async function download(env, origin, value) {
  let url = safeUrl(value);
  for (let hop = 0; hop < 4; hop += 1) {
    if (url.origin === origin) return ownFile(env, url);
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'audio/*,video/*;q=0.8,*/*;q=0.5' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('the URL redirected nowhere');
      url = safeUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`the audio download failed with status ${response.status}`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) {
      throw new Error('the URL did not return audio');
    }
    return readLimited(response, MAX_AUDIO_BYTES, TOO_LARGE);
  }
  throw new Error('the URL redirected too many times');
}

export async function transcribeUrl(env, origin, value) {
  const bytes = await download(env, origin, value);
  if (bytes.length === 0) throw new Error('the audio file is empty');
  let output;
  try {
    output = await env.AI.run(MODEL, { audio: Buffer.from(bytes).toString('base64') });
  } catch (error) {
    console.error('transcribe failed', String(error));
    throw new Error('the audio could not be transcribed: it may not be audio, or the daily free allowance may be used up');
  }
  const rows = Array.isArray(output?.segments) ? output.segments : [];
  return rows
    .map(row => ({ start: Number(row.start), end: Number(row.end), text: String(row.text ?? '').trim() }))
    .filter(row => row.text && Number.isFinite(row.start) && Number.isFinite(row.end));
}
