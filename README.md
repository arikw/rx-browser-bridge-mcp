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

## Install

Five steps. Once done, the browser tools are available in **every**
Claude Code session, regardless of which directory you launch from.

The install location is up to you — examples below use
`~/tools/rx-browser-bridge-mcp`. Adjust the absolute path in step 5 to
wherever you actually cloned.

### 1. Clone and build

```bash
git clone https://github.com/arikw/rx-browser-bridge-mcp ~/tools/rx-browser-bridge-mcp
cd ~/tools/rx-browser-bridge-mcp
PUPPETEER_SKIP_DOWNLOAD=true npm install
npm -w mcp run build      # produces mcp/dist/server.js
```

(`PUPPETEER_SKIP_DOWNLOAD=true` skips puppeteer's bundled Chromium —
tests use system chromium at `/usr/bin/chromium`. Drop the flag if you
don't have one.)

### 2. Configure secrets

```bash
cp .env.example .env
# edit .env — set POSTER_TOKEN and PULLER_TOKEN to random values
# (openssl rand -hex 32 each is a good default)
```

The same `.env` is read by all three components — relay, MCP server,
and docker / podman compose. Edit once, applies everywhere.

### 3. Boot the relay

```bash
# Option A — tsx (no build step, foreground)
npm -w relay run dev

# Option B — container via compose (auto-discovers compose.yaml)
cd relay && docker compose up --build       # or: podman compose up --build

# Option C — without compose (flags mirror compose.yaml)
cd relay && docker build -t rx-browser-bridge-relay:dev .
docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 --env-file ../.env \
  -e DATA_DIR=/data -v "$PWD/data:/data" rx-browser-bridge-relay:dev
```

Defaults:
- Listens on `127.0.0.1:3000`
- Audit log at `relay/data/relay.sqlite` (or `/data/relay.sqlite` inside
  the container, bind-mounted to `relay/data/` on the host)

### 4. Load the extension into your browser

- `chrome://extensions` (or your Chromium browser's equivalent) →
  enable "Developer mode" → "Load unpacked" → pick the `extension/`
  directory.
- Open the extension's Options page and fill in:
  - **Relay URL**: `ws://localhost:3000/ws`
  - **Puller token**: paste `PULLER_TOKEN` from `.env`
  - **Browser id**: friendly slug, e.g. `office`
  - **Tags**: comma-separated, e.g. `reddit, hn`

Click the toolbar icon → popup shows connection status, the last 50
audit entries, and a kill switch.

### 5. Register the MCP with Claude Code (user-scope)

So the browser tools load in **every** Claude Code session — not just
when you launch from this project directory — register at user scope.
The recommended setup points Node at the project's `.env` via an
absolute path, so you can rotate tokens by editing one file without
re-registering anything:

```bash
claude mcp add browser-bridge -s user -- \
  node --env-file-if-exists=$HOME/tools/rx-browser-bridge-mcp/.env \
       $HOME/tools/rx-browser-bridge-mcp/mcp/dist/server.js
```

What this does:

- `-s user` writes the registration into your user config
  (`~/.claude.json`), so it loads regardless of CWD.
- `--env-file-if-exists=…/.env` tells Node to load env vars from that
  absolute path on every launch — `POSTER_TOKEN`, `RELAY_URL`, and the
  optional `DEFAULT_TARGET` come from there.
- The trailing `--` separates Claude's flags from the command to spawn.

#### Alternative — env vars baked into the registration

If you'd rather not depend on `.env` (e.g. you want the token in a
secret manager and pulled in at register-time), pass the values
directly with `-e`:

```bash
claude mcp add browser-bridge -s user \
  -e POSTER_TOKEN=your-token-here \
  -e RELAY_URL=http://localhost:3000 \
  -- node $HOME/tools/rx-browser-bridge-mcp/mcp/dist/server.js
```

The downside: you re-run `claude mcp add` every time you rotate.

#### Verify

```bash
claude mcp list             # should show 'browser-bridge'
claude                      # launch from any directory
> list_browsers             # should return the browser you registered
> navigate https://reddit.com on browser "office"
> screenshot
```

#### Other MCP clients

The MCP server is a vanilla `@modelcontextprotocol/sdk` stdio server.
Any MCP-aware client works — point it at
`node /abs/path/to/mcp/dist/server.js` with `POSTER_TOKEN` and
`RELAY_URL` in the env. Common locations:

- **Cursor** — `~/.cursor/mcp.json`
- **Cline** — settings panel → MCP servers
- **Zed**, **Continue**, **Goose**, **Windsurf** — see each client's
  MCP-server docs.

## Quick start (project-local, for development)

If you're hacking on the MCP itself and don't want a user-scope
registration, the repo ships a project-local `.mcp.json` that wires
things up when Claude is launched from this directory:

```bash
cd rx-browser-bridge-mcp
claude --mcp-config ./.mcp.json
```

Same relay / extension setup as steps 3–4 above. Plugin / marketplace
packaging is TBD — see Roadmap.

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
| `screenshot` | `fullPage?`, `target?` / `tag?` | no |
| `navigate` | `url`, `target?` / `tag?` | no |
| `click` | `selector`, `target?` / `tag?` | yes if selector matches submit/post/send |
| `fill` | `selector`, `value`, `target?` / `tag?` | yes if selector mentions password |

`screenshot` captures the visible viewport by default. Pass
`fullPage: true` to capture the entire scrollable page: the extension
scrolls a viewport at a time, captures each step with
`chrome.tabs.captureVisibleTab`, and stitches the slices on an
`OffscreenCanvas` — no `chrome.debugger` / CDP. Caveats: `position:fixed`
/ sticky elements repeat on each slice, lazy content must paint quickly
after each scroll, and very long pages are capped (12 slices) to stay
within the relay's poll budget.

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
