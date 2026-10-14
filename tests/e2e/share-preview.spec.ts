import { test, expect } from '@playwright/test'
import { createGame } from '../helpers'

for (const agent of ['Discordbot/2.0', 'Twitterbot/1.0']) {
  test(`${agent} receives private, complete previews before JavaScript`, async ({ request }) => {
    for (const path of [
      '/',
      '/stats',
      '/games/create',
      '/games/join',
      '/games/ABCDEF/lobby',
      '/games/ABCDEF/session',
      '/games/ABCDEF/end',
      '/games/malformed/lobby',
    ]) {
      const response = await request.get(
        `${path}?sessionToken=PRIVATE_POISON&username=PRIVATE_HANDLE&utm_source=evil`,
        {
          headers: { 'user-agent': agent, 'x-forwarded-host': 'evil.example' },
        },
      )
      expect(response.ok()).toBeTruthy()
      const head = (await response.text()).split('</head>')[0] ?? ''
      for (const key of [
        'og:type',
        'og:site_name',
        'og:title',
        'og:description',
        'og:url',
        'og:image',
        'og:image:width',
        'og:image:height',
        'og:image:alt',
        'twitter:card',
        'twitter:title',
        'twitter:description',
        'twitter:image',
        'twitter:image:alt',
      ]) {
        expect(head.match(new RegExp(`(?:name|property)="${key}"`, 'g'))).toHaveLength(1)
      }
      expect(head).toContain('rel="canonical"')
      expect(head).toContain('content="1200"')
      expect(head).not.toMatch(/PRIVATE_POISON|PRIVATE_HANDLE|evil\.example|utm_source/)
      if (path.includes('ABCDEF')) expect(head).toContain('Join a game on Cards Against Bhayanak')
    }
  })
}

test('public preview assets are PNGs with correct sizes and cache headers', async ({ request }) => {
  for (const [path, width, height] of [
    ['/share-v1.png', 1200, 630],
    ['/favicon-v1.png', 32, 32],
    ['/apple-touch-icon-v1.png', 180, 180],
  ] as const) {
    const response = await request.get(path)
    expect(response.ok()).toBeTruthy()
    expect(response.headers()['content-type']).toContain('image/png')
    expect(response.headers()['cache-control']).toContain('max-age=31536000')
    const png = await response.body()
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(width)
    expect(png.readUInt32BE(20)).toBe(height)
  }
})

test('the exact Copy link URL has no private host or session data in its crawler head', async ({
  browser,
  request,
}) => {
  const { handle, roomCode } = await createGame(browser, 'PrivatePreviewHost')
  await handle.context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await handle.page.getByRole('button', { name: 'Copy link', exact: true }).click()
  const copied = await handle.page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain(`/games/${roomCode}/lobby`)
  const session = await handle.page.evaluate(() =>
    JSON.parse(localStorage.getItem('cab_session') ?? '{}'),
  )
  for (const agent of ['Discordbot/2.0', 'Twitterbot/1.0']) {
    const response = await request.get(copied, { headers: { 'user-agent': agent } })
    expect(response.ok()).toBeTruthy()
    const head = (await response.text()).split('</head>')[0] ?? ''
    expect(head).toContain('Join a game on Cards Against Bhayanak')
    for (const secret of [
      'PrivatePreviewHost',
      session.sessionToken,
      session.playerId,
      session.anonId,
    ]) {
      expect(head).not.toContain(secret)
    }
    expect(head).toMatch(/https?:\/\/[^" ]+\/share-v1\.png/)
  }
  await handle.context.close()
})
