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
  { capabilities: { tools: {} } },
)

const TOOLS = [
  {
    name: 'list_browsers',
    description: 'List browsers currently registered with the relay (id, tags, current_url, online status).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'screenshot',
    description: 'Capture the visible viewport of the active tab on the target browser. Returns a PNG data URL.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Browser id. If omitted, RX_BROWSER_DEFAULT_TARGET is used.' },
        tag: { type: 'string', description: 'Alternative to target: first online browser matching this tag.' },
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
      },
      required: ['selector'],
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

  if (!['screenshot', 'navigate', 'click', 'fill', 'new_tab', 'query'].includes(name)) {
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
    const data = result.data as { dataUrl?: string; tab_url?: string; tab_title?: string } | undefined
    const content: any[] = []
    if (data?.dataUrl) {
      const m = data.dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
      if (m) {
        content.push({ type: 'image', data: m[2], mimeType: m[1] })
      }
    }
    content.push({
      type: 'text',
      text: JSON.stringify({ browser_id: result.browser_id, tab_url: data?.tab_url, tab_title: data?.tab_title }),
    })
    return { content }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ browser_id: result.browser_id, ...result }, null, 2) }],
  }
})

await mcp.connect(new StdioServerTransport())
