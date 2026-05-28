// End-to-end smoke test for rx-browser-bridge.
//
// Pipe: puppeteer (with extension loaded) → WS → relay → HTTP /enqueue from
// this test (as if from CC's MCP server) → WS cmd → extension → result → WS
// → relay → resolves /poll. Validates the full bus on a single machine.
//
// Requires:
//   - relay built (npm -w relay run build) so dist/server.js exists
//   - puppeteer installed (npm i — root devDep)
//
// Run: npm test

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'node:child_process'
import { createServer, Server as HttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer, { Browser } from 'puppeteer'

const RELAY_PORT = 3399
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`
const RELAY_WS = `ws://127.0.0.1:${RELAY_PORT}/ws`
const PAGE_PORT = 3398
const PAGE_BASE = `http://127.0.0.1:${PAGE_PORT}`
const POSTER = 'test-poster'
const PULLER = 'test-puller'
const BROWSER_ID = 'puppeteer-test'

// Poll until relay returns a 200 result or hits a hard deadline.
// Mirrors what the MCP server does for any tool call.
async function pollUntilResult(cmd_id: string, timeoutMs = 20_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fetch(`${RELAY_BASE}/poll/${cmd_id}`, { headers: { authorization: `Bearer ${POSTER}` } })
    if (r.status === 204) continue
    if (!r.ok) throw new Error(`poll HTTP ${r.status}`)
    return await r.json()
  }
  throw new Error('pollUntilResult timeout')
}

const REPO_ROOT = resolve(import.meta.dirname, '..')
const RELAY_ENTRY = join(REPO_ROOT, 'relay', 'src', 'server.ts')
const EXT_DIR = join(REPO_ROOT, 'extension')

let relayProc: ChildProcess | undefined
let pageServer: HttpServer | undefined
let browser: Browser | undefined
let tmpProfile: string

async function waitFor<T>(fn: () => Promise<T> | T, opts: { timeout?: number; interval?: number } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeout ?? 10_000)
  const interval = opts.interval ?? 200
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw lastErr ?? new Error('waitFor timeout')
}

