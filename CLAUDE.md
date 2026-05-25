# CLAUDE.md — rx-browser-bridge

Context for any Claude Code session working in this repo.

## What this is

Walking-skeleton POC of a relay-based bridge between a Claude Code
session and a browser extension. Lets CC drive any tab in any browser
the user has open (assuming the extension is loaded + registered with
the relay).

## Three components

1. **`relay/`** — Node HTTP+WS server. In-memory command queue +
   sqlite audit log. Bearer-token auth.
   - Entrypoint: `relay/src/server.ts`
   - Boot dev: `npm -w relay run dev`
   - Build: `npm -w relay run build` → `relay/dist/server.js`
   - Container: `relay/Dockerfile` + `relay/compose.yaml`
     (works under both docker and podman compose).

2. **`mcp/`** — MCP stdio server loaded by CC. Wraps relay HTTP
   endpoints as Claude tools.
   - Entrypoint: `mcp/src/server.ts`
   - Build: `npm -w mcp run build` → `mcp/dist/server.js`
   - Wired into CC via `.mcp.json` at repo root.
   - Tools: `list_browsers`, `screenshot`, `navigate`, `new_tab`,
     `click`, `fill`, `query`.

3. **`extension/`** — Manifest v3 extension. Persistent WS to relay,
   dispatches commands to active tab.
   - Files: `manifest.json`, `background.js`, `popup.{html,js}`,
     `options.{html,js}`, `icons/icon128.png` (1×1 placeholder).
   - Load unpacked into Chrome / Edge / Brave.
   - Config via Options page → `chrome.storage.local`.
   - Test hook: `globalThis.__rxbb_reconnect()` forces re-connect with
     freshly-seeded config (used by puppeteer e2e).

## Wire protocol

```
CC ──POST /enqueue {target|tag, action, args}──▶ relay
   ──GET  /poll/:cmd_id  (long-poll, 30s)──────▶ relay

extension ──WS ws://relay/ws?token=PULLER ──▶ relay
   on connect: {type:"register", id, owner, tags, current_url}
   then:        {type:"heartbeat", current_url}  (every 20s)
   recv:        {type:"cmd", id, action, args}
   reply:       {type:"result", id, ok, data?, error?}
```

Auth: two static bearer tokens via env (`POSTER_TOKEN`, `PULLER_TOKEN`).
POC defaults are `dev-poster` / `dev-puller` — **rotate before exposing
beyond localhost**.

## Environment

Single `.env` at repo root, shared by all three components. Copy from
`.env.example`. Loaded automatically by:

- `npm -w relay run dev|start` — via `node --env-file-if-exists=../.env`
- `mcp/dist/server.js` — via `.mcp.json` `--env-file-if-exists=.env`
- `relay/compose.yaml` — via `env_file: ../.env` (the compose file
  overrides `DATA_DIR=/data` so the mount path is correct inside the
  container regardless of host value)

Vars: `PORT`, `HOST`, `POSTER_TOKEN`, `PULLER_TOKEN`, `DATA_DIR`,
`RELAY_URL`, `DEFAULT_TARGET`.

## Run the tests

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm test
```

`tests/e2e.test.ts` spawns relay on port 3399, launches headless
Chromium with `extension/` loaded, seeds storage via the SW worker
target, registers the browser, exercises screenshot + navigate + query
end-to-end. All four tests should pass in under 5s.

Note: system chromium is used (`/usr/bin/chromium`). Puppeteer's
bundled binary download is skipped via `PUPPETEER_SKIP_DOWNLOAD=true`
at install time.

## Common edits + watch-points

- **Add a new tool**: declare in `TOOLS` array of `mcp/src/server.ts`
  AND add handler in `dispatchAction` of `extension/background.js`.
  Wire types if needed.
- **Mark an action destructive**: extend `isDestructive()` in
  `background.js`. Confirmation popup is a `chrome.notifications`
  with buttons; default-deny after 10s.
- **Add browser-targeting strategy**: extend matching block in
  `/enqueue` handler of `relay/src/server.ts` (currently `target`
  exact-id + `tag` first-match-online).
- **Audit log shape**: `audit(kind, opts)` in `relay/src/server.ts`.
  Sqlite at `relay/data/relay.sqlite`.

## What's intentionally NOT here

- No TLS (relay is HTTP + WS only; user fronts with reverse proxy if
  exposing publicly).
- No multicast / broadcast targeting (single browser per cmd).
- No marketplace plugin packaging yet (use `.mcp.json` for now).
- No icons beyond a 1×1 placeholder.
- No per-domain confirmation policy.

See README §Known POC gaps + §Roadmap for the full list.

## Git

- No version bump for doc-only changes.
