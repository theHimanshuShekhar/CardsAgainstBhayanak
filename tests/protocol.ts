/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic WS event payloads in a test driver */
// Protocol-level game driver: exercises the real HTTP + WebSocket stack
// without a browser. This is the regression backbone for engine work —
// it does not depend on UI that may not be built yet.

type Peer = { ws: WebSocket; name: string; events: any[]; snapshot: any }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function post(base: string, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['authorization'] = 'Bearer ' + token
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any }
}

function connect(base: string, code: string, token: string, name: string): Promise<Peer> {
  const wsBase = base.replace(/^http/, 'ws')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/api/games/${code}/ws`)
    const peer: Peer = { ws, name, events: [], snapshot: null }
    const to = setTimeout(() => reject(new Error(`${name} ws timeout`)), 8000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', sessionToken: token }))
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data))
      peer.events.push(msg)
      if (msg.type === 'auth_ok') {
        clearTimeout(to)
        resolve(peer)
      }
      if (msg.type === 'state_snapshot') peer.snapshot = msg.state
    }
    ws.onerror = () => {
      clearTimeout(to)
      reject(new Error(`${name} ws error`))
    }
  })
}

const send = (p: Peer, m: unknown) => p.ws.send(JSON.stringify(m))

function waitFor(p: Peer, type: string, ms = 10000): Promise<any> {
  return new Promise((res, rej) => {
    const hit = () => p.events.find((e) => e.type === type)
    const found = hit()
    if (found) return res(found)
    const t = setTimeout(() => rej(new Error(`${p.name} waitFor ${type} timeout`)), ms)
    const iv = setInterval(() => {
      const f = hit()
      if (f) {
        clearInterval(iv)
        clearTimeout(t)
        res(f)
      }
    }, 100)
  })
}

export type GameResult = {
  code: string
  revealStart: boolean
  cardRevealed: number
  roundWon: boolean
  roundEnd: boolean
  reachedRound2: boolean
}

// Drives one full normal-mode round and asserts the loop advances.
export async function playRound(
  base: string,
  opts: { rules?: string[]; players?: number } = {},
): Promise<GameResult> {
  const playerCount = opts.players ?? 3
  const rules = opts.rules ?? []

  // A valid pack id (config.packs holds IDs, not names).
  const packsRes = await fetch(base + '/api/packs')
  const packsJson = (await packsRes.json()) as { packs: { id: string; name: string }[] }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 10,
    roundsToWin: 5,
    timer: 'Off' as const,
    packs: [base0.id],
    rules,
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string

  const joins = []
  for (let i = 2; i <= playerCount; i++) {
    joins.push(
      await post(base, `/api/games/${code}/join`, {
        username: `p${i}`,
        anonId: `a-p${i}`,
        role: 'player',
      }),
    )
  }

  const peers: Record<string, Peer> = {}
  peers.host = await connect(base, code, c.json.sessionToken, 'host')
  const idByName: Record<string, string> = { host: c.json.playerId }
  for (let i = 0; i < joins.length; i++) {
    const name = `p${i + 2}`
    peers[name] = await connect(base, code, joins[i]!.json.sessionToken, name)
    idByName[name] = joins[i]!.json.playerId
  }

  const s = await post(base, `/api/games/${code}/start`, {}, c.json.sessionToken)
  if (s.status !== 204) throw new Error(`start ${s.status}`)
  await sleep(800)
  for (const p of Object.values(peers)) send(p, { type: 'rejoin' })
  await sleep(1200)

  const snap = Object.values(peers).find((p) => p.snapshot)?.snapshot
  if (!snap) throw new Error('no snapshot after start')
  const czarId = snap.czarId
  const pick = snap.prompt.pick as number

  for (const [name, id] of Object.entries(idByName)) {
    if (id === czarId) continue
    const hand = peers[name]!.snapshot?.hand ?? []
    send(peers[name]!, { type: 'play', cardIds: hand.slice(0, pick).map((c: any) => c.id) })
  }

  const czarName = Object.entries(idByName).find(([, id]) => id === czarId)![0]
  const czar = peers[czarName]!
  await waitFor(czar, 'reveal_start')
  await sleep(700 * (playerCount + 1) + 800)
  const cardRevealed = czar.events.filter((e) => e.type === 'card_revealed').length
  send(czar, { type: 'pick', submissionId: '0' })

  const observer = Object.values(peers).find((p) => idByName[p.name] !== czarId)!
  const won = await waitFor(observer, 'round_won')
  const end = await waitFor(observer, 'round_end')
  const reachedRound2 = observer.events.some((e) => e.type === 'round_started' && e.round === 2)

  for (const p of Object.values(peers)) p.ws.close()

  return {
    code,
    revealStart: czar.events.some((e) => e.type === 'reveal_start'),
    cardRevealed,
    roundWon: !!won,
    roundEnd: !!end,
    reachedRound2,
  }
}
