export function readSiteOrigin() {
  const configured = process.env['PUBLIC_SITE_URL']
  if (!configured && process.env['NODE_ENV'] === 'production') {
    throw new Error('PUBLIC_SITE_URL must be set to the public HTTPS origin')
  }
  const url = new URL(configured ?? 'http://localhost:3000')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && local && process.env['NODE_ENV'] !== 'production'))
  )
    throw new Error('PUBLIC_SITE_URL must be an HTTPS origin (HTTP localhost in development only)')
  return url.origin
}
