// Calls a running server the way a stranger would. BASE and PASSPHRASE come from the environment.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const PASSPHRASE = process.env.PASSPHRASE;
const AUDIO_URL = process.env.AUDIO_URL;
const VERSION = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'check', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const REDIRECT = 'http://127.0.0.1:9/callback';

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function post(path, body, headers = {}) {
  return fetch(`${BASE}${path}`, { method: 'POST', redirect: 'manual', headers, body });
}

function rpcHeaders(token, method, name) {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
  };
}

let nextId = 1;
async function rpc(token, method, params = {}) {
  const response = await post('/mcp', JSON.stringify({
    jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META },
  }), rpcHeaders(token, method, params.name));
  return { status: response.status, body: await response.json() };
}

async function tool(token, name, args) {
  const { status, body } = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(status, 200);
  return body.result;
}

function matchesSchema(schema, value, path = 'result') {
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    value.forEach((item, i) => matchesSchema(schema.items, item, `${path}[${i}]`));
    return;
  }
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path} must be an object`);
    for (const key of schema.required || []) assert.ok(key in value, `${path}.${key} is missing`);
    for (const [key, item] of Object.entries(value)) {
      assert.ok(schema.properties[key], `${path}.${key} is not declared`);
      matchesSchema(schema.properties[key], item, `${path}.${key}`);
    }
    return;
  }
  assert.equal(typeof value, schema.type, `${path} must be a ${schema.type}`);
}

function startAuthorize(clientId, overrides = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${BASE}/authorize`);
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
    scope: 'mcp:use',
    state: 'state-1',
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url, verifier };
}

async function pendingFrom(url) {
  const page = await (await fetch(url, { redirect: 'manual' })).text();
  const match = page.match(/name="pending" value="([^"]+)"/);
  assert.ok(match, 'the consent page has no pending id');
  return match[1];
}

function decide(pending, decision, passphrase) {
  const form = new URLSearchParams({ pending, decision });
  if (passphrase !== undefined) form.set('passphrase', passphrase);
  return post('/authorize/decision', form, { 'content-type': 'application/x-www-form-urlencoded' });
}

function exchange(clientId, code, verifier, extra = {}) {
  return post('/token', new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
    ...extra,
  }), { 'content-type': 'application/x-www-form-urlencoded' });
}

let clientId;
let token;
let refresh;
let tools;

await step('a call without a token gets 401 with the metadata link', async () => {
  const response = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }), rpcHeaders(null, 'tools/list'));
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate');
  assert.ok(challenge.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), challenge);
  assert.ok(challenge.includes('scope="mcp:use"'), challenge);
});

await step('a made-up token gets 401 invalid_token', async () => {
  const response = await post('/mcp', '{}', rpcHeaders('at_not-real', 'tools/list'));
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /error="invalid_token"/);
});

await step('a bad Origin gets 403', async () => {
  const response = await post('/mcp', '{}', { ...rpcHeaders(null, 'tools/list'), origin: 'https://evil.example' });
  assert.equal(response.status, 403);
});

await step('metadata and plan page are public and agree', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const doc = await (await fetch(`${BASE}${path}`)).json();
    assert.equal(doc.resource, `${BASE}/mcp`);
    assert.deepEqual(doc.authorization_servers, [BASE]);
    assert.equal(doc.resource_documentation, `${BASE}/plan`);
  }
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, BASE);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const plan = await (await fetch(`${BASE}/plan`)).text();
  for (const word of ['memo_write', 'memo_search', 'upload', 'transcribe', 'Sign-in', 'keeps']) assert.ok(plan.includes(word), word);
});

await step('a client can register, but bad redirects are refused', async () => {
  const bad = await post('/register', JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }), { 'content-type': 'application/json' });
  assert.equal(bad.status, 400);
  const good = await post('/register', JSON.stringify({ client_name: 'check <b>', redirect_uris: ['http://127.0.0.1/callback'] }), { 'content-type': 'application/json' });
  assert.equal(good.status, 201);
  clientId = (await good.json()).client_id;
});

