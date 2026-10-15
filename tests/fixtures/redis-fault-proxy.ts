import { createConnection, createServer, type Socket } from 'node:net'

// A transport fault at the real Redis boundary, rather than replacing an
// application collaborator. Forward complete RESP command frames unchanged.
export async function redisFaultProxy(targetUrl: string) {
  const target = new URL(targetUrl)
  const upstreamHost = target.hostname
  const upstreamPort = Number(target.port || 6379)
  const sockets = new Set<Socket>()
  let failDelete: string | undefined
  const server = createServer((client) => {
    const upstream = createConnection({ host: upstreamHost, port: upstreamPort })
    sockets.add(client)
    sockets.add(upstream)
    let buffered = Buffer.alloc(0)
    upstream.pipe(client)
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
    client.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length) {
        const header = buffered.indexOf('\r\n')
        if (header < 0) return
        const count = Number(buffered.subarray(1, header).toString())
        let offset = header + 2
        const args: string[] = []
        for (let index = 0; index < count; index++) {
          const end = buffered.indexOf('\r\n', offset)
          if (end < 0) return
          const length = Number(buffered.subarray(offset + 1, end).toString())
          const start = end + 2
          if (buffered.length < start + length + 2) return
          args.push(buffered.subarray(start, start + length).toString())
          offset = start + length + 2
        }
        const frame = buffered.subarray(0, offset)
        buffered = buffered.subarray(offset)
        if (args[0]?.toUpperCase() === 'HDEL' && args[1] === failDelete) {
          failDelete = undefined
          client.write('-ERR injected pending departure acknowledgement failure\r\n')
        } else upstream.write(frame)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing proxy address')
  target.hostname = '127.0.0.1'
  target.port = String(address.port)
  return {
    url: target.toString(),
    failNextHashDelete(key: string) {
      failDelete = key
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
