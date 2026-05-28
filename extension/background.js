// rx-browser-bridge — extension service worker.
//
// Holds a persistent WebSocket to the relay. On connect: sends {register}
// with this browser's id/owner/tags from storage. Receives {cmd} frames,
// dispatches to dispatchAction(), posts {result} back over the same WS.
//
// Destructive actions (click on submit buttons, fill into password inputs)
// gate behind a chrome.notifications confirmation with a per-cmd timeout.

const DEFAULT_RELAY = 'ws://localhost:3000/ws'
const HEARTBEAT_MS = 20_000
const CONFIRM_TIMEOUT_MS = 10_000
const SHOT_THROTTLE_MS = 450      // spacing between captureVisibleTab calls (Chrome rate-limits ~2/sec)
const FULLPAGE_MAX_SLICES = 12    // cap stitched slices so a huge page can't blow the relay poll budget
const FLASH_MIN_MS = 5_000        // keep the action icon flashing ≥5s after each incoming request
const FLASH_INTERVAL_MS = 450     // red↔idle toggle cadence while flashing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws = null
let heartbeatTimer = null
let reconnectTimer = null
let reconnectDelay = 1_000
let nextRetryAt = 0
let lastError = null
let everRegistered = false
const auditLog = []
const pendingConfirm = new Map()

let flashTimer = null
let flashUntil = 0
let flashPhase = false
let inFlight = 0
let idleIconCache = null
let redIconCache = null

function explainClose(code, reason, url) {
  // Browsers fabricate 1006 for any handshake failure (auth, path, refused,
  // server crash) since no proper close frame was received. Without a prior
  // successful registration, that's almost always a setup issue.
  if (code === 1006) {
    if (!everRegistered) {
      return `can't reach relay at ${url} — check it's running, the URL ends in /ws, and the puller token matches the relay's PULLER_TOKEN`
    }
    return `lost connection to ${url} (1006)`
  }
  if (code === 1008) return `relay rejected token (1008) — puller token doesn't match`
  if (code === 4001) return 'replaced by another session with the same browser id'
  if (code === 1011) return `relay error (1011)${reason ? `: ${reason}` : ''}`
  if (code && code !== 1000 && code !== 1001) {
    return `close ${code}${reason ? `: ${reason}` : ''}`
  }
  return null
}

async function loadConfig() {
  const cfg = await chrome.storage.local.get([
    'relay_url', 'puller_token', 'browser_id', 'owner', 'tags', 'enabled',
  ])
  return {
    relay_url: cfg.relay_url || DEFAULT_RELAY,
    puller_token: cfg.puller_token || 'dev-puller',
    browser_id: cfg.browser_id || crypto.randomUUID(),
    owner: cfg.owner || 'anon',
    tags: cfg.tags || [],
    enabled: cfg.enabled !== false,
  }
}

async function persistBrowserId(id) {
  await chrome.storage.local.set({ browser_id: id })
}

function pushAudit(entry) {
  const row = { ts: new Date().toISOString(), ...entry }
  auditLog.unshift(row)
  if (auditLog.length > 50) auditLog.length = 50
  chrome.storage.session?.set?.({ audit: auditLog })
  return row
}

// Tabs we never want to auto-target: the extension's own pages, chrome://,
// devtools, the Web Store, etc. (scripting/capture is blocked there anyway).
const SKIP_TAB = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/

function hostOf(url) {
  try { return new URL(url).hostname || url } catch { return undefined }
}

// The default tab when no explicit tabId is given: the active tab of the
// last-focused window, skipping non-drivable tabs (so it never lands on this
// extension's own popup/options page). Falls back to any window's active web tab.
async function getActiveTab() {
  let cands = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  let tab = cands.find((t) => t.url && !SKIP_TAB.test(t.url))
  if (tab) return tab
  cands = await chrome.tabs.query({ active: true })
  tab = cands.find((t) => t.url && !SKIP_TAB.test(t.url))
  return tab || cands[0]
}