await step('authorize refuses an unregistered redirect, a wrong resource and no PKCE', async () => {
  const redirectUri = await fetch(startAuthorize(clientId, { redirect_uri: 'https://evil.example/cb' }).url, { redirect: 'manual' });
  assert.equal(redirectUri.status, 400);
  const resource = await fetch(startAuthorize(clientId, { resource: 'https://other.example/mcp' }).url, { redirect: 'manual' });
  assert.equal(new URL(resource.headers.get('location')).searchParams.get('error'), 'invalid_target');
  const plain = await fetch(startAuthorize(clientId, { code_challenge_method: 'plain' }).url, { redirect: 'manual' });
  assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');
});

await step('the consent page escapes the client name', async () => {
  const page = await (await fetch(startAuthorize(clientId).url)).text();
  assert.ok(page.includes('check &lt;b&gt;'));
  assert.ok(!page.includes('check <b>'));
  const headers = (await fetch(startAuthorize(clientId).url)).headers;
  assert.equal(headers.get('referrer-policy'), 'same-origin');
});

await step('a stranger cannot approve itself without the passphrase', async () => {
  const { url } = startAuthorize(clientId);
  const pending = await pendingFrom(url);
  for (const guess of [undefined, '', 'password']) {
    const response = await decide(pending, 'approve', guess);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('location'), null);
  }
});

await step('wrong guesses end the request', async () => {
  const { url } = startAuthorize(clientId);
  const pending = await pendingFrom(url);
  let last;
  for (let i = 0; i < 5; i += 1) last = await decide(pending, 'approve', 'nope');
  assert.equal(new URL(last.headers.get('location')).searchParams.get('error'), 'access_denied');
});

await step('deny returns access_denied with iss and state', async () => {
  const { url } = startAuthorize(clientId);
  const response = await decide(await pendingFrom(url), 'deny');
  const back = new URL(response.headers.get('location'));
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('iss'), BASE);
  assert.equal(back.searchParams.get('state'), 'state-1');
});

await step('the owner approves and the client gets tokens; the code works once and needs PKCE', async () => {
  const { url, verifier } = startAuthorize(clientId);
  const response = await decide(await pendingFrom(url), 'approve', PASSPHRASE);
  assert.equal(response.status, 302);
  const back = new URL(response.headers.get('location'));
  assert.equal(back.searchParams.get('iss'), BASE);
  const code = back.searchParams.get('code');

  const second = startAuthorize(clientId);
  const otherCode = new URL((await decide(await pendingFrom(second.url), 'approve', PASSPHRASE)).headers.get('location')).searchParams.get('code');
  assert.equal((await exchange(clientId, otherCode, randomBytes(32).toString('base64url'))).status, 400);

  const tokens = await exchange(clientId, code, verifier);
  assert.equal(tokens.status, 200);
  const doc = await tokens.json();
  assert.equal(doc.token_type, 'Bearer');
  token = doc.access_token;
  refresh = doc.refresh_token;
  assert.equal((await exchange(clientId, code, verifier)).status, 400);
});

await step('a refresh token rotates and works only once', async () => {
  const form = () => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
  const first = await post('/token', form(), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(first.status, 200);
  const doc = await first.json();
  const again = await post('/token', form(), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(again.status, 400);
  token = doc.access_token;
  refresh = doc.refresh_token;
});

await step('server/discover names versions, tools and the server', async () => {
  const { status, body } = await rpc(token, 'server/discover');
  assert.equal(status, 200);
  assert.equal(body.result.resultType, 'complete');
  assert.ok(body.result.supportedVersions.includes(VERSION));
  assert.ok(body.result.capabilities.tools);
  assert.ok(body.result.ttlMs >= 0);
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'schema-first');
});

await step('tools/list gives four tools with both schemas and caching hints', async () => {
  const { body } = await rpc(token, 'tools/list');
  tools = Object.fromEntries(body.result.tools.map(row => [row.name, row]));
  assert.deepEqual(Object.keys(tools).sort(), ['memo_search', 'memo_write', 'transcribe', 'upload']);
  for (const row of body.result.tools) {
    assert.equal(row.inputSchema.type, 'object');
    assert.equal(row.outputSchema.type, 'object');
  }
  assert.ok(body.result.ttlMs >= 0);
  assert.equal(body.result.cacheScope, 'public');
});

await step('protocol errors follow the spec', async () => {
  const send = async (headers, params = { _meta: META }, method = 'tools/list') => {
    const response = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 9, method, params }), { ...rpcHeaders(token, method), ...headers });
    return { status: response.status, code: (await response.json()).error?.code, };
  };
  assert.deepEqual(await send({ 'mcp-protocol-version': '1900-01-01' }), { status: 400, code: -32022 });
  assert.deepEqual(await send({ 'mcp-protocol-version': '2025-11-25' }), { status: 400, code: -32020 });
  assert.deepEqual(await send({ 'mcp-method': 'tools/call' }), { status: 400, code: -32020 });
  assert.deepEqual(await send({}, {}), { status: 400, code: -32602 });
  assert.deepEqual(await send({}, { _meta: META }, 'nope/nope'), { status: 404, code: -32601 });
  const name = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'memo_search', arguments: { query: '' }, _meta: META } }), rpcHeaders(token, 'tools/call', 'upload'));
  assert.equal(name.status, 400);
  const get = await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(get.status, 405);
  const junk = await post('/mcp', '{not json', rpcHeaders(token, 'tools/list'));
  assert.equal((await junk.json()).error.code, -32700);
  const unknown = await rpc(token, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
});

