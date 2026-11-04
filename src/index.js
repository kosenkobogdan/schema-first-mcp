import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callMcp } from './mcp.js';
import { configuredOrigin, runWithOrigin } from './origin.js';
import {
  authenticateAccessToken,
  handleAuthorize,
  handleDecision,
  handleRegister,
  handleToken,
  metadataDocument,
  protectedResourceDocument,
  readBearer,
  wwwAuthenticate,
} from './oauth.js';
import { planPage } from './pages.js';
import { filePath, getFile, loadStore } from './store.js';

const MAX_BODY = 20_000_000;

function applyCors(headers) {
  headers['access-control-allow-origin'] = '*';
  headers['access-control-allow-methods'] = 'GET, POST, DELETE, OPTIONS';
  headers['access-control-allow-headers'] = 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID';
  headers['access-control-expose-headers'] = 'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id';
  headers['access-control-max-age'] = '86400';
  return headers;
}

function send(res, result) {
  const headers = applyCors({ ...(result.headers || {}) });
  res.writeHead(result.status, headers);
  res.end(result.body ?? '');
}

function json(status, value, extra = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
    body: JSON.stringify(value),
  };
}

function originFrom(req) {
  const configured = configuredOrigin();
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1').split(',')[0].trim();
  return `${proto}://${host}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readParams(req, body) {
  const type = String(req.headers['content-type'] || '');
  const text = body.toString('utf8');
  if (type.includes('application/json')) {
    const doc = JSON.parse(text || '{}');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(doc)) {
      if (Array.isArray(value)) value.forEach(item => params.append(key, String(item)));
      else if (value != null) params.set(key, String(value));
    }
    return params;
  }
  return new URLSearchParams(text);
}

function nodeRequest(origin, req, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
    else headers.set(key, value);
  }
  const method = req.method || 'GET';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = body;
  return new Request(`${origin}${req.url}`, init);
}

async function writeWeb(res, webRes) {
  const headers = {};
  webRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  applyCors(headers);
  const bytes = Buffer.from(await webRes.arrayBuffer());
  res.writeHead(webRes.status, headers);
  res.end(bytes);
}

async function handle(req, res) {
  const origin = originFrom(req);
  const url = new URL(req.url || '/', origin);
  const pathName = url.pathname;

  if (req.method === 'OPTIONS') {
    send(res, { status: 204, headers: {}, body: '' });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && (pathName === '/' || pathName === '/plan')) {
    if (pathName === '/') {
      send(res, { status: 302, headers: { location: '/plan' }, body: '' });
      return;
    }
    const page = planPage(origin);
    send(res, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: req.method === 'HEAD' ? '' : page,
    });
    return;
  }

  if (req.method === 'GET' && (pathName === '/.well-known/oauth-protected-resource' || pathName === '/.well-known/oauth-protected-resource/mcp')) {
    send(res, json(200, protectedResourceDocument(origin)));
    return;
  }

  if (req.method === 'GET' && (pathName === '/.well-known/oauth-authorization-server' || pathName === '/.well-known/openid-configuration')) {
    send(res, json(200, metadataDocument(origin)));
    return;
  }

  if (req.method === 'GET' && pathName === '/authorize') {
    send(res, await handleAuthorize(origin, url.searchParams));
    return;
  }

  if (req.method === 'POST' && pathName === '/authorize/decision') {
    const params = await readParams(req, await readBody(req));
    send(res, await handleDecision(origin, params));
    return;
  }

  if (req.method === 'POST' && pathName === '/token') {
    const params = await readParams(req, await readBody(req));
    send(res, await handleToken(origin, req.headers.authorization, params));
    return;
  }

  if (req.method === 'POST' && pathName === '/register') {
    send(res, await handleRegister((await readBody(req)).toString('utf8')));
    return;
  }

  const fileMatch = /^\/files\/([^/]+)\/([^/]+)$/.exec(pathName);
  if ((req.method === 'GET' || req.method === 'HEAD') && fileMatch) {
    const row = getFile(decodeURIComponent(fileMatch[1]));
    const name = decodeURIComponent(fileMatch[2]);
    const full = row && row.filename === name ? filePath(row) : null;
    if (!full) {
      send(res, json(404, { error: 'not_found' }));
      return;
    }
    const bytes = await readFile(full);
    send(res, {
      status: 200,
      headers: {
        'content-type': row.mediaType,
        'content-length': String(bytes.length),
        'content-disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
        'content-security-policy': 'sandbox',
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=300',
      },
      body: req.method === 'HEAD' ? '' : bytes,
    });
    return;
  }

  if (pathName === '/mcp' || pathName === '/mcp/') {
    const token = readBearer(req.headers.authorization);
    const access = authenticateAccessToken(token, origin);
    if (!access) {
      const error = token ? 'invalid_token' : undefined;
      send(res, {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': wwwAuthenticate(origin, {
            error,
            description: token ? 'invalid token' : undefined,
          }),
          'cache-control': 'no-store',
        },
        body: JSON.stringify({
          error: error || 'unauthorized',
          error_description: token ? 'invalid token' : 'authentication required',
        }),
      });
      return;
    }
    const body = await readBody(req);
    const request = nodeRequest(origin, req, body);
    await runWithOrigin(origin, async () => {
      await writeWeb(res, await callMcp(request));
    });
    return;
  }

  send(res, json(404, { error: 'not_found' }));
}

export async function startServer(port = 8787, host = '0.0.0.0') {
  await loadStore();
  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      const status = error.status || 500;
      if (!res.headersSent) {
        send(res, json(status, { error: status === 413 ? 'payload_too_large' : 'server_error' }));
      } else {
        res.end();
      }
      if (status === 500) console.error(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  startServer(port).then(server => {
    const address = server.address();
    console.log(`schema-first listening on ${address.port}`);
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
