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

export type GodmodeResult = {
  selfVoteIgnored: boolean
  doubleVoteIgnored: boolean
  roundWon: boolean
  reachedRound2: boolean
}

// God Is Dead: no Czar, everyone votes. Verifies S0-3 (no self-vote, no
// double-vote) and the S0-1 godmode branch end-to-end.
export async function playGodmode(
  base: string,
  opts: { players?: number } = {},
): Promise<GodmodeResult> {
  const n = opts.players ?? 3
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!pack) throw new Error('no packs')

  const c = await post(base, '/api/games', {
    username: 'host',
    anonId: 'a-host',
    config: { maxPlayers: 10, roundsToWin: 5, timer: 'Off', packs: [pack.id], rules: ['godmode'] },
  })
  const code = c.json.roomCode as string
  const tokens: Record<string, string> = { host: c.json.sessionToken }
  for (let i = 2; i <= n; i++) {
    const j = await post(base, `/api/games/${code}/join`, {
      username: `p${i}`,
      anonId: `a-p${i}`,
      role: 'player',
    })
    tokens[`p${i}`] = j.json.sessionToken
  }
  const peers: Record<string, Peer> = {}
  for (const name of Object.keys(tokens))
    peers[name] = await connect(base, code, tokens[name]!, name)

  await post(base, `/api/games/${code}/start`, {}, tokens.host)
  await sleep(800)
  for (const p of Object.values(peers)) send(p, { type: 'rejoin' })
  await sleep(1200)

  // Everyone submits (godmode has no Czar). Remember each peer's cards.
  const playedBy: Record<string, string[]> = {}
  for (const [name, p] of Object.entries(peers)) {
    const hand = p.snapshot?.hand ?? []
    const pick = p.snapshot?.prompt?.pick ?? 1
    const ids = hand.slice(0, pick).map((x: any) => x.id)
    playedBy[name] = ids
    send(p, { type: 'play', cardIds: ids })
  }

  const any = Object.values(peers)[0]!
  await waitFor(any, 'reveal_start')
  await sleep(700 * (n + 1) + 800)

  // Each peer finds its own submission index by matching revealed fills.
  const reveals = any.events.filter((e) => e.type === 'card_revealed')
  const ownIdx: Record<string, number> = {}
  for (const [name, ids] of Object.entries(playedBy)) {
    const r = reveals.find((e) => e.fills.map((f: any) => f.id).join(',') === ids.join(','))
    ownIdx[name] = r ? r.submissionIndex : -1
  }
  const names = Object.keys(peers) // [A, B, C]
  const total = reveals.length
  const [A, B, C] = names as [string, string, string]
  // Concentrate votes on C's submission so there's a clear winner (no
  // tie / re-vote). A and B don't own it, so their votes are valid.
  const winnerIdx = ownIdx[C]!
  const targetSub = String(winnerIdx)

  // S0-3a: A voting for its own submission must be ignored.
  if (ownIdx[A]! >= 0) send(peers[A]!, { type: 'vote', submissionId: String(ownIdx[A]) })
  // S0-3b: A voting twice for the (valid) winner must count once.
  send(peers[A]!, { type: 'vote', submissionId: targetSub })
  send(peers[A]!, { type: 'vote', submissionId: targetSub })
  await sleep(700)
  // Only 1 legitimate vote so far → round must NOT have resolved.
  const wonEarly = any.events.some((e) => e.type === 'round_won')

  // B also votes the winner; C votes someone else (not its own).
  send(peers[B]!, { type: 'vote', submissionId: targetSub })
  send(peers[C]!, { type: 'vote', submissionId: String((winnerIdx + 1) % total) })

  const won = await waitFor(any, 'round_won', 10000).then(
    () => true,
    () => false,
  )
  const reachedRound2 = won
    ? await waitFor(any, 'round_started', 10000)
        .then(() => any.events.some((e) => e.type === 'round_started' && e.round === 2))
        .catch(() => false)
    : false

  for (const p of Object.values(peers)) p.ws.close()

  return {
    // Round must NOT have resolved off one player's self-vote + 2 dupes
    // (only 1 legitimate vote should have counted).
    selfVoteIgnored: !wonEarly,
    doubleVoteIgnored: !wonEarly,
    roundWon: won,
    reachedRound2,
  }
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
