import { createConnection, createServer } from 'node:net'

// Own only these forwarding sockets. Turning storage off never touches the
// caller's backing services or other test databases.
export async function storageProxy(url, available = true) {
  const target = new URL(url)
  const host = target.hostname
  const port = Number(target.port)
  const sockets = new Set()
  const upstreams = new Set()
  let responsive = true
  const server = createServer((client) => {
    if (!available) return client.destroy()
    const upstream = createConnection({ host, port })
    upstreams.add(upstream)
    sockets.add(client)
    sockets.add(upstream)
    client.pipe(upstream).pipe(client)
    if (!responsive) upstream.pause()
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => {
      sockets.delete(client)
      upstream.destroy()
    })
    upstream.on('close', () => {
      upstreams.delete(upstream)
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
    // Keep TCP sessions open while withholding storage responses, exercising
    // application deadlines rather than relying on an immediate close event.
    setResponsive(value) {
      responsive = value
      for (const upstream of upstreams) {
        if (value) upstream.resume()
        else upstream.pause()
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
