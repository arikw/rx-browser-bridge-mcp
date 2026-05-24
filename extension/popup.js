const urlInput = document.getElementById('relay_url')
let urlDirty = false
urlInput.addEventListener('input', () => { urlDirty = true })

function renderStatus(status) {
  const dot = document.getElementById('dot')
  const text = document.getElementById('status-text')
  const err = document.getElementById('err')
  const state = status?.state ?? 'idle'
  dot.classList.remove('on', 'connecting', 'retrying')
  if (state === 'connected') dot.classList.add('on')
  else if (state === 'connecting') dot.classList.add('connecting')
  else if (state === 'retrying') dot.classList.add('retrying')

  if (state === 'connected') text.textContent = `connected → ${status.relay_url ?? ''}`
  else if (state === 'connecting') text.textContent = `connecting → ${status.relay_url ?? ''}…`
  else if (state === 'retrying') {
    const ms = Math.max(0, (status.next_retry_at ?? 0) - Date.now())
    text.textContent = `disconnected — retrying in ${Math.ceil(ms / 1000)}s`
  }
  else if (state === 'disabled') text.textContent = 'disabled'
  else text.textContent = 'disconnected'

  if (status?.last_error && state !== 'connected') {
    err.textContent = status.last_error
    err.hidden = false
  } else {
    err.hidden = true
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' })
  const toggle = document.getElementById('toggle')
  const nudge = document.getElementById('nudge')
  renderStatus(status)
  const cfg = await chrome.storage.local.get(['enabled', 'relay_url'])
  toggle.textContent = cfg.enabled === false ? 'Enable' : 'Disable'
  nudge.hidden = status?.state === 'connected' || cfg.enabled === false
  if (!urlDirty) urlInput.value = cfg.relay_url ?? 'ws://localhost:3000/ws'
  const audit = document.getElementById('audit')
  audit.innerHTML = ''
  for (const entry of status?.audit ?? []) {
    const row = document.createElement('div')
    row.className = `audit-row ${entry.kind}`
    row.textContent = `${new Date(entry.ts).toLocaleString()}  ${entry.kind}  ${entry.action ?? ''} ${entry.error ?? ''}`
    audit.appendChild(row)
  }
}

document.getElementById('toggle').addEventListener('click', async () => {
  const cfg = await chrome.storage.local.get(['enabled'])
  const next = cfg.enabled === false
  await chrome.runtime.sendMessage({ type: next ? 'enable' : 'kill' })
  setTimeout(refresh, 200)
})

document.getElementById('save-url').addEventListener('click', async () => {
  const value = urlInput.value.trim()
  if (!value) return
  await chrome.storage.local.set({ relay_url: value, enabled: true })
  urlDirty = false
  await chrome.runtime.sendMessage({ type: 'enable' })
  setTimeout(refresh, 200)
})

document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' })
  setTimeout(refresh, 200)
})

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

refresh()
setInterval(refresh, 1500)
