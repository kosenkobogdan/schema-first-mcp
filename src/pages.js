function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function planPage(origin) {
  const mcp = `${origin}/mcp`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Schema First</title>
  <style>
    body { font: 18px/1.5 Georgia, serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
    h1, h2 { font-family: Palatino, Georgia, serif; line-height: 1.2; }
    code { font-family: ui-monospace, monospace; font-size: 0.9em; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-top: 1px solid #ccc; text-align: left; vertical-align: top; padding: 0.4rem 0.5rem 0.4rem 0; }
  </style>
</head>
<body>
  <h1>Schema First</h1>
  <p>This host is a remote MCP server. The endpoint is <a href="${esc(mcp)}"><code>${esc(mcp)}</code></a>. A call without a token gets <code>401</code> and the protected resource metadata for that endpoint.</p>

  <h2>Tools</h2>
  <table>
    <thead><tr><th>Tool</th><th>What it does</th><th>Input and result</th></tr></thead>
    <tbody>
      <tr>
        <td><code>memo_write</code></td>
        <td>Saves a note on this server.</td>
        <td>Input <code>{ text }</code>. Result <code>{ id }</code>.</td>
      </tr>
      <tr>
        <td><code>memo_search</code></td>
        <td>Finds notes whose text contains the query.</td>
        <td>Input <code>{ query }</code>. Result <code>{ notes: [{ id, text, createdAt }] }</code>. Newest first.</td>
      </tr>
      <tr>
        <td><code>upload</code></td>
        <td>Stores a file on this server and returns a link this server serves. Anyone with the link can open the file.</td>
        <td>Input <code>{ filename, content, encoding? }</code>. <code>encoding</code> is <code>utf8</code> (the default) or <code>base64</code>. Result <code>{ url }</code>.</td>
      </tr>
      <tr>
        <td><code>transcribe</code></td>
        <td>Turns audio at an http or https URL into timestamped text.</td>
        <td>Input <code>{ url }</code>. Result <code>{ segments: [{ start, end, text }] }</code>. <code>start</code> and <code>end</code> are seconds.</td>
      </tr>
    </tbody>
  </table>
  <p>Each tool result is structured content that matches the output schema the tool declares.</p>

  <h2>Sign-in</h2>
  <p>Sign-in is OAuth 2.1 with authorization-code and PKCE (<code>S256</code>). This host is both the resource server and the authorization server.</p>
  <ol>
    <li>The client reads the protected resource metadata, then the authorization server metadata.</li>
    <li>The client identifies itself with a Client ID Metadata Document (an https URL), or registers at <code>/register</code>.</li>
    <li>The client sends the resource owner to <code>/authorize</code> with <code>resource</code> set to <code>${esc(mcp)}</code>.</li>
    <li>The resource owner sees the client name and the redirect host, then approves or denies.</li>
    <li>Only an approved client receives a bearer token. The token is for this MCP endpoint only.</li>
  </ol>
  <p>There is no password. Opening the authorization link and pressing Approve is what lets a client in. Deny, or never opening the link, leaves the client out.</p>

  <h2>What this server keeps</h2>
  <ul>
    <li>Notes from <code>memo_write</code>: an id, the text, and the time. Notes are not public. <code>memo_search</code> is available only with a token.</li>
    <li>Uploaded files: the bytes, the file name, and the media type. The file link is public.</li>
    <li>OAuth clients, one-time approval codes, and token hashes, so sign-in can finish. Raw tokens are not stored. Approval codes are single use.</li>
  </ul>
</body>
</html>`;
}

export function consentPage({ pending, clientName, clientId, redirectUri, scope, resource }) {
  let redirectHost = redirectUri;
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {
    // show the raw value
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Let this client in</title>
  <style>
    body { font: 18px/1.5 Georgia, serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
    button { font: 18px Georgia, serif; margin-right: 0.5rem; padding: 0.4rem 0.8rem; }
    code { font-family: ui-monospace, monospace; font-size: 0.85em; word-break: break-all; }
  </style>
</head>
<body>
  <h1>Let this client in</h1>
  <p><strong>${esc(clientName)}</strong> is asking to call Schema First.</p>
  <ul>
    <li>Client id: <code>${esc(clientId)}</code></li>
    <li>After approval it returns to <code>${esc(redirectHost)}</code></li>
    <li>Scope: <code>${esc(scope)}</code></li>
    <li>Resource: <code>${esc(resource)}</code></li>
  </ul>
  <form method="post" action="/authorize/decision">
    <input type="hidden" name="pending" value="${esc(pending)}">
    <button name="decision" value="approve" type="submit">Approve</button>
    <button name="decision" value="deny" type="submit">Deny</button>
  </form>
</body>
</html>`;
}

export function messagePage(title, text) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>body { font: 18px/1.5 Georgia, serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; }</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p>${esc(text)}</p>
</body>
</html>`;
}
