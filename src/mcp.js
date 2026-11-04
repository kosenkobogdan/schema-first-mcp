import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { publicOrigin } from './origin.js';
import { addNote, saveFile, searchNotes } from './store.js';
import { transcribeUrl } from './transcribe.js';

function structured(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeMediaType(mediaType, filename) {
  if (typeof mediaType === 'string' && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mediaType)) {
    return mediaType;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

function buildServer() {
  const server = new McpServer(
    { name: 'schema-first', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool('memo_write', {
    description: 'Save a note and return its id.',
    inputSchema: z.object({
      text: z.string().max(100000).describe('The note text to save.'),
    }),
    outputSchema: z.object({
      id: z.string().describe('Id of the saved note.'),
    }),
  }, async ({ text }) => {
    const note = await addNote(text);
    return structured({ id: note.id });
  });

  server.registerTool('memo_search', {
    description: 'Find notes whose text contains the query. Newest notes come first.',
    inputSchema: z.object({
      query: z.string().max(1000).describe('Text to find inside notes.'),
    }),
    outputSchema: z.object({
      notes: z.array(z.object({
        id: z.string(),
        text: z.string(),
        createdAt: z.string(),
      })),
    }),
  }, async ({ query }) => structured({ notes: searchNotes(query) }));

  server.registerTool('upload', {
    description: 'Store a file on this server and return a public URL that this server serves.',
    inputSchema: z.object({
      filename: z.string().min(1).max(200).describe('File name.'),
      content: z.string().max(15000000).describe('File bytes as utf8 text, or base64 when encoding is base64.'),
      encoding: z.enum(['utf8', 'utf-8', 'base64']).optional().describe('utf8 is the default. Use base64 for binary files.'),
      mediaType: z.string().max(200).optional().describe('Media type, such as text/plain or audio/wav.'),
    }),
    outputSchema: z.object({
      url: z.string(),
    }),
  }, async ({ filename, content, encoding, mediaType }) => {
    const bytes = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    if (bytes.length > 15000000) throw new Error('file is too large');
    const saved = await saveFile({
      filename,
      mediaType: safeMediaType(mediaType, filename),
      bytes,
    });
    return structured({ url: `${publicOrigin()}/files/${saved.id}/${saved.filename}` });
  });

  server.registerTool('transcribe', {
    description: 'Turn audio at an http or https URL into timestamped text. start and end are seconds.',
    inputSchema: z.object({
      url: z.string().min(1).max(2000).describe('http or https URL of an audio file.'),
    }),
    outputSchema: z.object({
      segments: z.array(z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
      })),
    }),
  }, async ({ url }) => structured({ segments: await transcribeUrl(url) }));

  return server;
}

const mcpHandler = createMcpHandler(buildServer);

export function callMcp(request) {
  if (typeof mcpHandler === 'function') return mcpHandler(request);
  if (mcpHandler && typeof mcpHandler.fetch === 'function') return mcpHandler.fetch(request);
  throw new Error('MCP handler has no fetch function');
}
