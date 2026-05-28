// Regenerate the extension's globe icons (and a flash-state preview).
//
//   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node scripts/gen-icons.mjs
//
// Renders the same globe glyph the live toolbar draws (extension/background.js)
// to static PNGs:
//   - extension/icons/icon{16,32,48,128}.png  — transparent bg, accent globe
//     (used by the manifest for the toolbar default + extensions page).
//   - flash-preview.png (repo root, gitignored) — a visual of the idle vs.
//     handling-flash states and the connectivity badge colours, for eyeballing
//     the look without loading the unpacked extension.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = join(ROOT, 'extension', 'icons')

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox'],
})
const page = await browser.newPage()

const write = (file, dataUrl) => writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))

// --- Static manifest icons: transparent background, accent globe ------------
const ICON_SIZES = [16, 32, 48, 128]
for (const size of ICON_SIZES) {
  const dataUrl = await page.evaluate((size) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    const c = size / 2, gr = size * 0.34
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = Math.max(1.5, size * 0.09)
    ctx.lineCap = 'round'
    ctx.beginPath(); ctx.arc(c, c, gr, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(c - gr, c); ctx.lineTo(c + gr, c); ctx.stroke()
    ctx.beginPath(); ctx.ellipse(c, c, gr * 0.5, gr, 0, 0, Math.PI * 2); ctx.stroke()
    return canvas.toDataURL('image/png')
  }, size)
  write(join(ICONS, `icon${size}.png`), dataUrl)
  console.log(`wrote icon${size}.png`)
}

// --- Flash-state preview ----------------------------------------------------
const previewUrl = await page.evaluate(() => {
  const W = 620, H = 250
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)

  const globe = (cx, cy, r, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, r * 0.18); ctx.lineCap = 'round'
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke()
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 0.5, r, 0, 0, Math.PI * 2); ctx.stroke()
  }
  const chip = (x, y, s, bg) => {
    ctx.fillStyle = bg; ctx.beginPath()
    ctx.roundRect ? ctx.roundRect(x, y, s, s, s * 0.22) : ctx.rect(x, y, s, s); ctx.fill()
  }
  const label = (text, x, y) => { ctx.fillStyle = '#374151'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text, x, y) }

  ctx.fillStyle = '#111827'; ctx.font = '600 16px system-ui, sans-serif'; ctx.textAlign = 'left'
  ctx.fillText('RX MCP Browser Bridge — toolbar states', 24, 30)

  const S = 72, y = 56
  // idle on a light toolbar
  chip(40, y, S, '#e5e7eb'); globe(40 + S / 2, y + S / 2, S * 0.34, '#38bdf8'); label('idle (light)', 40 + S / 2, y + S + 20)
  // idle on a dark toolbar
  chip(150, y, S, '#1f2937'); globe(150 + S / 2, y + S / 2, S * 0.34, '#38bdf8'); label('idle (dark)', 150 + S / 2, y + S + 20)
  // handling flash
  chip(260, y, S, '#e11d48'); globe(260 + S / 2, y + S / 2, S * 0.34, '#ffffff'); label('handling (flash)', 260 + S / 2, y + S + 20)

  // connectivity badge legend
  ctx.fillStyle = '#111827'; ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'left'
  ctx.fillText('Status badge', 400, y + 6)
  const badges = [
    ['#16a34a', 'connected'], ['#f59e0b', 'connecting'], ['#f97316', 'retrying'],
    ['#ef4444', 'disconnected'], ['#6b7280', 'disabled'],
  ]
  badges.forEach(([color, name], i) => {
    const by = y + 24 + i * 26
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(410, by, 7, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#374151'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'left'
    ctx.fillText(name, 426, by + 4)
  })
  return canvas.toDataURL('image/png')
})
write(join(ROOT, 'flash-preview.png'), previewUrl)
console.log('wrote flash-preview.png')

await browser.close()
