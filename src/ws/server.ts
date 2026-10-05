import nodeAdapter from 'crossws/adapters/node'
import { NodeRequest } from 'srvx/node'
import type { ServerPlugin } from 'srvx'
import { wsHooks } from './handler'

export const MAX_WS_PAYLOAD_BYTES = 8192

// Use the public Node adapter so the limit applies during frame assembly,
// including fragmented/binary messages, before decoding or JSON parsing.
export const gameWebSocketPlugin: ServerPlugin = (server) => {
  const ws = nodeAdapter({ hooks: wsHooks, serverOptions: { maxPayload: MAX_WS_PAYLOAD_BYTES } })
  const originalServe = server.serve
  server.serve = () => {
    server.node?.server?.on('upgrade', (req, socket, head) => {
      void ws.handleUpgrade(req, socket, head, new NodeRequest({ req }))
    })
    return originalServe.call(server)
  }
}
