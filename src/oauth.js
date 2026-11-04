import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { consentPage, messagePage } from './pages.js';
import {
  deletePending,
  getClient,
  getPending,
  randomId,
  saveClient,
  tokenHash,
  saveCode,
  savePending,
  saveToken,
  secretMatches,
  takeCode,
  deleteToken,
  getToken,
} from './store.js';

export const SCOPE = 'mcp:use';
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

const metadataCache = new Map();

export function resourceUrl(origin) {
  return `${origin}/mcp`;
}

export function metadataDocument(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    response_modes_supported: ['query'],
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

export function wwwAuthenticate(origin, { error, description } = {}) {
  const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const parts = [
    'Bearer realm="mcp"',
    `resource_metadata="${metadata}"`,
    `scope="${SCOPE}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, '')}"`);
  return parts.join(', ');
}

export function readBearer(header) {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function authenticateAccessToken(raw, origin) {
  if (!raw) return null;
  const row = getToken(raw);
  if (!row || row.kind !== 'access') return null;
  if (row.resource !== resourceUrl(origin)) return null;
  if (!row.scope.split(/\s+/).includes(SCOPE)) return null;
  return row;
}

function isPrivateIp(ip) {
  const value = ip.toLowerCase();
  if (value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('10.') || value.startsWith('127.') || value.startsWith('0.') || value.startsWith('169.254.') || value.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(value);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('host not allowed');
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('host not allowed');
    return;
  }
  const records = await lookup(host, { all: true });
  if (records.length === 0 || records.some(record => isPrivateIp(record.address))) {
    throw new Error('host not allowed');
  }
}

function isHttpsUrlWithPath(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname !== '/';
  } catch {
    return false;
  }
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
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function loopbackMatch(registered, requested) {
  if (registered === requested) return true;
  let left;
  let right;
  try {
    left = new URL(registered);
    right = new URL(requested);
  } catch {
    return false;
  }
  const loopback = left.hostname === '127.0.0.1' || left.hostname === 'localhost' || left.hostname === '[::1]';
  return loopback
    && left.protocol === 'http:'
    && right.protocol === 'http:'
    && left.hostname === right.hostname
    && left.pathname === right.pathname
    && left.search === right.search;
}

function redirectMatches(redirectUris, requested) {
  return redirectUris.some(registered => loopbackMatch(registered, requested));
}

function sameResource(value, expected) {
  try {
    const left = new URL(value);
    const right = new URL(expected);
    return left.protocol === right.protocol
      && left.host === right.host
      && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
      && left.search === ''
      && !left.hash;
  } catch {
    return false;
  }
}

function pkce(verifier, challenge) {
  if (!/^[\w\-._~]{43,128}$/.test(verifier)) return false;
  const digest = createHash('sha256').update(verifier).digest('base64url');
  const left = Buffer.from(digest);
  const right = Buffer.from(challenge);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function assertFetchableUrl(value, { httpsOnly = false } = {}) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('url not allowed');
  if (httpsOnly) {
    if (url.protocol !== 'https:') throw new Error('https required');
  } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('http(s) required');
  }
  await assertPublicHost(url.hostname);
  return url;
}

function formValues(searchParams) {
  return {
    get(name) {
      return searchParams.get(name) ?? '';
    },
    getAll(name) {
      return searchParams.getAll(name);
    },
  };
}

async function readJsonLimited(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) throw new Error('metadata too large');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
}

async function fetchClientMetadata(url) {
  const cached = metadataCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;
  if (!isHttpsUrlWithPath(url)) throw new Error('invalid client id');
  const parsed = new URL(url);
  await assertPublicHost(parsed.hostname);
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  let finalResponse = response;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('metadata redirect is not allowed');
    const next = new URL(location, url);
    if (next.protocol !== 'https:') throw new Error('https required');
    await assertPublicHost(next.hostname);
    finalResponse = await fetch(next, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (finalResponse.status >= 300) throw new Error('metadata redirect is not allowed');
  }
  if (!finalResponse.ok) throw new Error('metadata fetch failed');
  const doc = await readJsonLimited(finalResponse, 65536);
  if (!doc || doc.client_id !== url || typeof doc.client_name !== 'string' || !Array.isArray(doc.redirect_uris)) {
    throw new Error('invalid metadata');
  }
  const cacheControl = finalResponse.headers.get('cache-control') || '';
  const maxAge = /max-age=(\d+)/.exec(cacheControl);
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : 300000;
  metadataCache.set(url, { doc, expiresAt: Date.now() + ttl });
  return doc;
}

