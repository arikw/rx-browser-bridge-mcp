// rx-browser-bridge MCP server (CC-side).
//
// Exposes browser-control tools to Claude. Each tool call POSTs to the
// relay's /enqueue, then long-polls /poll/:cmd_id until the extension
// returns a result (or 30s timeout, surfaced as tool error).
//
// Config via env (loaded from root .env by .mcp.json):
//   RELAY_URL       default http://localhost:3000
//   POSTER_TOKEN    required, must match relay's POSTER_TOKEN
//   DEFAULT_TARGET  optional default browser id

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const RELAY_URL = (process.env.RELAY_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const POSTER_TOKEN = process.env.POSTER_TOKEN ?? 'dev-poster'
const DEFAULT_TARGET = process.env.DEFAULT_TARGET || undefined
const POLL_TIMEOUT_MS = 30_000

async function relayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${RELAY_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${POSTER_TOKEN}`,
      'content-type': 'application/json',
    },
  })
}

async function enqueue(target: string | undefined, tag: string | undefined, action: string, args: unknown) {
  const body = { target, tag, action, args }
  const resp = await relayFetch('/enqueue', { method: 'POST', body: JSON.stringify(body) })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`enqueue failed: HTTP ${resp.status} ${text}`)
  }
  const j = (await resp.json()) as { cmd_id: string; browser_id: string }
  return j
}

async function poll(cmd_id: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  // Long-poll: relay holds up to 30s. Repeat until 200 or unknown-cmd-id.
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const resp = await relayFetch(`/poll/${encodeURIComponent(cmd_id)}`)
    if (resp.status === 204) continue
    if (resp.status === 404) return { ok: false, error: 'cmd-id-unknown' }
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`poll failed: HTTP ${resp.status} ${text}`)
    }
    return (await resp.json()) as { ok: boolean; data?: unknown; error?: string }
  }
  return { ok: false, error: 'mcp-poll-timeout' }
}

async function runTool(action: string, params: Record<string, unknown>) {
  const target = (params.target as string | undefined) ?? DEFAULT_TARGET
  const tag = params.tag as string | undefined
  const args = { ...params }
  delete (args as any).target
  delete (args as any).tag
  const { cmd_id, browser_id } = await enqueue(target, tag, action, args)
  const result = await poll(cmd_id)
  return { browser_id, ...result }
}

const mcp = new Server(
  { name: 'rx-browser-bridge', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      "These tools drive the user's OWN already-open browser (their real session, " +
      'cookies, logins, and extensions) through a loaded browser extension, via a relay. ' +
      'Prefer them whenever the user refers to their live browser — e.g. "my browser", ' +
      '"the current tab/page", "the site I\'m on", "what I\'m looking at", "open X in my browser". ' +
      'Do NOT use a fresh-browser automation server (playwright, puppeteer, chrome-devtools) for ' +
      "those references — those spawn an isolated browser with none of the user's state. Reserve " +
      'fresh-browser tools for explicit clean-room / throwaway-browser requests. Call list_browsers ' +
      "first to see which of the user's browsers are connected and pick a target (by id or tag). " +
      'When the user refers to a specific tab among several (and especially with multiple windows open, ' +
      'where the "active tab" is just whatever window was last focused), call list_tabs, remember the ' +
      'relevant tab_id, and pass it as tabId on subsequent calls so each action hits that exact tab. ' +
      'Every action returns the tab_id it acted on, and list_tabs marks the current tab (current:true / ' +
      'current_tab_id). So once the user starts talking about a tab — including "the current tab" — ' +
      'capture that tab_id from the first result and reuse it as tabId on the follow-up actions in the ' +
      'same conversation, so the thread stays pinned to that tab even if window focus later changes.',
  },
)

const TOOLS = [
  {
    name: 'list_browsers',
    description: 'List browsers currently registered with the relay (id, tags, current_url, online status).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tabs',
    description: "List the open tabs on the target browser: tab_id, host, url, title, window_id, active. Excludes the extension's own pages and chrome:// pages. Find a tab_id here, then pass it as tabId to other tools to act on that exact tab regardless of which window is focused.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Browser id. If omitted, RX_BROWSER_DEFAULT_TARGET is used.' },
        tag: { type: 'string', description: 'Alternative to target: first online browser matching this tag.' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the active tab on the target browser as a PNG. By default captures the visible viewport; pass fullPage:true to scroll-and-stitch the entire scrollable page.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Browser id. If omitted, RX_BROWSER_DEFAULT_TARGET is used.' },
        tag: { type: 'string', description: 'Alternative to target: first online browser matching this tag.' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page (scroll-and-stitch) instead of just the visible viewport. Default false. Sticky/fixed elements may repeat across slices; very long pages are capped.' },
        tabId: { type: 'number', description: "Capture this exact tab id (from list_tabs or new_tab). It is briefly activated first, since only a window's visible tab can be captured. Omit to use the active tab." },
      },
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the active tab of the target browser to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL (https://…).' },
        target: { type: 'string' },
        tag: { type: 'string' },
        tabId: { type: 'number', description: 'Navigate this exact tab id (from list_tabs or new_tab) instead of the active tab.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click the element matching the CSS selector in the active tab. Submit/post/send buttons trigger an extension confirmation popup.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector.' },
        target: { type: 'string' },
        tag: { type: 'string' },
        tabId: { type: 'number', description: 'Act on this exact tab id (from list_tabs or new_tab) instead of the active tab.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'fill',
    description: 'Set the value of an <input> or <textarea> matching the CSS selector. Dispatches input+change events. Password fields trigger an extension confirmation popup.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string' },
        target: { type: 'string' },
        tag: { type: 'string' },
        tabId: { type: 'number', description: 'Act on this exact tab id (from list_tabs or new_tab) instead of the active tab.' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'new_tab',
    description: 'Open a URL in a new tab on the target browser. Returns the created tab id and window id. The new tab becomes the active tab unless active=false.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL.' },
        active: { type: 'boolean', description: 'Focus the new tab. Default true.' },
        target: { type: 'string' },
        tag: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'query',
    description: 'Read the first element matching the CSS selector on the active tab. Returns its tag, text content (truncated), value (for inputs), and attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        target: { type: 'string' },
        tag: { type: 'string' },
        tabId: { type: 'number', description: 'Read from this exact tab id (from list_tabs or new_tab) instead of the active tab.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'evaluate',
    description: 'Run arbitrary JavaScript in the active tab for complex DOM reads/interactions beyond click/fill/query. The final expression value is returned JSON-encoded. Runs in the extension userScripts world (works even on CSP-locked sites like GitHub when the extension\'s "Allow user scripts" toggle is on); otherwise falls back to the page MAIN world, which a page CSP that forbids unsafe-eval will block.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript source. Its final expression value (or a Promise it resolves to) is returned, JSON-encoded.' },
        target: { type: 'string' },
        tag: { type: 'string' },
        tabId: { type: 'number', description: 'Run in this exact tab id (from list_tabs or new_tab) instead of the active tab.' },
      },
      required: ['code'],
    },
  },
] as const

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (name === 'list_browsers') {
    const resp = await relayFetch('/browsers')
    const j = await resp.json()
    return { content: [{ type: 'text' as const, text: JSON.stringify(j, null, 2) }] }
  }

  if (!['screenshot', 'navigate', 'click', 'fill', 'new_tab', 'query', 'evaluate', 'list_tabs'].includes(name)) {
    return {
      content: [{ type: 'text' as const, text: `unknown tool: ${name}` }],
      isError: true,
    }
  }

  const result = await runTool(name, args)
  if (!result.ok) {
    return {
      content: [{ type: 'text' as const, text: `error: ${result.error ?? 'unknown'}` }],
      isError: true,
    }
  }

  // screenshot returns a dataUrl — render as image content alongside metadata.
  if (name === 'screenshot') {
    const data = result.data as
      | { dataUrl?: string; tab_url?: string; tab_title?: string; full_page?: boolean; slices?: number; truncated?: boolean }
      | undefined
    const content: any[] = []
    if (data?.dataUrl) {
      const m = data.dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
      if (m) {
        content.push({ type: 'image', data: m[2], mimeType: m[1] })
      }
    }
    content.push({
      type: 'text',
      text: JSON.stringify({
        browser_id: result.browser_id,
        tab_url: data?.tab_url,
        tab_title: data?.tab_title,
        ...(data?.full_page ? { full_page: true, slices: data.slices, truncated: data.truncated } : {}),
      }),
    })
    return { content }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  }
})

await mcp.connect(new StdioServerTransport())