await step('a legacy client can initialize and call a tool', async () => {
  const init = await post('/mcp', JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
  }), { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
  const doc = await init.json();
  assert.equal(doc.result.protocolVersion, '2025-11-25');
  const legacy = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
  const note = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), legacy);
  assert.equal(note.status, 202);
  const list = await (await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), legacy)).json();
  assert.equal(list.result.tools.length, 4);
});

let noteId;
const marker = `check-${randomBytes(6).toString('hex')}`;
await step('memo_write and memo_search round trip with structured content', async () => {
  const written = await tool(token, 'memo_write', { text: `The ${marker} Paragraph, 50% about_the dock` });
  assert.equal(written.isError, false);
  matchesSchema(tools.memo_write.outputSchema, written.structuredContent);
  noteId = written.structuredContent.id;
  const found = await tool(token, 'memo_search', { query: `${marker.toUpperCase()} dock` });
  matchesSchema(tools.memo_search.outputSchema, found.structuredContent);
  assert.equal(found.structuredContent.notes[0].id, noteId);
  assert.deepEqual(JSON.parse(found.content[0].text), found.structuredContent);
});

await step('memo_search treats LIKE and quote characters as text', async () => {
  const found = await tool(token, 'memo_search', { query: `${marker} 50%` });
  assert.equal(found.structuredContent.notes.length, 1);
  const none = await tool(token, 'memo_search', { query: `${marker} a_out` });
  assert.equal(none.structuredContent.notes.length, 0);
  const quote = await tool(token, 'memo_search', { query: "' OR 1=1 --" });
  assert.equal(quote.structuredContent.notes.length, 0);
});

await step('bad tool input is a tool error, not a crash', async () => {
  for (const [name, args] of [
    ['memo_write', {}],
    ['memo_write', { text: 42 }],
    ['memo_write', { text: 'x', extra: 'y' }],
    ['memo_search', {}],
    ['upload', { filename: 'a.txt' }],
    ['upload', { filename: 'a.bin', content: '***', encoding: 'base64' }],
    ['upload', { filename: 'a.txt', content: 'x', encoding: 'rot13' }],
    ['transcribe', {}],
    ['transcribe', { url: 'not a url' }],
  ]) {
    const result = await tool(token, name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(result.structuredContent, undefined);
  }
});

await step('upload gives a public link that needs no token', async () => {
  const text = await tool(token, 'upload', { filename: 'hello.txt', content: 'hello file' });
  matchesSchema(tools.upload.outputSchema, text.structuredContent);
  assert.ok(text.structuredContent.url.startsWith(`${BASE}/files/`));
  const file = await fetch(text.structuredContent.url);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'hello file');
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  const raw = randomBytes(3_000_000);
  const binary = await tool(token, 'upload', { filename: 'blob.bin', content: raw.toString('base64'), encoding: 'base64' });
  assert.equal(binary.isError, false, JSON.stringify(binary.content));
  const back = Buffer.from(await (await fetch(binary.structuredContent.url)).arrayBuffer());
  assert.ok(raw.equals(back), 'the binary file changed on the way');
});