// Resolve the tab a command targets: an explicit args.tabId, else the default
// active tab. Returns null if a requested tabId no longer exists.
async function resolveTab(args) {
  if (args && args.tabId != null) {
    try { return await chrome.tabs.get(Number(args.tabId)) } catch { return null }
  }
  return await getActiveTab()
}

function sendResult(id, ok, data, error, host) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'result', id, ok, data, error }))
  }
  pushAudit({ kind: 'result', id, ok, error, host })
}

async function notifyConfirm(action, args) {
  return new Promise((resolve) => {
    const notifId = `confirm-${Date.now()}-${Math.random()}`
    const summary = `Action: ${action}\n${JSON.stringify(args).slice(0, 180)}`
    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'rx-browser-bridge confirmation',
      message: summary,
      requireInteraction: true,
      buttons: [{ title: 'Allow' }, { title: 'Deny' }],
    })
    const timer = setTimeout(() => {
      pendingConfirm.delete(notifId)
      chrome.notifications.clear(notifId)
      resolve(false)
    }, CONFIRM_TIMEOUT_MS)
    pendingConfirm.set(notifId, { resolve, timer })
  })
}

chrome.notifications.onButtonClicked?.addListener?.((notifId, buttonIdx) => {
  const entry = pendingConfirm.get(notifId)
  if (!entry) return
  clearTimeout(entry.timer)
  pendingConfirm.delete(notifId)
  chrome.notifications.clear(notifId)
  entry.resolve(buttonIdx === 0)
})

chrome.notifications.onClosed?.addListener?.((notifId) => {
  const entry = pendingConfirm.get(notifId)
  if (!entry) return
  clearTimeout(entry.timer)
  pendingConfirm.delete(notifId)
  entry.resolve(false)
})

function isDestructive(action, args) {
  if (action === 'click' && args?.selector) {
    const s = String(args.selector).toLowerCase()
    if (s.includes('submit') || s.includes('post') || s.includes('send')) return true
  }
  if (action === 'fill' && args?.selector) {
    const s = String(args.selector).toLowerCase()
    if (s.includes('password')) return true
  }
  return false
}

// Capture the visible tab, retrying through Chrome's captureVisibleTab
// rate-limit (~2 calls/sec) with backoff.
async function captureVisible(windowId) {
  let delay = 600
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (/quota|MAX_CAPTURE/i.test(msg) && attempt < 5) {
        await sleep(delay)
        delay = Math.min(delay * 1.5, 2_000)
        continue
      }
      throw e
    }
  }
  throw new Error('captureVisibleTab: rate-limit retries exhausted')
}

async function runInTab(tabId, func, args = []) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return result
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

// Full-page screenshot: scroll the active tab a viewport at a time, capture
// each step, stitch the slices onto an OffscreenCanvas. Stays within the
// extension's existing permissions (no chrome.debugger / CDP). Known limits:
// position:fixed / sticky elements repeat on each slice, and lazy content has
// to paint within SHOT_THROTTLE_MS of the scroll to land in the capture.
async function captureFullPage(tab) {
  const metrics = await runInTab(tab.id, () => ({
    full: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.clientHeight,
    ),
    view: window.innerHeight,
    origX: window.scrollX,
    origY: window.scrollY,
  }))
  if (!metrics || !metrics.view) return { ok: false, error: 'page-metrics-failed' }

  const step = Math.max(1, metrics.view)
  const slices = Math.min(Math.ceil(metrics.full / step), FULLPAGE_MAX_SLICES)

  let canvas = null
  let ctx = null
  let lastY = -1
  for (let i = 0; i < slices; i++) {
    const actualY = await runInTab(tab.id, (y) => { window.scrollTo(0, y); return window.scrollY }, [i * step])
    await sleep(SHOT_THROTTLE_MS)
    const dataUrl = await captureVisible(tab.windowId)
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob())
    const dpr = bmp.height / metrics.view
    if (!canvas) {
      canvas = new OffscreenCanvas(bmp.width, Math.round(metrics.full * dpr))
      ctx = canvas.getContext('2d')
    }
    ctx.drawImage(bmp, 0, Math.round((actualY ?? i * step) * dpr))
    if (bmp.close) bmp.close()
    if (actualY <= lastY) break    // can't scroll further — bottom reached
    lastY = actualY
  }

  await runInTab(tab.id, (x, y) => window.scrollTo(x, y), [metrics.origX, metrics.origY])
  if (!canvas) return { ok: false, error: 'no-slices-captured' }

  const dataUrl = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }))
  return {
    ok: true,
    data: {
      dataUrl,
      tab_url: tab.url,
      tab_title: tab.title,
      full_page: true,
      slices,
      truncated: metrics.full > step * FULLPAGE_MAX_SLICES,
    },
  }
}

