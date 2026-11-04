import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

import { startServer } from './index.js';

const transcribe = !process.argv.includes('--no-transcribe');

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function parseMcp(response) {
  const text = await response.text();
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) {
    const data = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
    const last = data.filter(Boolean).at(-1);
    if (!last) throw new Error(`empty SSE body: ${text.slice(0, 400)}`);
    return JSON.parse(last);
  }
  if (!text) throw new Error(`empty MCP body, status ${response.status}`);
  return JSON.parse(text);
}

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'selftest', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function mcpCall(origin, token, body) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': body.method,
      ...(body.params?.name ? { 'mcp-name': body.params.name } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed = await parseMcp(response);
  if (parsed.error) throw new Error(`${body.method} failed: ${JSON.stringify(parsed.error)}`);
  return { status: response.status, parsed };
}

const server = await startServer(0, '127.0.0.1');
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;

try {
  const anonymous = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(anonymous.status, 401);
  const challenge = anonymous.headers.get('www-authenticate') || '';
  assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /scope="mcp:use"/);

  const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${origin}/mcp`);
  assert.deepEqual(prm.authorization_servers, [origin]);
  assert.equal(prm.resource_documentation, `${origin}/plan`);
  const rootPrm = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json();
  assert.equal(rootPrm.resource_documentation, `${origin}/plan`);

  const plan = await (await fetch(`${origin}/plan`)).text();
  assert.match(plan, /memo_write/);
  assert.match(plan, /memo_search/);
  assert.match(plan, /upload/);
  assert.match(plan, /transcribe/);
  assert.match(plan, /Sign-in/);
  assert.match(plan, /What this server keeps/);

  const asMeta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asMeta.issuer, origin);
  assert.equal(asMeta.client_id_metadata_document_supported, true);
  assert.equal(asMeta.authorization_response_iss_parameter_supported, true);
  const oidc = await (await fetch(`${origin}/.well-known/openid-configuration`)).json();
  assert.equal(oidc.token_endpoint, `${origin}/token`);

  const redirectUri = 'http://127.0.0.1:9/callback';
  const registered = await (await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'selftest',
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })).json();
  assert.ok(registered.client_id);

  const { verifier, challenge: codeChallenge } = pkce();
  const state = 'state-1';
  const authorize = new URL(`${origin}/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', registered.client_id);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('code_challenge', codeChallenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('resource', `${origin}/mcp`);
  authorize.searchParams.set('scope', 'mcp:use');
  authorize.searchParams.set('state', state);
  const consent = await (await fetch(authorize)).text();
  const pending = consent.match(/name="pending" value="([^"]+)"/);
  assert.ok(pending, 'consent page did not include a pending id');

  const decision = await fetch(`${origin}/authorize/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending: pending[1], decision: 'approve' }),
    redirect: 'manual',
  });
  assert.equal(decision.status, 302);
  const back = new URL(decision.headers.get('location'));
  assert.equal(back.searchParams.get('state'), state);
  assert.equal(back.searchParams.get('iss'), origin);
  const code = back.searchParams.get('code');
  assert.ok(code);

  const tokenResponse = await fetch(`${origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: registered.client_id,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  const token = await tokenResponse.json();
  assert.equal(token.token_type, 'Bearer');
  assert.ok(token.access_token);

  const listed = await mcpCall(origin, token.access_token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {
      _meta: modernMeta,
    },
  });
  const names = listed.parsed.result.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['memo_search', 'memo_write', 'transcribe', 'upload']);
  for (const tool of listed.parsed.result.tools) {
    assert.ok(tool.outputSchema, `${tool.name} missing outputSchema`);
    assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
  }

  const written = await mcpCall(origin, token.access_token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'memo_write',
      arguments: { text: 'the paragraph about the dock' },
      _meta: modernMeta,
    },
  });
  const noteId = written.parsed.result.structuredContent.id;
  assert.match(noteId, /^n_/);

  const found = await mcpCall(origin, token.access_token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'memo_search',
      arguments: { query: 'dock' },
      _meta: modernMeta,
    },
  });
  assert.equal(found.parsed.result.structuredContent.notes[0].id, noteId);
  assert.equal(found.parsed.result.structuredContent.notes[0].text, 'the paragraph about the dock');

  const uploaded = await mcpCall(origin, token.access_token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'upload',
      arguments: { filename: 'hello.txt', content: 'hello file', mediaType: 'text/plain' },
      _meta: modernMeta,
    },
  });
  const fileUrl = uploaded.parsed.result.structuredContent.url;
  assert.equal(fileUrl.startsWith(`${origin}/files/`), true);
  const file = await fetch(fileUrl);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'hello file');

  const legacy = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'selftest', version: '1.0.0' },
      },
    }),
  });
  const legacyBody = await parseMcp(legacy);
  assert.equal(legacyBody.result.protocolVersion, '2025-11-25');

  const bad = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer not-a-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
    },
    body: '{}',
  });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate') || '', /error="invalid_token"/);

  if (transcribe) {
    if (!process.env.WHISPER_MODEL) {
      console.log('transcribe skipped: WHISPER_MODEL is not set');
    } else {
    const audio = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
    const heard = await mcpCall(origin, token.access_token, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'transcribe',
        arguments: { url: audio },
        _meta: modernMeta,
      },
    });
    if (heard.parsed.result.isError) {
      throw new Error(JSON.stringify(heard.parsed.result.content));
    }
    const segments = heard.parsed.result.structuredContent.segments;
    assert.ok(segments.length > 0, 'transcribe returned no segments');
    assert.equal(typeof segments[0].start, 'number');
    assert.match(segments.map(segment => segment.text).join(' ').toLowerCase(), /nation|ask not|country/);
    console.log('transcribe sample:', segments.map(segment => segment.text).join(' ').slice(0, 180));
    }
  }

  console.log('selftest passed');
} finally {
  await new Promise(resolve => server.close(resolve));
}
