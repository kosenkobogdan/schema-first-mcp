// Calls the server's upload tool with a file's exact bytes. BASE and PASSPHRASE come from the environment.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = process.env.BASE;
const PASSPHRASE = process.env.PASSPHRASE;
const [path, mediaType] = process.argv.slice(2);
if (!BASE || !PASSPHRASE || !path) throw new Error('usage: BASE=... PASSPHRASE=... node scripts/upload.js <file> [media/type]');

const REDIRECT = 'http://127.0.0.1:9/callback';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const VERSION = '2026-07-28';

const registered = await fetch(`${BASE}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'upload script', redirect_uris: ['http://127.0.0.1/callback'] }),
});
const { client_id: clientId } = await registered.json();

const verifier = randomBytes(32).toString('base64url');
const authorize = new URL(`${BASE}/authorize`);
for (const [key, value] of Object.entries({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
  resource: `${BASE}/mcp`,
  scope: 'mcp:use',
})) authorize.searchParams.set(key, value);
const page = await (await fetch(authorize)).text();
const pending = page.match(/name="pending" value="([^"]+)"/)?.[1];
const decision = await fetch(`${BASE}/authorize/decision`, {
  method: 'POST',
  redirect: 'manual',
  headers: FORM,
  body: new URLSearchParams({ pending, decision: 'approve', passphrase: PASSPHRASE }),
});
const code = new URL(decision.headers.get('location')).searchParams.get('code');
if (!code) throw new Error('the passphrase was not accepted');
const tokens = await (await fetch(`${BASE}/token`, {
  method: 'POST',
  headers: FORM,
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` }),
})).json();

const args = { filename: basename(path), content: readFileSync(path).toString('base64'), encoding: 'base64' };
if (mediaType) args.mediaType = mediaType;
const response = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${tokens.access_token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': VERSION,
    'mcp-method': 'tools/call',
    'mcp-name': 'upload',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'upload',
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'upload script', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }),
});
const { result, error } = await response.json();
if (error || result?.isError) throw new Error(JSON.stringify(error || result.content));
console.log(result.structuredContent.url);
