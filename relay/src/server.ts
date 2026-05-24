// rx-browser-bridge relay
//
// Two roles connect here:
//   - extension (one per browser, persistent WebSocket)
//   - CC-side MCP server (per-tool-call HTTP, long-polls for result)
//
// Bus: POST /enqueue from CC → command goes into in-mem map keyed by
// browser id; extension's WS gets the cmd frame; extension POSTs result
// via WS; relay resolves the long-poll waiter on /poll/:cmd_id.
//
// Auth (POC-level): two static bearer tokens via env.
//   POSTER_TOKEN  required on /enqueue, /poll/*, /browsers
//   PULLER_TOKEN  required on WS upgrade ?token=...
//
// Audit: every cmd + result + register/heartbeat written to sqlite for
// post-hoc inspection.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const POSTER_TOKEN = process.env.POSTER_TOKEN ?? 'dev-poster'
const PULLER_TOKEN = process.env.PULLER_TOKEN ?? 'dev-puller'
const DATA_DIR = process.env.DATA_DIR ?? './data'
const CMD_TTL_MS = 60_000

mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(`${DATA_DIR}/relay.sqlite`)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    browser_id TEXT,
    cmd_id TEXT,
    action TEXT,
    payload TEXT
  );
`)
const insertAudit = db.prepare<[string, string | null, string | null, string | null, string | null]>(
  `INSERT INTO audit(kind, browser_id, cmd_id, action, payload) VALUES (?, ?, ?, ?, ?)`,
)
function audit(kind: string, opts: { browser?: string; cmd?: string; action?: string; payload?: unknown } = {}) {
  try {
    insertAudit.run(
      kind,
      opts.browser ?? null,
      opts.cmd ?? null,
      opts.action ?? null,
      opts.payload !== undefined ? JSON.stringify(opts.payload).slice(0, 4096) : null,
    )
  } catch {}
}

type BrowserRegistration = {
  id: string
  owner: string
  tags: string[]
  current_url?: string
  last_seen: number
  ws: WebSocket
}
const browsers = new Map<string, BrowserRegistration>()

type CmdRecord = {
  id: string
  browser_id: string
  action: string
  args: unknown
  enqueued_at: number
  resolve: (value: { ok: boolean; data?: unknown; error?: string }) => void
}
const pending = new Map<string, CmdRecord>()

function clog(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) {
  const line = { ts: new Date().toISOString(), level, msg, ...extra }
  console.log(JSON.stringify(line))
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function checkPosterAuth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const auth = String(req.headers['authorization'] ?? '')
  return auth === `Bearer ${POSTER_TOKEN}`
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'

  if (method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, browsers: browsers.size, pending: pending.size }))
    return
  }

  if (!checkPosterAuth({ headers: req.headers as Record<string, string | string[] | undefined> })) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  if (method === 'GET' && url.pathname === '/browsers') {
    const list = [...browsers.values()].map((b) => ({
      id: b.id,
      owner: b.owner,
      tags: b.tags,
      current_url: b.current_url,
      last_seen: b.last_seen,
      online: b.ws.readyState === WebSocket.OPEN,
    }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ browsers: list }))
    return
  }

  if (method === 'POST' && url.pathname === '/enqueue') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body: { target?: string; tag?: string; action?: string; args?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad-json' }))
      return
    }

    let target: BrowserRegistration | undefined
    if (body.target) {
      target = browsers.get(body.target)
    } else if (body.tag) {
      target = [...browsers.values()].find(
        (b) => b.tags.includes(body.tag!) && b.ws.readyState === WebSocket.OPEN,
      )
    }
    if (!target || target.ws.readyState !== WebSocket.OPEN) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no-browser-matched', target: body.target ?? body.tag }))
      return
    }
    if (!body.action) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing-action' }))
      return
    }

    const cmd_id = randomUUID()
    const cmd = {
      id: cmd_id,
      browser_id: target.id,
      action: body.action,
      args: body.args ?? {},
      enqueued_at: Date.now(),
    }
    audit('enqueue', { browser: target.id, cmd: cmd_id, action: body.action, payload: body.args })
    target.ws.send(JSON.stringify({ type: 'cmd', id: cmd_id, action: body.action, args: body.args ?? {} }))

    // Wait for result via /poll/:cmd_id (long-poll). Until result arrives,
    // store a resolver keyed by cmd_id. POC: in-mem only.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ cmd_id, browser_id: target.id, enqueued_at: cmd.enqueued_at }))
    pending.set(cmd_id, { ...cmd, resolve: () => {} } as CmdRecord)
    // GC pending records that never get results.
    setTimeout(() => {
      const r = pending.get(cmd_id)
      if (r) {
        pending.delete(cmd_id)
        r.resolve({ ok: false, error: 'timeout' })
      }
    }, CMD_TTL_MS).unref()
    return
  }

  if (method === 'GET' && url.pathname.startsWith('/poll/')) {
    const cmd_id = url.pathname.slice('/poll/'.length)
    const record = pending.get(cmd_id)
    if (!record) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown-cmd-id' }))
      return
    }
    // Long-poll: replace the no-op resolver with one that finishes this response.
    const timer = setTimeout(() => {
      record.resolve = () => {}
      res.writeHead(204).end()
    }, 30_000)
    timer.unref()
    record.resolve = (value) => {
      clearTimeout(timer)
      pending.delete(cmd_id)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not-found' }))
})

const wss = new WebSocketServer({ noServer: true })

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const peer = socket.remoteAddress
  if (url.pathname !== '/ws') {
    clog('warn', 'ws upgrade rejected: bad path', { peer, path: url.pathname })
    socket.destroy()
    return
  }
  const token = url.searchParams.get('token')
  if (token !== PULLER_TOKEN) {
    clog('warn', 'ws upgrade rejected: bad token', { peer, token_len: token?.length ?? 0 })
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  let registered: BrowserRegistration | undefined

  ws.on('message', (raw) => {
    let msg: any
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'bad-json' }))
      return
    }

    if (msg.type === 'register') {
      const reg: BrowserRegistration = {
        id: String(msg.id ?? randomUUID()),
        owner: String(msg.owner ?? 'anon'),
        tags: Array.isArray(msg.tags) ? msg.tags.map(String) : [],
        current_url: msg.current_url ? String(msg.current_url) : undefined,
        last_seen: Date.now(),
        ws,
      }
      // Replace any prior registration with the same id (extension reload).
      const prior = browsers.get(reg.id)
      if (prior && prior.ws !== ws) {
        try { prior.ws.close(4001, 'replaced') } catch {}
      }
      browsers.set(reg.id, reg)
      registered = reg
      audit('register', { browser: reg.id, payload: { owner: reg.owner, tags: reg.tags, current_url: reg.current_url } })
      clog('info', 'browser registered', { id: reg.id, tags: reg.tags, owner: reg.owner })
      ws.send(JSON.stringify({ type: 'registered', id: reg.id }))
      return
    }

    if (!registered) {
      ws.send(JSON.stringify({ type: 'error', code: 'not-registered' }))
      return
    }

    if (msg.type === 'heartbeat') {
      registered.last_seen = Date.now()
      if (msg.current_url) registered.current_url = String(msg.current_url)
      return
    }

    if (msg.type === 'result') {
      const record = pending.get(String(msg.id))
      audit('result', { browser: registered.id, cmd: String(msg.id), payload: { ok: !!msg.ok, data: msg.data, error: msg.error } })
      if (record) {
        record.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error })
      }
      return
    }

    ws.send(JSON.stringify({ type: 'error', code: 'unknown-msg-type', got: msg.type }))
  })

  ws.on('close', (code) => {
    if (registered) {
      audit('disconnect', { browser: registered.id, payload: { code } })
      clog('info', 'browser disconnected', { id: registered.id, code })
      // Only forget if THIS ws is still the registered one (avoids races
      // with extension reload that already replaced it).
      const current = browsers.get(registered.id)
      if (current && current.ws === ws) browsers.delete(registered.id)
    }
  })
})

http.listen(PORT, HOST, () => {
  clog('info', 'relay listening', { host: HOST, port: PORT })
})
