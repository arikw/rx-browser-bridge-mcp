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

let ws = null
let heartbeatTimer = null
let reconnectTimer = null
let reconnectDelay = 1_000
let nextRetryAt = 0
let lastError = null
let everRegistered = false
const auditLog = []
const pendingConfirm = new Map()

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
  auditLog.unshift({ ts: new Date().toISOString(), ...entry })
  if (auditLog.length > 50) auditLog.length = 50
  chrome.storage.session?.set?.({ audit: auditLog })
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function sendResult(id, ok, data, error) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'result', id, ok, data, error }))
  }
  pushAudit({ kind: 'result', id, ok, error })
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

async function dispatchAction(action, args) {
  const tab = await getActiveTab()
  if (!tab?.id) return { ok: false, error: 'no-active-tab' }

  if (action === 'screenshot') {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    return { ok: true, data: { dataUrl, tab_url: tab.url, tab_title: tab.title } }
  }

  if (action === 'navigate') {
    if (!args?.url) return { ok: false, error: 'missing-url' }
    await chrome.tabs.update(tab.id, { url: String(args.url) })
    return { ok: true, data: { url: args.url } }
  }

  if (action === 'new_tab') {
    if (!args?.url) return { ok: false, error: 'missing-url' }
    const created = await chrome.tabs.create({ url: String(args.url), active: args.active !== false })
    return { ok: true, data: { tab_id: created.id, url: created.url ?? args.url, window_id: created.windowId } }
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
    return result ?? { ok: false, error: 'no-script-result' }
  }

  return { ok: false, error: `unknown-action: ${action}` }
}

async function handleCmd(frame) {
  pushAudit({ kind: 'cmd', id: frame.id, action: frame.action, args: frame.args })
  if (isDestructive(frame.action, frame.args)) {
    const allow = await notifyConfirm(frame.action, frame.args)
    if (!allow) {
      sendResult(frame.id, false, undefined, 'user-denied')
      return
    }
  }
  try {
    const result = await dispatchAction(frame.action, frame.args)
    sendResult(frame.id, !!result.ok, result.data, result.error)
  } catch (e) {
    sendResult(frame.id, false, undefined, String(e?.message ?? e))
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
    chrome.storage.local.set({ enabled: false })
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

connect()