// Run arbitrary JS in the active tab, return the JSON-encoded result.
// Prefers the userScripts world: its CSP can be set to allow eval and it is
// exempt from the page's CSP, so this works even on CSP-locked sites like
// GitHub — provided the user has flipped the "Allow user scripts" toggle on the
// extension card. Falls back to MAIN-world scripting (works only where the
// page's own CSP permits unsafe-eval) when userScripts is unavailable.
async function runEvaluate(tab, code) {
  if (chrome.userScripts?.execute) {
    try {
      try {
        await chrome.userScripts.configureWorld({ csp: "script-src 'self' 'unsafe-eval'", messaging: false })
      } catch {}
      const wrapped = `(() => {
        try {
          var v = (0, eval)(${JSON.stringify(code)});
          var value; try { value = (v === undefined) ? 'undefined' : JSON.stringify(v) } catch (e) { value = String(v) }
          return { ok: true, value: (value === undefined ? String(v) : value), type: typeof v };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
      })()`
      const res = await chrome.userScripts.execute({
        target: { tabId: tab.id },
        world: 'USER_SCRIPT',
        injectImmediately: true,
        js: [{ code: wrapped }],
      })
      const r = res && res[0] && res[0].result
      if (r) {
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, data: { value: r.value, type: r.type, world: 'user_script' } }
      }
    } catch (e) {
      // userScripts not enabled / too old — fall through to MAIN.
    }
  }

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [code],
    func: async (src) => {
      try {
        let v = (0, eval)(src)
        if (v && typeof v.then === 'function') v = await v
        let value
        try { value = v === undefined ? 'undefined' : JSON.stringify(v) } catch { value = String(v) }
        return { ok: true, value: value ?? String(v), type: typeof v }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    },
  })
  if (!result) return { ok: false, error: 'no-script-result' }
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: { value: result.value, type: result.type, world: 'main' } }
}

