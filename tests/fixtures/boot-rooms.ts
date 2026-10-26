// Prepare durable in-flight rounds, then exit as the replaced process would.
// Assertions live in the deployment regression's HTTP/WS observations.
import { db } from '../../src/db'
import { gameSessions, gamePlayers, gameRounds, packs } from '../../src/db/schema'
import { eq, sql } from 'drizzle-orm'
import * as state from '../../src/lib/game-state'
import * as engine from '../../src/lib/game-engine'
import { signSessionToken } from '../../src/lib/session-token'

if (!process.env['DATABASE_URL']?.endsWith('/cab_audit_issue39'))
  throw new Error('Dedicated issue39 database required')
if (!process.env['REDIS_URL']?.endsWith('/8')) throw new Error('Dedicated Redis DB8 required')
const [pack] = await db.select().from(packs).where(eq(packs.slug, 'issue39-recovery'))
if (!pack) throw new Error('Seed the issue39 fixture catalog first')
const config = {
  maxPlayers: 3,
  roundsToWin: 20,
  timer: 'Off' as const,
  packs: [pack.id],
  rules: [],
}
const rooms = []
for (const code of ['B39AAA', 'B39BBB', 'B39CCC', 'B39DDD']) {
  const [session] = await db.insert(gameSessions).values({ code, config }).returning()
  const players = await db
    .insert(gamePlayers)
    .values(
      ['Host', 'Next', 'Third'].map((username, i) => ({
        sessionId: session!.id,
        username,
        isHost: i === 0,
      })),
    )
    .returning()
  await db
    .update(gameSessions)
    .set({ hostPlayerId: players[0]!.id })
    .where(eq(gameSessions.id, session!.id))
  await state.createGameState(code, players[0]!.id, config)
  for (const player of players)
    await state.addPlayer(code, {
      ...player,
      joinedAt: player.joinedAt.toISOString(),
      posthogAnonId: undefined,
    })
  await engine.startGame(code)
  const { prompt } = await engine.startRound(code, 1, players[0]!.id)
  if (code === 'B39BBB' || code === 'B39CCC') {
    for (const player of players.slice(1))
      await engine.submitCards(
        code,
        player.id,
        (await state.getHand(code, player.id)).slice(0, prompt.pick),
      )
  }
  if (code === 'B39BBB') {
    const [round] = await db.select().from(gameRounds).where(eq(gameRounds.sessionId, session!.id))
    await db.execute(
      sql`CREATE FUNCTION issue39_outcome_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'issue39 outcome unavailable'; END $$`,
    )
    await db.execute(
      sql.raw(
        `CREATE TRIGGER issue39_outcome_fault BEFORE UPDATE ON game_rounds FOR EACH ROW WHEN (NEW.id = '${round!.id}') EXECUTE FUNCTION issue39_outcome_fault()`,
      ),
    )
    try {
      await engine.pickWinner(code, players[0]!.id, '0')
      throw new Error('Expected the real outcome write to fail')
    } catch (error) {
      if (!(error instanceof Error) || !String(error.cause).includes('issue39 outcome unavailable'))
        throw error
    }
  }
  if (code === 'B39CCC') await state.setPhase(code, 'reveal')
  if (code === 'B39DDD') await state.setRoundTimerExpiresAt(code, Date.now() - 1000)
  rooms.push({
    code,
    members: await Promise.all(
      players.map(async (player) => ({
        playerId: player.id,
        roomCode: code,
        sessionToken: await signSessionToken({ playerId: player.id, roomCode: code }),
      })),
    ),
  })
}
await state.setRoundTimerExpiresAt('B39AAA', Date.now() + 8000)
console.log(`ISSUE39_ROOMS:${JSON.stringify(rooms)}`)
process.exit(0)
