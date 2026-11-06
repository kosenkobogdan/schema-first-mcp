# Schema First

A remote MCP server with `memo_write`, `memo_search`, `upload` and `transcribe`. It runs on the Cloudflare Workers free plan, keeps its data in D1 and transcribes with Workers AI. It speaks MCP `2026-07-28` and also `2025-11-25` for older clients.

The live plan page says what the tools do, how sign-in works and what data it keeps: https://schema-first-mcp.rig-pulse-kosenkobogdan.workers.dev/plan

## Connect

    claude mcp add --transport http schema-first --scope user https://schema-first-mcp.rig-pulse-kosenkobogdan.workers.dev/mcp

Then sign in through `/mcp`. Only the owner can approve a client, with the owner passphrase.

## Run your own

Needs Node 22 and a Cloudflare account.

    npm install
    npx wrangler d1 create schema-first        # put the id in wrangler.toml
    npx wrangler d1 migrations apply schema-first --remote
    npx wrangler secret put OWNER_PASSPHRASE
    npx wrangler deploy

## Test

`test/check.js` calls a running server as a stranger would. It leaves test notes and files behind, so point it at a server you can clean.

    BASE=https://your-host PASSPHRASE=... AUDIO_URL=https://.../clip.mp3 npm test