async function dispatchAction(action, args) {
  // Actions that don't operate on a pre-existing tab.
  if (action === 'list_tabs') {
    const cur = await getActiveTab()   // same resolution the default targeting uses
    const tabs = await chrome.tabs.query({})
    const list = tabs
      .filter((t) => t.url && !SKIP_TAB.test(t.url))
      .map((t) => ({ tab_id: t.id, window_id: t.windowId, active: t.active, current: t.id === cur?.id, host: hostOf(t.url), url: t.url, title: t.title }))
    return { ok: true, data: { tabs: list, current_tab_id: cur?.id } }
  }

  if (action === 'new_tab') {
    if (!args?.url) return { ok: false, error: 'missing-url' }
    const created = await chrome.tabs.create({ url: String(args.url), active: args.active !== false })
    const url = created.url ?? args.url
    return { ok: true, data: { tab_id: created.id, url, window_id: created.windowId }, host: hostOf(url) }
  }

  // Everything else acts on a specific tab (args.tabId) or the active tab.
  const tab = await resolveTab(args)
  if (!tab?.id) return { ok: false, error: args?.tabId != null ? 'tab-not-found' : 'no-active-tab' }
  const host = hostOf(tab.url)
  // Echo which tab we resolved to, so the agent can capture the id and reuse it
  // (pass it back as tabId) to stay on this tab across later turns.
  const meta = { tab_id: tab.id, window_id: tab.windowId, host }

  if (action === 'screenshot') {
    // captureVisibleTab only sees a window's *visible* tab, so bring the target
    // tab to the front first (the user has OK'd this focus flip).
    if (!tab.active) {
      try {
        await chrome.tabs.update(tab.id, { active: true })
        await chrome.windows.update(tab.windowId, { focused: true })
        await sleep(200)
      } catch {}
    }
    if (args?.fullPage) {
      const r = await captureFullPage(tab)
      r.host = host
      if (r.data) Object.assign(r.data, meta)
      return r
    }
    const dataUrl = await captureVisible(tab.windowId)
    return { ok: true, data: { dataUrl, tab_url: tab.url, tab_title: tab.title, ...meta }, host }
  }

  if (action === 'navigate') {
    if (!args?.url) return { ok: false, error: 'missing-url' }
    await chrome.tabs.update(tab.id, { url: String(args.url) })
    const destHost = hostOf(args.url)
    return { ok: true, data: { url: args.url, tab_id: tab.id, window_id: tab.windowId, host: destHost }, host: destHost }
  }

  if (action === 'evaluate') {
    const code = String(args?.code ?? '')
    if (!code) return { ok: false, error: 'missing-code' }
    const r = await runEvaluate(tab, code)
    r.host = host
    if (r.data) Object.assign(r.data, meta)
    return r
  }

  if (action === 'query' || action === 'click' || action === 'fill') {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (action, args) => {
        if (action === 'query') {
          const el = document.querySelector(args.selector)
          if (!el) return { ok: false, error: 'no-match' }
          return {
            ok: true,
            data: {
              tag: el.tagName,
              text: el.textContent?.slice(0, 1000),
              value: 'value' in el ? el.value : undefined,
              attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
            },
          }
        }
        if (action === 'click') {
          const el = document.querySelector(args.selector)
          if (!el) return { ok: false, error: 'no-match' }
          el.click()
          return { ok: true, data: { clicked: args.selector } }
        }
        if (action === 'fill') {
          const el = document.querySelector(args.selector)
          if (!el) return { ok: false, error: 'no-match' }
          const setter = Object.getOwnPropertyDescriptor(
            el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value',
          )?.set
          if (setter) setter.call(el, args.value)
          else el.value = args.value
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return { ok: true, data: { filled: args.selector } }
        }
        return { ok: false, error: 'unknown-action' }
      },
      args: [action, args ?? {}],
      world: 'MAIN',
    })
    const out = result ?? { ok: false, error: 'no-script-result' }
    out.host = host
    if (out.data) Object.assign(out.data, meta)
    return out
  }

  return { ok: false, error: `unknown-action: ${action}` }
}

// --- Toolbar indicator ------------------------------------------------------
// The action button carries two independent signals:
//   • a status badge whose colour tracks the relay connection (green=connected,
//     amber=connecting, orange=retrying, red=disconnected, grey=disabled), and
//   • a red flash of the globe icon while the bridge is handling a request — an
//     out-of-band cue that something is driving the browser right now.
// Each incoming request arms the flash for ≥FLASH_MIN_MS, held while any request
// is in flight (a full-page screenshot can run for many seconds). Every
// chrome.action call is guarded — a failure here must never break dispatch.

// Globe glyph. Kept in sync with scripts/gen-icons.mjs, which renders the same
// shape to the static PNGs in the manifest. Idle is a transparent-background
// accent globe (adapts to any toolbar theme); the handling flash is a bold red
// filled tile so the activity cue is unmistakable.
function drawGlobe(ctx, size, color) {
  const c = size / 2, gr = size * 0.34
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1.5, size * 0.09)
  ctx.lineCap = 'round'
  ctx.beginPath(); ctx.arc(c, c, gr, 0, Math.PI * 2); ctx.stroke()                  // sphere
  ctx.beginPath(); ctx.moveTo(c - gr, c); ctx.lineTo(c + gr, c); ctx.stroke()       // equator
  ctx.beginPath(); ctx.ellipse(c, c, gr * 0.5, gr, 0, 0, Math.PI * 2); ctx.stroke() // meridian
}

