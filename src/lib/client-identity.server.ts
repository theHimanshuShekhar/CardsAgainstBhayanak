import { isIP } from 'node:net'
import type { ServerRequest } from 'srvx'

// Canonicalize equivalent IPv6 spellings and IPv4-mapped transport addresses
// so a client cannot obtain multiple budgets by changing the IP's spelling.
function canonicalIp(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const ip = value.trim()
  if (isIP(ip) === 4) return ip
  if (isIP(ip) !== 6 || ip.includes('%')) return undefined
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([a-f\d]+):([a-f\d]+)$/.exec(canonical)
  if (!mapped) return canonical
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

const trustedProxyIps = new Set(
  (process.env['CAB_TRUSTED_PROXY_IPS'] ?? '')
    .split(',')
    .filter((value) => value.trim())
    .map((value) => {
      const ip = canonicalIp(value)
      if (!ip) throw new Error('CAB_TRUSTED_PROXY_IPS must contain only literal IP addresses')
      return ip
    }),
)

export function getClientIp(request: Request): string {
  // Read the Node socket rather than headers or a framework's proxy-aware IP
  // helper. srvx carries this runtime context through the SSR/API handler.
  const peer = canonicalIp((request as ServerRequest).runtime?.node?.req.socket.remoteAddress)
  if (peer && trustedProxyIps.has(peer)) {
    // cloudflared/Cloudflare must overwrite this header. Forwarded and XFF
    // are deliberately unused: their caller-controlled chains need a
    // different proxy policy. Missing/malformed CF identity uses the peer.
    const client = canonicalIp(request.headers.get('cf-connecting-ip'))
    if (client) return client
  }
  // Development Fetch requests may have no socket context. A shared fallback
  // remains bounded and never takes an identity from untrusted headers.
  return peer ?? 'unknown'
}
