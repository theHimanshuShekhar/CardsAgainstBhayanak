import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { test as base, expect } from '@playwright/test'

// Runs the actual production entry point, with production rate enforcement.
// Uses the suite's disposable DB/Redis; HTTP clients bind distinct loopback
// addresses to exercise transport identity without mocking application code.
const test = base.extend<{
  productionUrl: string
  proxyUrl: string
  trustedProxyIps: string
}>({
  trustedProxyIps: ['::ffff:127.0.0.2', { option: true }],
  productionUrl: async ({ trustedProxyIps }, runFixture) => {
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const port = address.port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.prod.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        CAB_TRUSTED_PROXY_IPS: trustedProxyIps,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    const url = `http://127.0.0.1:${port}`
    try {
      await expect(async () => {
        if (child.exitCode !== null) throw new Error(output)
        expect((await fetch(`${url}/api/healthz`)).status).toBe(200)
      }).toPass({ timeout: 20_000 })
      await runFixture(url)
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  },
  proxyUrl: async ({ productionUrl }, runFixture) => {
    const proxy = createServer((incoming, outgoing) => {
      const headers = { ...incoming.headers }
      delete headers['forwarded']
      delete headers['x-forwarded-for']
      // Real ingress boundary: overwrite, never relay the visitor's CF header.
      headers['cf-connecting-ip'] = incoming.socket.remoteAddress
      const upstream = httpRequest(
        `${productionUrl}${incoming.url}`,
        { method: incoming.method, headers, localAddress: '127.0.0.2' },
        (response) => {
          outgoing.writeHead(response.statusCode!, response.headers)
          response.pipe(outgoing)
        },
      )
      upstream.on('error', () => outgoing.destroy())
      incoming.pipe(upstream)
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    try {
      await runFixture(`http://127.0.0.1:${address.port}`)
    } finally {
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  },
})

test('direct join attempts share a budget despite forged forwarding headers', async ({
  productionUrl,
}) => {
  const url = `${productionUrl}/api/games/ZZZZZZ/join`
  for (let attempt = 0; attempt < 10; attempt++) {
    expect(await post(url, '127.0.0.12')).toBe(404)
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(
      await post(url, '127.0.0.12', {
        'cf-connecting-ip': `198.51.100.${attempt + 10}`,
        'x-forwarded-for': `203.0.113.${attempt + 10}`,
      }),
    ).toBe(429)
  }
  expect(await post(url, '127.0.0.13')).toBe(404)
})

for (const [path, max, allowed] of [
  ['/api/games', 5, 400],
  ['/api/games/ZZZZZZ/join', 10, 404],
] as const) {
  test(`trusted proxy preserves separate client budgets for ${path}`, async ({ proxyUrl }) => {
    for (let attempt = 0; attempt < max; attempt++) {
      expect(await post(`${proxyUrl}${path}`, '127.0.0.30')).toBe(allowed)
    }
    expect(
      await post(`${proxyUrl}${path}`, '127.0.0.30', {
        'cf-connecting-ip': '203.0.113.99',
        'x-forwarded-for': '203.0.113.99',
      }),
    ).toBe(429)
    expect(await post(`${proxyUrl}${path}`, '127.0.0.31')).toBe(allowed)
  })
}

test('invalid proxy identity falls back to its transport budget', async ({ productionUrl }) => {
  const url = `${productionUrl}/api/games`
  for (const value of ['', 'not-an-ip', '203.0.113.9, 203.0.113.10', '[::1]', '::1%lo']) {
    expect(
      await post(url, '127.0.0.2', {
        'cf-connecting-ip': value,
        'x-forwarded-for': '203.0.113.50',
      }),
    ).toBe(400)
  }
  expect(await post(url, '127.0.0.2', { 'cf-connecting-ip': 'garbage' })).toBe(429)
  expect(await post(url, '127.0.0.3', { 'cf-connecting-ip': 'garbage' })).toBe(400)
})

for (const [original, equivalent] of [
  ['2001:db8::1', '2001:0DB8:0:0:0:0:0:1'],
  ['198.51.100.55', '::ffff:198.51.100.55'],
] as const) {
  test(`equivalent proxy IP spellings share a budget: ${original}`, async ({ productionUrl }) => {
    const url = `${productionUrl}/api/games`
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await post(url, '127.0.0.2', { 'cf-connecting-ip': original })).toBe(400)
    }
    expect(await post(url, '127.0.0.2', { 'cf-connecting-ip': equivalent })).toBe(429)
  })
}

test.describe('default ingress policy', () => {
  test.use({ trustedProxyIps: '' })
  test('trusts no forwarding headers even from loopback', async ({ productionUrl }) => {
    const url = `${productionUrl}/api/games/ZZZZZZ/join`
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await post(url, '127.0.0.2')).toBe(404)
    }
    expect(await post(url, '127.0.0.2', { 'cf-connecting-ip': '203.0.113.80' })).toBe(429)
  })
})

test('production refuses a wildcard ingress allowlist before listening', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server.prod.ts'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: '0', CAB_TRUSTED_PROXY_IPS: '*' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('CAB_TRUSTED_PROXY_IPS must contain only literal IP addresses')
})

function post(url: string, localAddress: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', localAddress, headers }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode!))
    })
    request.on('error', reject)
    request.end('{}')
  })
}

test('direct create attempts share a budget despite forged forwarding headers', async ({
  productionUrl,
}) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(await post(`${productionUrl}/api/games`, '127.0.0.10')).toBe(400)
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(
      await post(`${productionUrl}/api/games`, '127.0.0.10', {
        'cf-connecting-ip': `198.51.100.${attempt + 1}`,
        'x-forwarded-for': `203.0.113.${attempt + 1}, 127.0.0.2`,
        forwarded: `for=192.0.2.${attempt + 1}`,
      }),
    ).toBe(429)
  }
  expect(await post(`${productionUrl}/api/games`, '127.0.0.11')).toBe(400)
})
