import { handleMcp } from './mcp.js';
import {
  authenticate,
  authorizationServerDocument,
  handleAuthorize,
  handleDecision,
  handleRegister,
  handleToken,
  protectedResourceDocument,
  readBearer,
  wwwAuthenticate,
} from './oauth.js';
import { planPage } from './pages.js';
import { fileChunk, getFile, prune } from './store.js';

const MAX_BODY = 20_000_000;
const OPEN_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version',
  'access-control-max-age': '86400',
};
const OPEN_PATHS = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/token', '/register'];

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function withOpenCors(response) {
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(OPEN_CORS)) copy.headers.set(key, value);
  return copy;
}

function originProblem(request, origin) {
  const sent = request.headers.get('origin');
  if (sent === null || sent === origin) return null;
  return json(403, { jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } });
}

function tooLarge(request) {
  return Number(request.headers.get('content-length') || 0) > MAX_BODY;
}

async function serveFile(request, env, id, name) {
  const file = await getFile(env.DB, id);
  if (!file || file.filename !== name) return json(404, { error: 'not_found' });
  const active = /html|svg|xml|javascript/i.test(file.media_type);
  const headers = {
    'content-type': file.media_type,
    'content-length': String(file.bytes),
    'content-disposition': `${active ? 'attachment' : 'inline'}; filename="${file.filename}"`,
    'content-security-policy': "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=300',
    'access-control-allow-origin': '*',
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  let n = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (n >= file.chunks) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(await fileChunk(env.DB, file.id, n)));
      n += 1;
    },
  });
  return new Response(body, { headers });
}

async function serveMcp(request, env, origin) {
  const bad = originProblem(request, origin);
  if (bad) return bad;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        allow: 'POST, OPTIONS',
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        'access-control-expose-headers': 'WWW-Authenticate',
      },
    });
  }
  const token = readBearer(request.headers.get('authorization'));
  const access = await authenticate(env, token, origin);
  if (!access) {
    const error = token ? 'invalid_token' : undefined;
    return json(401, { error: error || 'unauthorized' }, { 'www-authenticate': wwwAuthenticate(origin, error) });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } });
  if (tooLarge(request)) return json(413, { jsonrpc: '2.0', error: { code: -32600, message: 'Request body is too large' } });
  return handleMcp(request, env, origin, access);
}

async function route(request, env) {
  const url = new URL(request.url);
  const { origin, pathname } = url;
  const { method } = request;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const read = method === 'GET' || method === 'HEAD';

  if (pathname === '/mcp') return serveMcp(request, env, origin);

  if (read && pathname === '/') return Response.redirect(`${origin}/plan`, 302);
  if (read && pathname === '/plan') {
    return new Response(method === 'HEAD' ? null : planPage(origin), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  }

  if (method === 'OPTIONS' && OPEN_PATHS.includes(pathname)) return new Response(null, { status: 204, headers: OPEN_CORS });
  if (read && (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp')) {
    return withOpenCors(json(200, protectedResourceDocument(origin)));
  }
  if (read && pathname === '/.well-known/oauth-authorization-server') {
    return withOpenCors(json(200, authorizationServerDocument(origin)));
  }

  if (method === 'GET' && pathname === '/authorize') return handleAuthorize(env, origin, url.searchParams);
  if (method === 'POST' && pathname === '/authorize/decision') {
    const sent = request.headers.get('origin');
    if (sent && sent !== origin) return json(403, { error: 'origin_not_allowed' });
    return handleDecision(env, origin, new URLSearchParams(await request.text()), ip);
  }
  if (method === 'POST' && pathname === '/token') {
    return withOpenCors(await handleToken(env, origin, request.headers.get('authorization'), new URLSearchParams(await request.text())));
  }
  if (method === 'POST' && pathname === '/register') {
    return withOpenCors(await handleRegister(env, await request.text(), ip));
  }

  const fileMatch = /^\/files\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (read && fileMatch) return serveFile(request, env, fileMatch[1], fileMatch[2]);

  return json(404, { error: 'not_found' });
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('unhandled', String(error));
      return json(500, { error: 'server_error' });
    }
  },
  async scheduled(_event, env) {
    await prune(env.DB);
  },
};
