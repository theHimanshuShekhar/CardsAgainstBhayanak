const brand = 'Cards Against Bhayanak'
const description = 'A multiplayer party card game. Pick your handle and join your friends.'

export function shareHead(origin: string, pathname: string) {
  const room = /^\/games\/[^/]+\/(lobby|session|end)\/?$/.test(pathname)
  const pages: Record<string, [string, string]> = {
    '/stats': ['Game stats', 'Explore the numbers behind Cards Against Bhayanak.'],
    '/games/create': ['Create a game', 'Start a party card game and invite your friends.'],
    '/games/join': ['Join a game', description],
  }
  const [label, summary] = room
    ? ['Join a game', description]
    : (pages[pathname] ?? [brand, description])
  const title = label === brand ? brand : `${label} on ${brand}`
  const canonical = `${origin}${pathname.startsWith('/') ? pathname : '/'}`
  const image = `${origin}/share-v1.png`
  const alt = 'Cards Against Bhayanak. Bad answers. Great company. Black and white party cards.'
  return {
    meta: [
      { title },
      { name: 'description', content: summary },
      { name: 'theme-color', content: '#111111' },
      ...Object.entries({
        'og:type': 'website',
        'og:site_name': brand,
        'og:title': title,
        'og:description': summary,
        'og:url': canonical,
        'og:image': image,
        'og:image:width': '1200',
        'og:image:height': '630',
        'og:image:alt': alt,
      }).map(([property, content]) => ({ property, content })),
      ...Object.entries({
        'twitter:card': 'summary_large_image',
        'twitter:title': title,
        'twitter:description': summary,
        'twitter:image': image,
        'twitter:image:alt': alt,
      }).map(([name, content]) => ({ name, content })),
    ],
    links: [{ rel: 'canonical', href: canonical }],
  }
}