before(async () => {
  tmpProfile = mkdtempSync(join(tmpdir(), 'rxbb-profile-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'rxbb-data-'))

  // Boot relay via tsx (no separate build step needed for the test).
  relayProc = spawn('npx', ['--yes', 'tsx', RELAY_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(RELAY_PORT),
      HOST: '127.0.0.1',
      POSTER_TOKEN: POSTER,
      PULLER_TOKEN: PULLER,
      DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  await waitFor(async () => {
    const r = await fetch(`${RELAY_BASE}/health`)
    return r.ok
  }, { timeout: 15_000 })

  // Tiny http server for test pages — chrome.scripting.executeScript can't
  // touch data: URLs (manifest host_permissions don't cover that scheme).
  pageServer = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/seed')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>RX SEED</title><body style="background:#1e1e1e;color:#0f0;font:bold 64px monospace"><h1 id=hi>RX TEST</h1></body>')
      return
    }
    if (url.startsWith('/nav')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>RX-NAV</title><h1 id=hi>hello</h1>')
      return
    }
    if (url.startsWith('/tall')) {
      // Five full-viewport bands → ~5 stitched slices for the full-page test.
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        '<!doctype html><title>RX-TALL</title><body style="margin:0">' +
          '<div style="height:100vh;background:#f00"></div>' +
          '<div style="height:100vh;background:#0f0"></div>' +
          '<div style="height:100vh;background:#00f"></div>' +
          '<div style="height:100vh;background:#ff0"></div>' +
          '<div style="height:100vh;background:#0ff" id=bottom>bottom</div></body>',
      )
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => pageServer!.listen(PAGE_PORT, '127.0.0.1', r))

  // Seed extension config before launch by injecting it via launch-time
  // user-data-dir preferences is awkward; instead, just open the options
  // page after launch and use it to set storage.

  browser = await puppeteer.launch({
    headless: true,
    userDataDir: tmpProfile,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  // Find the extension's service worker so we can seed chrome.storage.local
  // directly. In MV3 headless puppeteer, the SW target is reachable via
  // browser.targets() once it spins up.
  const swTarget = await waitFor(async () => {
    const t = browser!.targets().find((t) => t.type() === 'service_worker' && t.url().includes('background.js'))
    return t
  }, { timeout: 45_000 })

  const worker = await swTarget.worker()
  assert.ok(worker, 'extension service worker not reachable')

  await worker.evaluate(
    async (cfg: { relay_url: string; puller_token: string; browser_id: string; owner: string; tags: string[] }) => {
      await chrome.storage.local.set({ ...cfg, enabled: true })
    },
    { relay_url: RELAY_WS, puller_token: PULLER, browser_id: BROWSER_ID, owner: 'test', tags: ['test'] },
  )

  // Trigger reconnect with new config. (chrome.runtime.sendMessage from
  // inside the SW can't deliver to itself, hence the global hook.)
  await worker.evaluate(() => (globalThis as any).__rxbb_reconnect?.())

  // Open a real http page (data: URLs blocked from chrome.scripting).
  const page = await browser.newPage()
  await page.goto(`${PAGE_BASE}/seed`, { waitUntil: 'networkidle0' })

  // Wait for the relay to see our browser register. Generous timeout: headless
  // Chromium cold-start + extension SW spin-up + WS connect can run ~18s on a
  // loaded machine, and a too-tight budget here flakes the whole suite.
  await waitFor(async () => {
    const r = await fetch(`${RELAY_BASE}/browsers`, { headers: { authorization: `Bearer ${POSTER}` } })
    const j = (await r.json()) as { browsers: { id: string; online: boolean }[] }
    return j.browsers.find((b) => b.id === BROWSER_ID && b.online) ? true : false
  }, { timeout: 45_000 })
})

after(async () => {
  try { await browser?.close() } catch {}
  try { relayProc?.kill('SIGTERM') } catch {}
  try { await new Promise<void>((r) => pageServer?.close(() => r())) } catch {}
  try { rmSync(tmpProfile, { recursive: true, force: true }) } catch {}
})

test('relay /health reports browser count', async () => {
  const r = await fetch(`${RELAY_BASE}/health`)
  const j = (await r.json()) as { ok: boolean; browsers: number }
  assert.equal(j.ok, true)
  assert.equal(j.browsers, 1)
})

test('GET /browsers lists the registered extension', async () => {
  const r = await fetch(`${RELAY_BASE}/browsers`, { headers: { authorization: `Bearer ${POSTER}` } })
  const j = (await r.json()) as { browsers: any[] }
  assert.equal(j.browsers.length, 1)
  assert.equal(j.browsers[0].id, BROWSER_ID)
  assert.deepEqual(j.browsers[0].tags, ['test'])
})

test('end-to-end: enqueue screenshot → result delivered', async () => {
  const enq = await fetch(`${RELAY_BASE}/enqueue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${POSTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ target: BROWSER_ID, action: 'screenshot' }),
  })
  assert.equal(enq.ok, true, `enqueue HTTP ${enq.status}`)
  const { cmd_id } = (await enq.json()) as { cmd_id: string }
  assert.match(cmd_id, /^[0-9a-f-]{36}$/)

  const result = await pollUntilResult(cmd_id)
  assert.equal(result.ok, true, `result error: ${result.error}`)
  assert.ok(result.data?.dataUrl?.startsWith('data:image/png;base64,'), 'screenshot dataUrl not png')
  assert.ok((result.data?.dataUrl?.length ?? 0) > 1000, 'screenshot suspiciously small')
})

// PNG dims live in the IHDR chunk: 8-byte signature, 4-byte length, 4-byte
// "IHDR", then width (u32 BE) and height (u32 BE).
function pngSize(dataUrl: string): { width: number; height: number } {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function enqueue(body: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${RELAY_BASE}/enqueue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${POSTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ target: BROWSER_ID, ...body }),
  })
  assert.equal(r.ok, true, `enqueue HTTP ${r.status}`)
  return ((await r.json()) as { cmd_id: string }).cmd_id
}

test('end-to-end: full-page screenshot stitches beyond the viewport', async () => {
  // Point the active tab at a 5-viewport-tall page.
  const navResult = await pollUntilResult(await enqueue({ action: 'navigate', args: { url: `${PAGE_BASE}/tall` } }))
  assert.equal(navResult.ok, true, `navigate error: ${navResult.error}`)
  await new Promise((r) => setTimeout(r, 800))

  // Viewport-only baseline.
  const viewRes = await pollUntilResult(await enqueue({ action: 'screenshot' }))
  assert.equal(viewRes.ok, true, `viewport shot error: ${viewRes.error}`)
  const viewSize = pngSize(viewRes.data.dataUrl)

  // Full-page capture of the same tall page.
  const fullRes = await pollUntilResult(await enqueue({ action: 'screenshot', args: { fullPage: true } }), 30_000)
  assert.equal(fullRes.ok, true, `full-page error: ${fullRes.error}`)
  assert.equal(fullRes.data.full_page, true)
  assert.ok(fullRes.data.slices >= 2, `expected multiple slices, got ${fullRes.data.slices}`)
  const fullSize = pngSize(fullRes.data.dataUrl)

  assert.equal(fullSize.width, viewSize.width, 'full-page width should match the viewport capture')
  assert.ok(
    fullSize.height > viewSize.height * 2,
    `full-page height ${fullSize.height} should exceed 2x the viewport height ${viewSize.height}`,
  )
})

test('end-to-end: navigate + query roundtrip', async () => {
  const nav = await fetch(`${RELAY_BASE}/enqueue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${POSTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      target: BROWSER_ID,
      action: 'navigate',
      args: { url: `${PAGE_BASE}/nav` },
    }),
  })
  const { cmd_id: navId } = (await nav.json()) as { cmd_id: string }
  const navResult = await pollUntilResult(navId)
  assert.equal(navResult.ok, true, `navigate error: ${navResult.error}`)

  // Wait for navigation to settle so query sees the new DOM.
  await new Promise((r) => setTimeout(r, 800))

  const q = await fetch(`${RELAY_BASE}/enqueue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${POSTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ target: BROWSER_ID, action: 'query', args: { selector: '#hi' } }),
  })
  const { cmd_id: qId } = (await q.json()) as { cmd_id: string }
  const qResult = await pollUntilResult(qId)
  assert.equal(qResult.ok, true, `query error: ${qResult.error}`)
  assert.equal(qResult.data?.text, 'hello')
})
