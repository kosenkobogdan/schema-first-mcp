import { Buffer } from 'node:buffer';

import { readLimited, safeUrl } from './net.js';
import { consentPage, messagePage } from './pages.js';
import { hit, randomId, sha256 } from './store.js';

export const SCOPE = 'mcp:use';
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'];

const metadataCache = new Map();

export const resourceUrl = origin => `${origin}/mcp`;

export function authorizationServerDocument(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/plan`,
  };
}

export function protectedResourceDocument(origin) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Schema First',
    resource_documentation: `${origin}/plan`,
  };
}

export function wwwAuthenticate(origin, error) {
  const parts = [
    `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${SCOPE}"`,
  ];
  if (error) parts.push(`error="${error}"`, 'error_description="The access token is not valid for this server"');
  return `Bearer ${parts.join(', ')}`;
}

export function readBearer(header) {
  const match = /^Bearer +(\S+) *$/i.exec(header || '');
  return match ? match[1] : null;
}

export async function authenticate(env, raw, origin) {
  if (!raw) return null;
  const row = await env.DB.prepare('SELECT * FROM tokens WHERE hash = ?').bind(await sha256(raw)).first();
  if (!row || row.kind !== 'access' || row.expires_at <= Date.now()) return null;
  if (row.resource !== resourceUrl(origin) || !row.scope.split(' ').includes(SCOPE)) return null;
  return row;
}

function redirectAllowed(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

// Native clients pick a free loopback port at run time, so the port may differ.
function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  let left;
  let right;
  try {
    left = new URL(registered);
    right = new URL(requested);
  } catch {
    return false;
  }
  return left.protocol === 'http:'
    && right.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(left.hostname)
    && left.hostname === right.hostname
    && left.pathname === right.pathname
    && left.search === right.search;
}

function sameResource(value, expected) {
  try {
    const url = new URL(value);
    return !url.search && !url.hash && url.href.replace(/\/$/, '') === expected;
  } catch {
    return false;
  }
}

function clientIdIsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname !== '/';
  } catch {
    return false;
  }
}

async function fetchClientMetadata(clientId) {
  const cached = metadataCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;
  const response = await fetch(safeUrl(clientId, { httpsOnly: true }), {
    redirect: 'manual',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200) throw new Error('metadata fetch failed');
  const doc = JSON.parse(new TextDecoder().decode(await readLimited(response, 64 * 1024, 'metadata too large')));
  if (doc?.client_id !== clientId || typeof doc.client_name !== 'string' || !Array.isArray(doc.redirect_uris)) {
    throw new Error('invalid metadata');
  }
  if ((doc.token_endpoint_auth_method || 'none') !== 'none') throw new Error('unsupported client auth');
  const client = {
    client_id: clientId,
    client_name: doc.client_name.slice(0, 200),
    redirect_uris: doc.redirect_uris.filter(uri => typeof uri === 'string' && redirectAllowed(uri)),
    auth_method: 'none',
    secret_hash: null,
  };
  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') || '');
  const ttl = Math.min(maxAge ? Number(maxAge[1]) * 1000 : 300_000, 3_600_000);
  metadataCache.set(clientId, { client, expiresAt: Date.now() + ttl });
  return client;
}

async function resolveClient(env, clientId) {
  if (!clientId) return null;
  if (clientIdIsUrl(clientId)) return fetchClientMetadata(clientId);
  const row = await env.DB.prepare('SELECT * FROM clients WHERE client_id = ?').bind(clientId).first();
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) } : null;
}

function html(status, body, redirectOrigin) {
  const formAction = redirectOrigin ? `'self' ${redirectOrigin}` : "'self'";
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' },
  });
}

function redirectWith(uri, origin, state, values) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  url.searchParams.set('iss', origin);
  if (state) url.searchParams.set('state', state);
  return redirect(url.href);
}

function consent(pending, problem) {
  return html(problem ? 401 : 200, consentPage({ pending, problem }), new URL(pending.redirectUri).origin);
}

