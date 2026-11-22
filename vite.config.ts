import { defineConfig, type Connect } from 'vite'
import type { IncomingMessage } from 'node:http'
import { handleNpc } from './api/npc.ts'

// Keep the connection writable after rejecting an oversized, chunked POST.
function incomingBody(req: IncomingMessage) {
  const chunks = req.iterator({ destroyOnReturn: false })
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await chunks.next()
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    async cancel() {
      await chunks.return?.()
      req.resume()
    },
  }, { highWaterMark: 0 })
}

const npcMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url?.split('?')[0] !== '/api/npc') return next()
  const cancelled = new AbortController()
  const disconnect = () => { if (!res.writableEnded) cancelled.abort() }
  res.once('close', disconnect)
  async function serve() {
    const headers = new Headers()
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const scheme = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'
    const url = new URL('/api/npc', `${scheme}://${req.headers.host || 'localhost'}`)
    const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal: cancelled.signal }
    if (req.method === 'POST') {
      init.body = incomingBody(req)
      init.duplex = 'half'
    }
    const result = await handleNpc(new Request(url, init), {}, req.socket.remoteAddress)
    if (res.destroyed) return
    res.writeHead(result.status, Object.fromEntries(result.headers))
    res.end(await result.text())
  }
  void serve().catch(() => {
    if (!res.destroyed && !res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end('{"error":"Invalid request"}')
    }
  }).finally(() => {
    res.off('close', disconnect)
    req.resume()
  })
}

export default defineConfig({
  plugins: [{
    name: 'waterworld-npc',
    configureServer(server) { server.middlewares.use(npcMiddleware) },
  }],
})
