# rx-browser-bridge

POC for driving any browser tab from a Claude Code session via a
self-hosted relay + MV3 extension.

| | |
|---|---|
| **Status** | v0.1.0 — walking-skeleton POC |
| **Stack** | Node.js ≥ 20, TypeScript, MV3 browser extension |
| **License** | MIT |

## Pieces

```
┌──────────────────┐   HTTP POST /enqueue       ┌──────────────────┐
│ Claude Code      │ ─────────────────────────▶ │                  │
│  ↳ mcp/server.ts │   GET /poll/:cmd_id (long) │     relay/       │
│     (per-tool    │ ◀───────────────────────── │  (Node, sqlite)  │
│      call)       │                            │                  │
└──────────────────┘                            └────────┬─────────┘
                                                         │ WebSocket
                                                         │ ws://relay/ws
                                                         ▼
                                                 ┌──────────────────┐
                                                 │  extension/      │
                                                 │  (MV3, any       │
                                                 │   Chromium browser) │
                                                 └──────────────────┘
```

- **relay/** — Node HTTP+WS server. Accepts CC's POST `/enqueue`,
  routes to extension over WS, returns result via long-poll `/poll`.
  Bearer-token auth (POSTER for CC, PULLER for extension). sqlite for
  audit log.
- **mcp/** — MCP stdio server loaded by Claude Code. Tools:
  `list_browsers`, `screenshot`, `navigate`, `click`, `fill`.
- **extension/** — Manifest v3 extension. Persistent WS to relay,
  dispatches commands to active tab via `chrome.scripting.executeScript`
  + `chrome.tabs.captureVisibleTab`. Notification-based confirmation
  prompt for destructive actions (submit/post/send buttons, password
  fields).

## Quick start (single machine, dev)

### 1. Install deps

```bash
cd /workspace/rx-browser-bridge
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

(System chromium at `/usr/bin/chromium` is used for tests — no need for
puppeteer's bundled binary.)

### 2. Boot relay

```bash
# Option A — tsx (no build step)
npm -w relay run dev

# Option B — docker / podman
cd relay
docker compose up --build      # or: podman-compose up --build
```

Defaults:
- listens on `127.0.0.1:3000`
- `POSTER_TOKEN=dev-poster`, `PULLER_TOKEN=dev-puller`
- audit log at `./data/relay.sqlite`

### 3. Build MCP server

```bash
npm -w mcp run build
```

Produces `mcp/dist/server.js`. `.mcp.json` at repo root points Claude
Code at it. Launch CC from this directory:

```bash
cd /workspace/rx-browser-bridge
claude --mcp-config ./.mcp.json
```

(Plugin form / marketplace publishing TBD — see Roadmap.)

### 4. Load extension into a Chromium browser

- `chrome://extensions` → enable "Developer mode" → "Load unpacked" →
  pick `extension/` directory.
- Open extension Options page:
  - **Relay URL**: `ws://localhost:3000/ws`
  - **Puller token**: `dev-puller`
  - **Browser id**: friendly slug, e.g. `office`
  - **Tags**: comma-separated, e.g. `reddit, hn`

Toolbar icon click → popup shows connection status + audit log + kill
switch.

### 5. Smoke test inside CC

```
> list_browsers
> navigate https://reddit.com on browser "office"
> screenshot
```

## Tests

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm test
```

Spawns a relay on port 3399, launches headless Chromium with the
unpacked extension, registers the browser, exercises the full pipe.

## Command set (current)

| Tool | Args | Destructive? |
|---|---|---|
| `list_browsers` | — | no |
| `screenshot` | `target?` / `tag?` | no |
| `navigate` | `url`, `target?` / `tag?` | no |
| `click` | `selector`, `target?` / `tag?` | yes if selector matches submit/post/send |
| `fill` | `selector`, `value`, `target?` / `tag?` | yes if selector mentions password |

Destructive actions trigger a Chrome notification with Allow / Deny
buttons (10s timeout = deny). Per-domain / per-action trust toggles
NOT yet implemented.

## Targeting

- `target: "office"` — exact browser id, errors if not online.
- `tag: "reddit"` — first online browser carrying the tag.
- No multicast/broadcast (intentional POC scope).

## Security model (POC-level)

- Two-token split: POSTER (CC writes), PULLER (extension reads). One
  leak doesn't grant both directions.
- Tokens via env var. **Rotate the defaults** before exposing publicly.
- Relay binds to `127.0.0.1` by default. Cross-network deploy: front
  with TLS (Caddy / Cloudflare Tunnel / Tailscale Funnel — out of POC
  scope).
- Extension `host_permissions: ["<all_urls>"]` for the walking
  skeleton — tighten to per-domain allowlist for production.
- Audit log captures every register / cmd / result with timestamps.
  Inspect: `sqlite3 relay/data/relay.sqlite "select * from audit order by id desc limit 50"`.

## Known POC gaps

- Single-target only; no broadcast / multicast.
- No TLS layer (relay is plain HTTP + WS).
- No per-domain confirmation policy (only the heuristic match on
  selector text).
- No retry/backpressure on flood-enqueue.
- Extension icons are 1×1 placeholders.
- No tab targeting beyond "active tab in active window" — can't drive
  background tabs.
- MCP plugin not published to a marketplace yet.

## Roadmap

- Plugin packaging (`.claude-plugin/`) so users can `claude plugin
  install rx-browser-bridge@arikw`.
- TLS sidecar (Caddy compose service).
- Per-domain confirmation policy + "trust for 10min" toggle.
- Cross-network deploy guide (Tailscale / Cloudflare Tunnel).
- Tab targeting (URL match, window selector).
- Firefox MV3 manifest variant.

## License

MIT.