function buildIcon(red) {
  const out = {}
  for (const size of [16, 32]) {
    const ctx = new OffscreenCanvas(size, size).getContext('2d')
    if (red) {
      ctx.fillStyle = '#e11d48'
      ctx.beginPath()
      if (ctx.roundRect) ctx.roundRect(0, 0, size, size, Math.round(size * 0.22))
      else ctx.rect(0, 0, size, size)
      ctx.fill()
      drawGlobe(ctx, size, '#ffffff')
    } else {
      drawGlobe(ctx, size, '#38bdf8')      // transparent background, accent globe
    }
    out[size] = ctx.getImageData(0, 0, size, size)
  }
  return out
}

function idleIcon() { try { return (idleIconCache ??= buildIcon(false)) } catch { return null } }
function redIcon() { try { return (redIconCache ??= buildIcon(true)) } catch { return null } }

function setActionIcon(red) {
  try {
    const imageData = red ? redIcon() : idleIcon()
    if (imageData) chrome.action.setIcon({ imageData })
  } catch {}
}

function badgeForState(state) {
  switch (state) {
    case 'connected':  return { text: '●', color: '#16a34a' }   // green
    case 'connecting': return { text: '●', color: '#f59e0b' }   // amber
    case 'retrying':   return { text: '●', color: '#f97316' }   // orange
    case 'disabled':   return { text: '○', color: '#6b7280' }   // grey
    default:           return { text: '●', color: '#ef4444' }   // red — idle/disconnected
  }
}

// Reflect the live connection status on the badge (and, when not mid-flash, the
// tooltip). Called on every connection-state transition.
async function applyStatus() {
  let enabled = true
  try { ({ enabled = true } = await chrome.storage.local.get('enabled')) } catch {}
  const state = deriveState(enabled)
  const b = badgeForState(state)
  try {
    chrome.action.setBadgeText({ text: b.text })
    chrome.action.setBadgeBackgroundColor({ color: b.color })
    if (!flashTimer) chrome.action.setTitle({ title: `RX MCP Browser Bridge — ${state}` })
  } catch {}
}

function flashTick() {
  if (inFlight > 0 || Date.now() < flashUntil) {
    flashPhase = !flashPhase
    setActionIcon(flashPhase)
  } else {
    stopFlashing()
  }
}

function stopFlashing() {
  if (flashTimer) { clearInterval(flashTimer); flashTimer = null }
  flashPhase = false
  setActionIcon(false)
  applyStatus()                      // restore the idle tooltip + status badge
}

function beginActivity(action) {
  inFlight += 1
  flashUntil = Math.max(flashUntil, Date.now() + FLASH_MIN_MS)
  try { chrome.action.setTitle({ title: `RX MCP Browser Bridge — handling: ${action ?? 'request'}` }) } catch {}
  if (!flashTimer) {
    flashPhase = true
    setActionIcon(true)              // go red immediately, don't wait a tick
    flashTimer = setInterval(flashTick, FLASH_INTERVAL_MS)
  }
}

function endActivity() {
  if (inFlight > 0) inFlight -= 1
  // No stop here: flashTick keeps flashing until inFlight==0 AND the ≥5s window
  // since the last request has elapsed, so brief commands still flash for 5s.
}

async function handleCmd(frame) {
  const entry = pushAudit({ kind: 'cmd', id: frame.id, action: frame.action, args: frame.args })
  beginActivity(frame.action)
  try {
    if (isDestructive(frame.action, frame.args)) {
      const allow = await notifyConfirm(frame.action, frame.args)
      if (!allow) {
        sendResult(frame.id, false, undefined, 'user-denied')
        return
      }
    }
    try {
      const result = await dispatchAction(frame.action, frame.args)
      if (result?.host) entry.host = result.host   // surface the affected hostname in the popup log
      sendResult(frame.id, !!result.ok, result.data, result.error, result?.host)
    } catch (e) {
      sendResult(frame.id, false, undefined, String(e?.message ?? e))
    }
  } finally {
    endActivity()
  }
}