export async function handleAuthorize(env, origin, params) {
  const clientId = params.get('client_id') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const state = params.get('state') || '';
  let client = null;
  try {
    client = await resolveClient(env, clientId);
  } catch {
    return html(400, messagePage('Client not accepted', 'The client id could not be checked.'));
  }
  if (!client) return html(400, messagePage('Unknown client', 'This client is not registered.'));
  if (!client.redirect_uris.some(uri => redirectMatches(uri, redirectUri))) {
    return html(400, messagePage('Redirect not allowed', 'That redirect URI is not registered for this client.'));
  }

  const fail = error => redirectWith(redirectUri, origin, state, { error });
  const responseMode = params.get('response_mode');
  if (responseMode && responseMode !== 'query') return fail('invalid_request');
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type');
  if (params.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(params.get('code_challenge') || '')) return fail('invalid_request');
  const resources = params.getAll('resource');
  if (resources.length !== 1 || !sameResource(resources[0], resourceUrl(origin))) return fail('invalid_target');
  const scopes = (params.get('scope') || '').split(/\s+/).filter(Boolean);
  if (scopes.some(scope => scope !== SCOPE)) return fail('invalid_scope');
  if (params.get('prompt') === 'none') return fail('interaction_required');

  const pending = {
    id: randomId('p_'),
    clientId,
    clientName: client.client_name || clientId,
    redirectUri,
    state,
    codeChallenge: params.get('code_challenge'),
    resource: resourceUrl(origin),
    scope: SCOPE,
  };
  await env.DB.prepare('INSERT INTO pending (id, body, expires_at) VALUES (?, ?, ?)')
    .bind(pending.id, JSON.stringify(pending), Date.now() + PENDING_TTL_MS)
    .run();
  return consent(pending);
}

async function passphraseMatches(env, value) {
  if (!env.OWNER_PASSPHRASE || !value) return false;
  const left = Buffer.from(await sha256(value));
  const right = Buffer.from(await sha256(env.OWNER_PASSPHRASE));
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function handleDecision(env, origin, params, ip) {
  const id = params.get('pending') || '';
  const row = await env.DB.prepare('SELECT * FROM pending WHERE id = ? AND expires_at > ?').bind(id, Date.now()).first();
  if (!row) return html(400, messagePage('Request expired', 'Start the sign-in again from your client.'));
  const pending = JSON.parse(row.body);

  if (params.get('decision') !== 'approve') {
    await env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(id).run();
    return redirectWith(pending.redirectUri, origin, pending.state, { error: 'access_denied' });
  }

  const failures = await hit(env.DB, `approve:${ip}`, 3_600_000);
  const correct = failures <= 30 && await passphraseMatches(env, params.get('passphrase'));
  if (!correct) {
    const updated = await env.DB.prepare('UPDATE pending SET attempts = attempts + 1 WHERE id = ? RETURNING attempts').bind(id).first();
    if (updated.attempts >= MAX_ATTEMPTS) {
      await env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(id).run();
      return redirectWith(pending.redirectUri, origin, pending.state, { error: 'access_denied' });
    }
    return consent(pending, 'That is not the owner passphrase.');
  }

  await env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(id).run();
  const code = randomId('ac_');
  await env.DB.prepare('INSERT INTO codes (hash, body, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(code), JSON.stringify(pending), Date.now() + CODE_TTL_MS)
    .run();
  return redirectWith(pending.redirectUri, origin, pending.state, { code });
}

function readClientAuth(authorization, body) {
  if (/^Basic +/i.test(authorization || '')) {
    const decoded = Buffer.from(authorization.replace(/^Basic +/i, ''), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index < 0) return { clientId: '', clientSecret: '', method: 'client_secret_basic' };
    return {
      clientId: decodeURIComponent(decoded.slice(0, index)),
      clientSecret: decodeURIComponent(decoded.slice(index + 1)),
      method: 'client_secret_basic',
    };
  }
  if (body.get('client_secret')) {
    return { clientId: body.get('client_id'), clientSecret: body.get('client_secret'), method: 'client_secret_post' };
  }
  return { clientId: body.get('client_id'), clientSecret: '', method: 'none' };
}

async function issueTokens(env, clientId, resource, scope) {
  const access = randomId('at_');
  const refresh = randomId('rt_');
  const now = Date.now();
  const insert = env.DB.prepare('INSERT INTO tokens (hash, kind, client_id, resource, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  await env.DB.batch([
    insert.bind(await sha256(access), 'access', clientId, resource, scope, now + ACCESS_TTL_MS),
    insert.bind(await sha256(refresh), 'refresh', clientId, resource, scope, now + REFRESH_TTL_MS),
  ]);
  return json(200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope,
  });
}

