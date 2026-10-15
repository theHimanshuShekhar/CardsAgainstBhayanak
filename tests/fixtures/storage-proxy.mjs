import { createConnection, createServer } from 'node:net'

// Own only these forwarding sockets. Turning storage off never touches the
// caller's backing services or other test databases.
export async function storageProxy(url, available = true) {
  const target = new URL(url)
  const host = target.hostname
  const port = Number(target.port)
  const sockets = new Set()
  const server = createServer((client) => {
    if (!available) return client.destroy()
    const upstream = createConnection({ host, port })
    sockets.add(client)
    sockets.add(upstream)
    client.pipe(upstream).pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => {
      sockets.delete(client)
      upstream.destroy()
    })
    upstream.on('close', () => {
      sockets.delete(upstream)
      client.destroy()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  target.hostname = '127.0.0.1'
  target.port = String(server.address().port)
  return {
    url: target.toString(),
    setAvailable(value) {
      available = value
      if (!value) for (const socket of sockets) socket.destroy()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
