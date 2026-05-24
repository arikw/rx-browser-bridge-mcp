const $ = (id) => document.getElementById(id)

async function load() {
  const cfg = await chrome.storage.local.get([
    'relay_url', 'puller_token', 'browser_id', 'owner', 'tags',
  ])
  $('relay_url').value = cfg.relay_url ?? 'ws://localhost:3000/ws'
  $('puller_token').value = cfg.puller_token ?? ''
  $('browser_id').value = cfg.browser_id ?? ''
  $('owner').value = cfg.owner ?? ''
  $('tags').value = (cfg.tags ?? []).join(', ')
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    relay_url: $('relay_url').value.trim(),
    puller_token: $('puller_token').value,
    browser_id: $('browser_id').value.trim() || crypto.randomUUID(),
    owner: $('owner').value.trim() || 'anon',
    tags: $('tags').value.split(',').map((t) => t.trim()).filter(Boolean),
    enabled: true,
  })
  $('saved-msg').textContent = 'saved — reconnecting'
  chrome.runtime.sendMessage({ type: 'enable' })
  setTimeout(() => { $('saved-msg').textContent = '' }, 2000)
})

load()
