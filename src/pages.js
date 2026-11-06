import { MAX_UPLOAD_BYTES } from './mcp.js';
import { MAX_AUDIO_BYTES } from './transcribe.js';

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 17px/1.55 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
  h1, h2 { line-height: 1.2; }
  code { font-family: ui-monospace, monospace; font-size: 0.9em; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-top: 1px solid #8888; text-align: left; vertical-align: top; padding: 0.45rem 0.6rem 0.45rem 0; }
  input, button { font: inherit; padding: 0.45rem 0.7rem; }
  input { width: 100%; box-sizing: border-box; margin: 0.25rem 0 1rem; }
  button { margin-right: 0.5rem; }
  .problem { color: #c62828; font-weight: 600; }
`;

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function planPage(origin) {
  const mcp = `${origin}/mcp`;
  return layout('Schema First', `
  <h1>Schema First</h1>
  <p>This is a private remote MCP server. Its endpoint is <code>${esc(mcp)}</code>. Only clients the owner approves can use its tools.</p>

  <h2>Tools</h2>
  <table>
    <thead><tr><th>Tool</th><th>What it does</th><th>Input and result</th></tr></thead>
    <tbody>
      <tr><td><code>memo_write</code></td><td>Saves a note.</td><td>Input <code>{ text }</code>. Result <code>{ id }</code>.</td></tr>
      <tr><td><code>memo_search</code></td><td>Finds notes that contain every word of the query, ignoring case, newest first.</td><td>Input <code>{ query }</code>. Result <code>{ notes: [{ id, text, createdAt }] }</code>.</td></tr>
      <tr><td><code>upload</code></td><td>Stores a file of at most ${MAX_UPLOAD_BYTES / 1_000_000} MB and returns a link this server serves. Anyone with the link can open the file.</td><td>Input <code>{ filename, content, encoding?, mediaType? }</code>. <code>encoding</code> is <code>utf8</code> (the default) or <code>base64</code>. Result <code>{ url }</code>.</td></tr>
      <tr><td><code>transcribe</code></td><td>Turns audio of at most ${MAX_AUDIO_BYTES / 1_000_000} MB at a public URL into timestamped text.</td><td>Input <code>{ url }</code>. Result <code>{ segments: [{ start, end, text }] }</code>, with times in seconds.</td></tr>
    </tbody>
  </table>
  <p>Every successful result is structured content that matches the output schema the tool declares. A failed call returns <code>isError: true</code> with a message.</p>

  <h2>Sign-in</h2>
  <p>Sign-in is OAuth 2.1 with the authorization code flow and PKCE (<code>S256</code>). This host is both the resource server and the authorization server.</p>
  <ol>
    <li>A call without a token gets <code>401</code>, which points to the <a href="/.well-known/oauth-protected-resource/mcp">protected resource metadata</a>.</li>
    <li>The client identifies itself with a Client ID Metadata Document, or registers at <code>/register</code>.</li>
    <li>The client sends the owner to <code>/authorize</code> with <code>resource</code> set to <code>${esc(mcp)}</code>.</li>
    <li>The owner reads the client's name and where it returns to, then enters the owner passphrase and approves. Nobody else can approve a client.</li>
    <li>The client gets an access token for this endpoint only. It lasts one hour. A refresh token lasts 30 days and works once.</li>
  </ol>

  <h2>What this server keeps</h2>
  <ul>
    <li><strong>Notes:</strong> id, text and time. Every approved client can read and search them. They are not public.</li>
    <li><strong>Files:</strong> the bytes, file name and media type. Anyone with the link can open a file.</li>
    <li><strong>Sign-in data:</strong> registered clients, and hashes of tokens and approval codes. Raw tokens are not stored.</li>
    <li><strong>Rate counters:</strong> per client and per IP address, deleted within hours.</li>
  </ul>
  <p>Notes and files stay until the owner deletes them. Data is stored in Cloudflare D1.</p>
  <p><strong>Audio:</strong> <code>transcribe</code> downloads the audio from the URL and sends it to Cloudflare Workers AI. This server does not keep the audio or the transcript.</p>
`);
}

export function consentPage({ pending, problem }) {
  let returnsTo = pending.redirectUri;
  try {
    returnsTo = new URL(pending.redirectUri).host;
  } catch {
    // show the raw value
  }
  return layout('Approve this client', `
  <h1>Approve this client</h1>
  <p><strong>${esc(pending.clientName)}</strong> is asking to use the Schema First tools: read and write notes, upload files and transcribe audio.</p>
  <ul>
    <li>Client id: <code>${esc(pending.clientId)}</code></li>
    <li>It returns to: <code>${esc(returnsTo)}</code></li>
  </ul>
  <p>The client chose its own name, so check that you started this sign-in. Only the owner of this server can approve.</p>
  ${problem ? `<p class="problem">${esc(problem)}</p>` : ''}
  <form method="post" action="/authorize/decision">
    <input type="hidden" name="pending" value="${esc(pending.id)}">
    <label for="passphrase">Owner passphrase</label>
    <input id="passphrase" name="passphrase" type="password" autocomplete="current-password">
    <button name="decision" value="approve" type="submit">Approve</button>
    <button name="decision" value="deny" type="submit">Deny</button>
  </form>
`);
}

export function messagePage(title, text) {
  return layout(title, `<h1>${esc(title)}</h1>\n<p>${esc(text)}</p>`);
}