await step('upload neutralises hostile names and active content', async () => {
  const sneaky = await tool(token, 'upload', { filename: '../../etc/pass wd<script>.html', content: '<script>alert(1)</script>', mediaType: 'text/html' });
  const url = new URL(sneaky.structuredContent.url);
  assert.ok(!url.pathname.includes('..') && !url.pathname.includes('<'), url.pathname);
  const file = await fetch(url);
  assert.match(file.headers.get('content-disposition'), /^attachment/);
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  const missing = await fetch(`${BASE}/files/f_nothing/x.txt`);
  assert.equal(missing.status, 404);
});

await step('upload refuses a file over the limit', async () => {
  const result = await tool(token, 'upload', { filename: 'big.txt', content: 'x'.repeat(12_000_001) });
  assert.equal(result.isError, true);
});

await step('transcribe refuses internal addresses', async () => {
  for (const url of [
    'http://localhost/a.mp3',
    'http://127.0.0.1/a.mp3',
    'http://2130706433/a.mp3',
    'http://0x7f.0.0.1/a.mp3',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/a.mp3',
    'http://[::1]/a.mp3',
    'http://[::ffff:127.0.0.1]/a.mp3',
    'http://metadata.google.internal/a.mp3',
    'https://example.com:8443/a.mp3',
    'file:///etc/passwd',
    'ftp://example.com/a.mp3',
    'https://user:pw@example.com/a.mp3',
  ]) {
    const result = await tool(token, 'transcribe', { url });
    assert.equal(result.isError, true, url);
    assert.match(result.content[0].text, /not allowed|must/, url);
    assert.ok(result.content[0].text.includes(url), `the error does not name ${url}`);
  }
});

await step('transcribe errors name the URL and what is wrong with it', async () => {
  const url = 'https://hq.mega.dev/media/s02e03/missing.mp3';
  const result = await tool(token, 'transcribe', { url });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes(url), result.content[0].text);
  assert.match(result.content[0].text, /404/);
  const unreachable = await tool(token, 'transcribe', { url: 'https://no-such-host.invalid/a.mp3' });
  assert.equal(unreachable.isError, true);
  assert.ok(unreachable.content[0].text.includes('no-such-host.invalid'), unreachable.content[0].text);
});

if (AUDIO_URL) {
  await step('transcribe returns timestamped text', async () => {
    const started = Date.now();
    const result = await tool(token, 'transcribe', { url: AUDIO_URL });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    matchesSchema(tools.transcribe.outputSchema, result.structuredContent);
    const { segments } = result.structuredContent;
    assert.ok(segments.length > 0);
    console.log(`     ${Date.now() - started} ms`);
    for (const row of segments) console.log(`     ${row.start} to ${row.end}: ${row.text}`);
  });

  await step('transcribe works on a link from upload', async () => {
    const audio = Buffer.from(await (await fetch(AUDIO_URL)).arrayBuffer());
    const stored = await tool(token, 'upload', { filename: 'clip.mp3', content: audio.toString('base64'), encoding: 'base64' });
    assert.equal(stored.isError, false, JSON.stringify(stored.content));
    const result = await tool(token, 'transcribe', { url: stored.structuredContent.url });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.ok(result.structuredContent.segments.length > 0);
  });

  await step('transcribe says so when a URL holds no audio', async () => {
    const result = await tool(token, 'transcribe', { url: 'https://example.com/' });
    assert.equal(result.isError, true);
    console.log(`     ${result.content[0].text}`);
  });
}

for (const megabytes of (process.env.SIZES || '').split(',').filter(Boolean).map(Number)) {
  await step(`upload and read back ${megabytes} MB`, async () => {
    const raw = randomBytes(Math.floor(megabytes * 1_000_000));
    const started = Date.now();
    const result = await tool(token, 'upload', { filename: 'size.bin', content: raw.toString('base64'), encoding: 'base64' });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const back = await fetch(result.structuredContent.url);
    assert.equal(back.status, 200);
    assert.ok(raw.equals(Buffer.from(await back.arrayBuffer())), 'bytes changed');
    console.log(`     ${Date.now() - started} ms`);
  });
}

console.log(`${passed} passed${process.exitCode ? ', with failures' : ''}`);