function verifierValid(verifier) {
  return /^[\w\-.~]{43,128}$/.test(verifier || '');
}

export async function handleToken(env, origin, authorization, body) {
  const auth = readClientAuth(authorization, body);
  let client;
  try {
    client = await resolveClient(env, auth.clientId);
  } catch {
    client = null;
  }
  if (!client || client.auth_method !== auth.method) return json(401, { error: 'invalid_client' });
  if (client.auth_method !== 'none' && (await sha256(auth.clientSecret)) !== client.secret_hash) {
    return json(401, { error: 'invalid_client' });
  }

  const grant = body.get('grant_type');
  const resources = body.getAll('resource');
  if (grant === 'authorization_code') {
    const row = await env.DB.prepare('DELETE FROM codes WHERE hash = ? AND expires_at > ? RETURNING body')
      .bind(await sha256(body.get('code') || ''), Date.now())
      .first();
    if (!row) return json(400, { error: 'invalid_grant' });
    const code = JSON.parse(row.body);
    if (code.clientId !== client.client_id || code.redirectUri !== body.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
    const verifier = body.get('code_verifier');
    if (!verifierValid(verifier)) return json(400, { error: 'invalid_grant' });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    if (Buffer.from(digest).toString('base64url') !== code.codeChallenge) return json(400, { error: 'invalid_grant' });
    if (resources.length !== 1 || !sameResource(resources[0], code.resource) || code.resource !== resourceUrl(origin)) {
      return json(400, { error: 'invalid_target' });
    }
    return issueTokens(env, client.client_id, code.resource, code.scope);
  }

  if (grant === 'refresh_token') {
    const row = await env.DB.prepare("DELETE FROM tokens WHERE hash = ? AND kind = 'refresh' AND client_id = ? AND expires_at > ? RETURNING *")
      .bind(await sha256(body.get('refresh_token') || ''), client.client_id, Date.now())
      .first();
    if (!row) return json(400, { error: 'invalid_grant' });
    if (resources.length > 0 && (resources.length !== 1 || !sameResource(resources[0], row.resource))) {
      return json(400, { error: 'invalid_target' });
    }
    return issueTokens(env, client.client_id, row.resource, row.scope);
  }

  return json(400, { error: 'unsupported_grant_type' });
}

export async function handleRegister(env, text, ip) {
  if (await hit(env.DB, `register:${ip}`, 3_600_000) > 30) return json(429, { error: 'too_many_requests' });
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_client_metadata' });
  }
  if (!Array.isArray(doc?.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > 10) {
    return json(400, { error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
  }
  if (!doc.redirect_uris.every(uri => typeof uri === 'string' && redirectAllowed(uri))) {
    return json(400, { error: 'invalid_redirect_uri' });
  }
  const method = doc.token_endpoint_auth_method || 'none';
  if (!AUTH_METHODS.includes(method)) return json(400, { error: 'invalid_client_metadata' });
  const clientId = randomId('c_');
  const secret = method === 'none' ? null : randomId('cs_');
  const name = typeof doc.client_name === 'string' ? doc.client_name.slice(0, 200) : clientId;
  await env.DB.prepare('INSERT INTO clients (client_id, client_name, redirect_uris, auth_method, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(clientId, name, JSON.stringify(doc.redirect_uris), method, secret ? await sha256(secret) : null, new Date().toISOString())
    .run();
  return json(201, {
    client_id: clientId,
    client_name: name,
    redirect_uris: doc.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  });
}
