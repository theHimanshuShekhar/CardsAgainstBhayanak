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
  promptPick: number
  submitterHandLen: number
  round1StartedCount: number
}

export type GodmodeResult = {
  selfVoteIgnored: boolean
  doubleVoteIgnored: boolean
  roundWon: boolean
  reachedRound2: boolean
}

export type HappyEndingResult = {
  round2Prompt: string
  round2Pick: number
  gameOver: boolean
  mode: string
}

export type CzarDropResult = {
  roundVoided: boolean
  voidedRound: number
  round2Started: boolean
  czarRotated: boolean
}

export type HostDropResult = {
  hostChanged: boolean
  newHostId: string
  expectedHostId: string
  oldHostId: string
}

export type AllDropResult = {
  paused: boolean
  gameStatus: string
}

export type SpectatorRejectResult = {
  errorCode: string
  authedOk: boolean
}

export type DroppedAuthResult = {
  authErrorCode: string
  gotAuthOk: boolean
}

export type LobbySnapshotResult = {
  gotLobbySnapshot: boolean
  gameStatus: string
  rosterSize: number
  configRoundsToWin: number
  configMaxPlayers: number
  configTimer: string
  postStartIsStateSnapshot: boolean
}

// Resolves once the Nth event of `type` has been observed on `p`. Needed
// for multi-round drives where `waitFor` would match a stale prior round.
function waitForNth(p: Peer, type: string, n: number, ms = 12000): Promise<any> {
  return new Promise((res, rej) => {
    const hits = () => p.events.filter((e) => e.type === type)
    const done = () => {
      const h = hits()
      return h.length >= n ? h[n - 1] : null
    }
    const f0 = done()
    if (f0) return res(f0)
    const t = setTimeout(() => rej(new Error(`${p.name} waitForNth ${type}#${n} timeout`)), ms)
    const iv = setInterval(() => {
      const f = done()
      if (f) {
        clearInterval(iv)
        clearTimeout(t)
        res(f)
      }
    }, 100)
  })
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

  let submitterHandLen = 0
  for (const [name, id] of Object.entries(idByName)) {
    if (id === czarId) continue
    const hand = peers[name]!.snapshot?.hand ?? []
    submitterHandLen = hand.length
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
  // N-1: round 1 must emit exactly one round_started (engine is the sole
  // emitter; start.ts no longer double-publishes).
  const round1StartedCount = observer.events.filter(
    (e) => e.type === 'round_started' && e.round === 1,
  ).length

  for (const p of Object.values(peers)) p.ws.close()

  return {
    code,
    revealStart: czar.events.some((e) => e.type === 'reveal_start'),
    cardRevealed,
    roundWon: !!won,
    roundEnd: !!end,
    reachedRound2,
    promptPick: pick,
    submitterHandLen,
    round1StartedCount,
  }
}

// Happy Ending (S0-6): host arms the early end during round 1; round 2 is
// the forced synthetic "Make a Haiku" (pick:3) round, after which the game
// ends with mode 'happy_ending' regardless of score.
export async function playHappyEnding(base: string): Promise<HappyEndingResult> {
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 10,
    roundsToWin: 20, // high enough that score never ends the 2-round game
    timer: 'Off' as const,
    packs: [base0.id],
    rules: ['happy_ending'],
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string

  const joins = []
  for (let i = 2; i <= 3; i++) {
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

  // Host arms Happy Ending during round 1.
  send(peers.host!, { type: 'happy_ending' })
  await sleep(400)

  // Drives one normal pick-mode round (round `roundNum`), refreshing each
  // peer's hand/prompt via rejoin so it works for round 2's new deal.
  const playPickRound = async (roundNum: number) => {
    const rsEvt = (() => {
      for (const p of Object.values(peers)) {
        const e = p.events.find((x) => x.type === 'round_started' && x.round === roundNum)
        if (e) return e
      }
      return null
    })()
    const czarId: string | null = rsEvt?.czarId ?? null

    for (const p of Object.values(peers)) {
      p.snapshot = null
      send(p, { type: 'rejoin' })
    }
    await sleep(900)
    const anySnap = Object.values(peers).find((p) => p.snapshot)?.snapshot
    const pick = (anySnap?.prompt?.pick ?? 1) as number
    const promptText = (anySnap?.prompt?.text ?? '') as string

    for (const [name, id] of Object.entries(idByName)) {
      if (id === czarId) continue
      const hand = peers[name]!.snapshot?.hand ?? []
      send(peers[name]!, { type: 'play', cardIds: hand.slice(0, pick).map((x: any) => x.id) })
    }

    const czarName = Object.entries(idByName).find(([, id]) => id === czarId)![0]
    const czar = peers[czarName]!
    await waitForNth(czar, 'reveal_start', roundNum)
    await sleep(700 * 4 + 800)
    send(czar, { type: 'pick', submissionId: '0' })
    return { pick, promptText }
  }

  // Round 1: normal prompt.
  await playPickRound(1)
  const any = Object.values(peers)[0]!
  await waitForNth(any, 'round_end', 1)

  // Round 2: the forced Haiku final.
  await waitForNth(any, 'round_started', 2)
  const r2 = await playPickRound(2)

  const over = await waitFor(any, 'game_over', 15000).then(
    (e) => e,
    () => null,
  )

  for (const p of Object.values(peers)) p.ws.close()

  return {
    round2Prompt: r2.promptText,
    round2Pick: r2.pick,
    gameOver: !!over,
    mode: over?.mode ?? '',
  }
}

// S2-1: the Czar disconnects mid-judging and never returns. After the
// grace window the round must be voided (cards returned, black discarded)
// and a fresh round started with a *different* Czar.
export async function playCzarDrop(base: string): Promise<CzarDropResult> {
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 10,
    roundsToWin: 20,
    timer: 'Off' as const,
    packs: [base0.id],
    rules: [] as string[],
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string

  const joins = []
  for (let i = 2; i <= 3; i++) {
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
  const czarId = snap.czarId as string
  const pick = snap.prompt.pick as number

  // Non-Czar players submit → the round reaches reveal/judging.
  for (const [name, id] of Object.entries(idByName)) {
    if (id === czarId) continue
    const hand = peers[name]!.snapshot?.hand ?? []
    send(peers[name]!, { type: 'play', cardIds: hand.slice(0, pick).map((x: any) => x.id) })
  }

  const czarName = Object.entries(idByName).find(([, id]) => id === czarId)![0]
  const czar = peers[czarName]!
  const observer = Object.values(peers).find((p) => idByName[p.name] !== czarId)!
  await waitFor(czar, 'reveal_start')
  await sleep(700 * 4 + 500)

  // Czar vanishes mid-judging (never picks); grace expiry voids the round.
  czar.ws.close()
  // Keep the observer's socket past the 30s grace + keepalive window.
  const ka = setInterval(() => {
    try {
      send(observer, { type: 'ping' })
    } catch {
      /* socket closing */
    }
  }, 10_000)

  const voided = await waitFor(observer, 'round_voided', 40_000).then(
    (e) => e,
    () => null,
  )
  const r2 = voided
    ? await waitFor(observer, 'round_started', 10_000).then(
        () => observer.events.find((e) => e.type === 'round_started' && e.round === 2),
        () => null,
      )
    : null
  clearInterval(ka)

  for (const p of Object.values(peers)) {
    try {
      p.ws.close()
    } catch {
      /* already closed */
    }
  }

  return {
    roundVoided: !!voided,
    voidedRound: voided?.round ?? -1,
    round2Started: !!r2,
    czarRotated: !!r2 && r2.czarId !== czarId,
  }
}

// S2-1: the host disconnects mid-game and never returns. After the grace
// window the host role must migrate to the longest-present active player
// (p2 — joined right after the host) via a host_changed event.
export async function playHostDrop(base: string): Promise<HostDropResult> {
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 10,
    roundsToWin: 20,
    timer: 'Off' as const,
    packs: [base0.id],
    rules: [] as string[],
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string
  const oldHostId = c.json.playerId as string

  const joins = []
  for (let i = 2; i <= 3; i++) {
    joins.push(
      await post(base, `/api/games/${code}/join`, {
        username: `p${i}`,
        anonId: `a-p${i}`,
        role: 'player',
      }),
    )
  }
  const expectedHostId = joins[0]!.json.playerId as string // p2, joined first after host

  const peers: Record<string, Peer> = {}
  peers.host = await connect(base, code, c.json.sessionToken, 'host')
  for (let i = 0; i < joins.length; i++) {
    peers[`p${i + 2}`] = await connect(base, code, joins[i]!.json.sessionToken, `p${i + 2}`)
  }

  const s = await post(base, `/api/games/${code}/start`, {}, c.json.sessionToken)
  if (s.status !== 204) throw new Error(`start ${s.status}`)
  await sleep(800)
  for (const p of Object.values(peers)) send(p, { type: 'rejoin' })
  await sleep(1200)

  // Host vanishes mid-round; grace expiry migrates the host role.
  peers.host!.ws.close()
  const observer = peers.p2!
  const ka = setInterval(() => {
    try {
      send(observer, { type: 'ping' })
    } catch {
      /* socket closing */
    }
  }, 10_000)

  const changed = await waitFor(observer, 'host_changed', 40_000).then(
    (e) => e,
    () => null,
  )
  clearInterval(ka)

  for (const p of Object.values(peers)) {
    try {
      p.ws.close()
    } catch {
      /* already closed */
    }
  }

  return {
    hostChanged: !!changed,
    newHostId: changed?.hostId ?? '',
    expectedHostId,
    oldHostId,
  }
}

// S2-1: every player disconnects mid-game. After the grace window the
// session must be parked in 'paused' (no one left to resolve the round)
// rather than churning zombie void/migrate work. No WS event is emitted
// (no clients are connected), so the pause is observed via the join
// endpoint, which echoes the live session.status as `gameStatus`.
export async function playAllDrop(base: string): Promise<AllDropResult> {
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 10,
    roundsToWin: 20,
    timer: 'Off' as const,
    packs: [base0.id],
    rules: [] as string[],
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string

  const joins = []
  for (let i = 2; i <= 3; i++) {
    joins.push(
      await post(base, `/api/games/${code}/join`, {
        username: `p${i}`,
        anonId: `a-p${i}`,
        role: 'player',
      }),
    )
  }

  const peers: Peer[] = []
  peers.push(await connect(base, code, c.json.sessionToken, 'host'))
  for (let i = 0; i < joins.length; i++) {
    peers.push(await connect(base, code, joins[i]!.json.sessionToken, `p${i + 2}`))
  }

  const s = await post(base, `/api/games/${code}/start`, {}, c.json.sessionToken)
  if (s.status !== 204) throw new Error(`start ${s.status}`)
  await sleep(800)
  for (const p of peers) send(p, { type: 'rejoin' })
  await sleep(1200)

  // Everyone vanishes — no keepalive, so all sockets hit grace expiry.
  for (const p of peers) {
    try {
      p.ws.close()
    } catch {
      /* already closing */
    }
  }

  // One grace cycle (30s + 100ms handler delay) plus margin, then poll
  // the join endpoint until it reports the paused status.
  await sleep(32_000)
  let gameStatus = 'active'
  for (let attempt = 0; attempt < 6 && gameStatus !== 'paused'; attempt++) {
    const probe = await post(base, `/api/games/${code}/join`, {
      username: `probe-${attempt}`,
      anonId: `a-probe-${attempt}`,
      role: 'spectator',
    })
    gameStatus = (probe.json.gameStatus as string) ?? gameStatus
    if (gameStatus !== 'paused') await sleep(3_000)
  }

  return { paused: gameStatus === 'paused', gameStatus }
}

// S2-3: an authenticated spectator socket may stay connected but must
// not drive the game. A blocked action returns error: spectator_action.
export async function playSpectatorReject(base: string): Promise<SpectatorRejectResult> {
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 10,
    roundsToWin: 20,
    timer: 'Off' as const,
    packs: [base0.id],
    rules: [] as string[],
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string

  const spec = await post(base, `/api/games/${code}/join`, {
    username: 'watcher',
    anonId: 'a-watcher',
    role: 'spectator',
  })
  if (spec.status !== 200) throw new Error(`spectator join ${spec.status}`)

  // connect() resolves on auth_ok — spectators authenticate fine.
  const peer = await connect(base, code, spec.json.sessionToken, 'watcher')
  const authedOk = peer.events.some((e) => e.type === 'auth_ok')

  send(peer, { type: 'play', cardIds: [] })
  const err = await waitFor(peer, 'error', 8_000).then(
    (e) => e,
    () => null,
  )
  try {
    peer.ws.close()
  } catch {
    /* already closing */
  }

  return { errorCode: err?.code ?? '', authedOk }
}

// S2-4: a player whose grace window expired is 'dropped'. Re-authenticating
// with that (still cryptographically valid) token must yield auth_error
// with code player_dropped — not a silent invalid_token.
export async function playDroppedAuth(base: string): Promise<DroppedAuthResult> {
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 10,
    roundsToWin: 20,
    timer: 'Off' as const,
    packs: [base0.id],
    rules: [] as string[],
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string

  const j = await post(base, `/api/games/${code}/join`, {
    username: 'p2',
    anonId: 'a-p2',
    role: 'player',
  })
  if (j.status !== 200) throw new Error(`join ${j.status}`)
  const token = j.json.sessionToken as string

  // Connect then vanish; the grace timer drops the player after ~30s.
  const peer = await connect(base, code, token, 'p2')
  peer.ws.close()
  await sleep(33_000)

  // Re-auth with the same token — the player is now 'dropped'.
  const wsBase = base.replace(/^http/, 'ws')
  const result = await new Promise<{ type: string; code?: string }>((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/api/games/${code}/ws`)
    const to = setTimeout(() => reject(new Error('reauth timeout')), 8_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', sessionToken: token }))
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; code?: string }
      if (msg.type === 'auth_ok' || msg.type === 'auth_error') {
        clearTimeout(to)
        try {
          ws.close()
        } catch {
          /* already closing */
        }
        resolve(msg)
      }
    }
    ws.onerror = () => {
      clearTimeout(to)
      reject(new Error('reauth ws error'))
    }
  })

  return {
    authErrorCode: result.type === 'auth_error' ? (result.code ?? '') : '',
    gotAuthOk: result.type === 'auth_ok',
  }
}

// S2-5: a pre-game client gets the roster + config + status via
// lobby_snapshot on rejoin, and once the game has started the same
// rejoin yields a state_snapshot instead (the lobby's reconnect-hub
// redirect contract).
export async function playLobbySnapshot(base: string): Promise<LobbySnapshotResult> {
  const packsJson = (await (await fetch(base + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const base0 = packsJson.packs.find((p) => /base/i.test(p.name)) ?? packsJson.packs[0]
  if (!base0) throw new Error('no packs seeded')

  const cfg = {
    maxPlayers: 8,
    roundsToWin: 5,
    timer: '90s' as const,
    packs: [base0.id],
    rules: [] as string[],
  }
  const c = await post(base, '/api/games', { username: 'host', anonId: 'a-host', config: cfg })
  if (c.status !== 201 && c.status !== 200) throw new Error(`create ${c.status}`)
  const code = c.json.roomCode as string

  const joins: any[] = []
  for (let i = 2; i <= 3; i++) {
    joins.push(
      await post(base, `/api/games/${code}/join`, {
        username: `p${i}`,
        anonId: `a-p${i}`,
        role: 'player',
      }),
    )
  }

  // connect() resolves on auth_ok but does not auto-rejoin (unlike the
  // real client hook), so drive rejoin explicitly.
  const host = await connect(base, code, c.json.sessionToken, 'host')
  send(host, { type: 'rejoin' })
  const lobby = await waitFor(host, 'lobby_snapshot', 8_000).then(
    (e) => e,
    () => null,
  )

  // Start the game, then a fresh socket's rejoin must answer with a
  // state_snapshot — never another lobby_snapshot.
  const s = await post(base, `/api/games/${code}/start`, {}, c.json.sessionToken)
  if (s.status !== 204) throw new Error(`start ${s.status}`)
  await sleep(800)

  const rejoiner = await connect(base, code, joins[0].json.sessionToken as string, 'p2')
  send(rejoiner, { type: 'rejoin' })
  const postStart = await Promise.race([
    waitFor(rejoiner, 'state_snapshot', 8_000).then(() => 'state_snapshot'),
    waitFor(rejoiner, 'lobby_snapshot', 8_000).then(() => 'lobby_snapshot'),
  ]).catch(() => 'none')

  for (const p of [host, rejoiner]) {
    try {
      p.ws.close()
    } catch {
      /* already closing */
    }
  }

  return {
    gotLobbySnapshot: !!lobby,
    gameStatus: lobby?.gameStatus ?? '',
    rosterSize: lobby?.players?.length ?? 0,
    configRoundsToWin: lobby?.config?.roundsToWin ?? 0,
    configMaxPlayers: lobby?.config?.maxPlayers ?? 0,
    configTimer: lobby?.config?.timer ?? '',
    postStartIsStateSnapshot: postStart === 'state_snapshot',
  }
}