async function connect() {
  const cfg = await loadConfig()
  if (!cfg.enabled) return

  // Tear down any prior socket without letting its close handler reschedule.
  if (ws) {
    const old = ws
    ws = null
    try { old.close() } catch {}
  }

  await persistBrowserId(cfg.browser_id)
  const url = `${cfg.relay_url}?token=${encodeURIComponent(cfg.puller_token)}`

  let mine
  try {
    mine = new WebSocket(url)
  } catch (e) {
    scheduleReconnect()
    return
  }
  ws = mine
  applyStatus()                      // 'connecting'

  // All handlers guard `ws === mine` so stale callbacks from a replaced
  // socket can't trigger reconnect cascades or stomp current state.
  mine.addEventListener('open', async () => {
    if (ws !== mine) return
    reconnectDelay = 1_000
    lastError = null
    const tab = await getActiveTab()
    mine.send(JSON.stringify({
      type: 'register',
      id: cfg.browser_id,
      owner: cfg.owner,
      tags: cfg.tags,
      current_url: tab?.url,
    }))
    pushAudit({ kind: 'connected', relay: cfg.relay_url, browser_id: cfg.browser_id })
    applyStatus()                    // 'connected'
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(async () => {
      if (ws !== mine || mine.readyState !== WebSocket.OPEN) return
      const tab = await getActiveTab()
      mine.send(JSON.stringify({ type: 'heartbeat', current_url: tab?.url }))
    }, HEARTBEAT_MS)
  })

  mine.addEventListener('message', (ev) => {
    if (ws !== mine) return
    let frame
    try { frame = JSON.parse(ev.data) } catch { return }
    if (frame.type === 'cmd') handleCmd(frame)
    if (frame.type === 'registered') {
      everRegistered = true
      pushAudit({ kind: 'registered', id: frame.id })
    }
  })

  mine.addEventListener('close', (ev) => {
    pushAudit({ kind: 'disconnected', code: ev.code, reason: ev.reason })
    if (ws !== mine) return
    const explained = explainClose(ev.code, ev.reason, cfg.relay_url)
    if (explained) lastError = explained
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    ws = null
    scheduleReconnect()
  })

  mine.addEventListener('error', () => {
    if (ws !== mine) return
    if (!everRegistered) {
      lastError = `can't reach relay at ${cfg.relay_url} — check it's running and the URL is correct`
    }
  })
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  nextRetryAt = Date.now() + reconnectDelay
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    nextRetryAt = 0
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  applyStatus()                      // 'retrying'
}

function deriveState(enabled) {
  if (enabled === false) return 'disabled'
  if (ws?.readyState === WebSocket.OPEN) return 'connected'
  if (ws?.readyState === WebSocket.CONNECTING) return 'connecting'
  if (reconnectTimer) return 'retrying'
  return 'idle'
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'get-status') {
    chrome.storage.local.get(['enabled', 'relay_url']).then((cfg) => {
      const state = deriveState(cfg.enabled)
      sendResponse({
        state,
        connected: state === 'connected',
        relay_url: cfg.relay_url,
        next_retry_at: nextRetryAt || null,
        last_error: lastError,
        audit: auditLog.slice(0, 20),
      })
    })
    return true
  }
  if (msg?.type === 'kill') {
    chrome.storage.local.set({ enabled: false }).then(applyStatus)
    try { ws?.close() } catch {}
    return false
  }
  if (msg?.type === 'enable') {
    chrome.storage.local.set({ enabled: true })
    lastError = null
    try { ws?.close() } catch {}
    connect()
    return false
  }
  if (msg?.type === 'reconnect') {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    nextRetryAt = 0
    reconnectDelay = 1_000
    lastError = null
    try { ws?.close() } catch {}
    chrome.storage.local.set({ enabled: true })
    connect()
    return false
  }
  return false
})

// Test/dev hook: lets the puppeteer harness force a reconnect with the
// freshly-seeded config (since chrome.runtime.sendMessage from inside the
// SW can't deliver to itself).
globalThis.__rxbb_reconnect = () => {
  try { ws?.close() } catch {}
  scheduleReconnect()
}

setActionIcon(false)   // globe icon from the start
applyStatus()          // and an initial status badge
connect()