async function resolveClient(clientId) {
  if (isHttpsUrlWithPath(clientId)) {
    const doc = await fetchClientMetadata(clientId);
    const method = doc.token_endpoint_auth_method || 'none';
    if (method !== 'none') throw new Error('unsupported client auth');
    return {
      clientId,
      clientName: doc.client_name,
      redirectUris: doc.redirect_uris.filter(uri => typeof uri === 'string'),
      authMethod: 'none',
      clientSecretHash: null,
    };
  }
  return getClient(clientId);
}

function errorRedirect(redirectUri, issuer, state, error) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('iss', issuer);
  if (state) url.searchParams.set('state', state);
  return url.href;
}

function grantedScope(scope) {
  const requested = scope.split(/\s+/).filter(Boolean);
  if (requested.length === 0) return SCOPE;
  if (requested.length === 1 && requested[0] === SCOPE) return SCOPE;
  return null;
}

export async function handleAuthorize(origin, searchParams) {
  const responseType = searchParams.get('response_type') || '';
  const clientId = searchParams.get('client_id') || '';
  const redirectUri = searchParams.get('redirect_uri') || '';
  const state = searchParams.get('state') || '';
  const challenge = searchParams.get('code_challenge') || '';
  const method = searchParams.get('code_challenge_method') || '';
  const resources = searchParams.getAll('resource');
  const responseMode = searchParams.get('response_mode');
  const prompt = searchParams.get('prompt');

  let client = null;
  try {
    client = await resolveClient(clientId);
  } catch {
    return html(400, messagePage('Client not accepted', 'The client id could not be checked.'));
  }
  if (!client) return html(400, messagePage('Unknown client', 'This client is not registered.'));
  if (!redirectMatches(client.redirectUris, redirectUri)) {
    return html(400, messagePage('Redirect not allowed', 'That redirect URI is not registered for this client.'));
  }

  const fail = error => redirect(errorRedirect(redirectUri, origin, state, error));
  if (responseMode && responseMode !== 'query') return fail('invalid_request');
  if (responseType !== 'code') return fail('unsupported_response_type');
  if (method !== 'S256' || !challenge) return fail('invalid_request');
  if (resources.length !== 1 || !sameResource(resources[0], resourceUrl(origin))) return fail('invalid_target');
  const scope = grantedScope(searchParams.get('scope') || '');
  if (!scope) return fail('invalid_scope');
  if (prompt === 'none') return fail('interaction_required');

  const pending = {
    id: randomId('p_'),
    clientId,
    clientName: client.clientName || clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    resource: resourceUrl(origin),
    scope,
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
  await savePending(pending);
  return html(200, consentPage({
    pending: pending.id,
    clientName: pending.clientName,
    clientId,
    redirectUri,
    scope,
    resource: pending.resource,
  }));
}

export async function handleDecision(origin, searchParams) {
  const pending = getPending(searchParams.get('pending') || '');
  const decision = searchParams.get('decision') || '';
  if (!pending) return html(400, messagePage('Request expired', 'Start the sign-in again.'));
  await deletePending(pending.id);
  if (decision !== 'approve') {
    return redirect(errorRedirect(pending.redirectUri, origin, pending.state, 'access_denied'));
  }
  const code = randomId('ac_');
  await saveCode(code, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    resource: pending.resource,
    scope: pending.scope,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const url = new URL(pending.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('iss', origin);
  if (pending.state) url.searchParams.set('state', pending.state);
  return redirect(url.href);
}

function readClientAuth(authorization, body) {
  if (authorization && /^Basic\s+/i.test(authorization)) {
    const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
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

async function issueTokens(clientId, resource, scope) {
  const access = randomId('at_');
  const refresh = randomId('rt_');
  const now = Date.now();
  await saveToken(access, {
    kind: 'access',
    clientId,
    resource,
    scope,
    expiresAt: now + ACCESS_TTL_MS,
  });
  await saveToken(refresh, {
    kind: 'refresh',
    clientId,
    resource,
    scope,
    expiresAt: now + REFRESH_TTL_MS,
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope,
  };
}

export async function handleToken(origin, authorization, body) {
  const auth = readClientAuth(authorization, body);
  let client;
  try {
    client = await resolveClient(auth.clientId);
  } catch {
    return json(401, { error: 'invalid_client' });
  }
  if (!client) return json(401, { error: 'invalid_client' });
  if (client.authMethod !== auth.method) return json(401, { error: 'invalid_client' });
  if (client.authMethod === 'none' && auth.clientSecret) return json(401, { error: 'invalid_client' });
  if (client.authMethod !== 'none' && !secretMatches(auth.clientSecret, client.clientSecretHash)) {
    return json(401, { error: 'invalid_client' });
  }

  const grant = body.get('grant_type');
  const resources = body.getAll('resource');
  if (grant === 'authorization_code') {
    const code = await takeCode(body.get('code'));
    if (!code || code.clientId !== client.clientId || code.redirectUri !== body.get('redirect_uri')) {
      return json(400, { error: 'invalid_grant' });
    }
    if (!pkce(body.get('code_verifier'), code.codeChallenge)) return json(400, { error: 'invalid_grant' });
    if (resources.length !== 1 || !sameResource(resources[0], code.resource) || code.resource !== resourceUrl(origin)) {
      return json(400, { error: 'invalid_grant' });
    }
    return json(200, await issueTokens(client.clientId, code.resource, code.scope), true);
  }

  if (grant === 'refresh_token') {
    const refresh = body.get('refresh_token');
    const row = getToken(refresh);
    if (!row || row.kind !== 'refresh' || row.clientId !== client.clientId) {
      return json(400, { error: 'invalid_grant' });
    }
    if (resources.length > 0 && (resources.length !== 1 || !sameResource(resources[0], row.resource))) {
      return json(400, { error: 'invalid_grant' });
    }
    await deleteToken(refresh);
    return json(200, await issueTokens(client.clientId, row.resource, row.scope), true);
  }

  return json(400, { error: 'unsupported_grant_type' });
}

export async function handleRegister(body) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid_client_metadata' });
  }
  if (!doc || !Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
    return json(400, { error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
  }
  if (!doc.redirect_uris.every(uri => typeof uri === 'string' && redirectAllowed(uri))) {
    return json(400, { error: 'invalid_redirect_uri' });
  }
  const requested = doc.token_endpoint_auth_method || 'none';
  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(requested)) {
    return json(400, { error: 'invalid_client_metadata' });
  }
  const clientId = randomId('c_');
  const secret = requested === 'none' ? null : randomBytes(32).toString('base64url');
  const client = {
    clientId,
    clientName: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 200) : clientId,
    redirectUris: doc.redirect_uris,
    authMethod: requested,
    clientSecretHash: secret ? tokenHash(secret) : null,
  };
  await saveClient(client);
  const response = {
    client_id: clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: requested,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  if (secret) {
    response.client_secret = secret;
    response.client_secret_expires_at = 0;
  }
  return json(201, response);
}

function html(status, text) {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: text };
}

function redirect(location) {
  return { status: 302, headers: { location, 'cache-control': 'no-store' }, body: '' };
}

function json(status, value, noStore = false) {
  const headers = { 'content-type': 'application/json', 'cache-control': noStore ? 'no-store' : 'no-cache' };
  if (noStore) headers.pragma = 'no-cache';
  return { status, headers, body: JSON.stringify(value) };
}

export { formValues };
