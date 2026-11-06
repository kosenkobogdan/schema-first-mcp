const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa'];

function blockedIpv4(host) {
  const parts = host.split('.').map(Number);
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

// Only global unicast 2000::/3 passes, minus the ranges that wrap another address.
function blockedIpv6(host) {
  const first = host.split(':')[0];
  if (first === '' || !/^[23]/.test(first.padStart(4, '0'))) return true;
  const lower = host.toLowerCase();
  return lower.startsWith('2001:db8') || lower.startsWith('2001:0:') || lower.startsWith('2001::') || lower.startsWith('2002:');
}

export function blockedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host.includes(':')) return blockedIpv6(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return blockedIpv4(host);
  if (!host.includes('.') || host === 'localhost') return true;
  return BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix));
}

export function safeUrl(value, { httpsOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('that is not a valid URL');
  }
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) {
    throw new Error(httpsOnly ? 'the URL must use https' : 'the URL must use http or https');
  }
  if (url.username || url.password) throw new Error('the URL must not hold credentials');
  if (url.port) throw new Error('the URL must use the default port');
  if (blockedHost(url.hostname)) throw new Error('that address is not allowed');
  return url;
}

export async function readLimited(response, maxBytes, tooLarge) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(tooLarge);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(tooLarge);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
