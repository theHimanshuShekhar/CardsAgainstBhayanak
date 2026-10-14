import { afterAll, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import type { Card, PlayerScore, RuleId } from '../../src/lib/types'

const sql = postgres(process.env['DATABASE_URL']!, { onnotice: () => {} })
const { db } = await import('../../src/db')
const { gameSessions, gamePlayers, gameRounds, packs } = await import('../../src/db/schema')
const { eq } = await import('drizzle-orm')
const state = await import('../../src/lib/game-state')
const engine = await import('../../src/lib/game-engine')
const { redis, KEYS } = await import('../../src/lib/redis')
afterAll(async () => {
  await redis.quit()
  await sql.end()
})

type Event = {
  type: string
  round?: number
  scores?: PlayerScore[]
  hand?: Card[]
  playerId?: string
  activatedPlayers?: string[]
  czarId?: string
  submissionIndex?: number
  fills?: Card[]
  prompt?: { pick: number }
}

const cases = [
  ['normal', 'outcome_sql'],
  ['normal', 'runtime_outcome_sql'],
  ['serious_business', 'completionScores'],
  ['godmode', 'completionCards'],
  ['survival', 'completionPublished'],
  ['normal', 'next_round_sql'],
  ['normal', 'roundStartPublished'],
  ['normal', 'end_game_sql'],
  ['normal', 'completionGameOverPublished'],
  ['godmode', 'closed_ballot'],
  ['survival', 'last_elimination'],
  ['normal', 'reset_during_pause'],
] as const

it.each(cases)(
  '%s resumes after %s without duplicate outcomes or lost cards',
  async (mode, fault) => {
    const code = 'REC038'
    const subscriber = redis.duplicate()
    const events: Event[] = []
    subscriber.on('message', (_channel, raw) => events.push(JSON.parse(raw)))
    await subscriber.subscribe(KEYS.channel(code))
    const [pack] = await db.select().from(packs).limit(1)
    const finishesGame = fault === 'end_game_sql' || fault === 'completionGameOverPublished'
    const config = {
      maxPlayers: 5,
      roundsToWin: finishesGame ? 1 : 10,
      timer: 'Off' as const,
      packs: [pack!.id],
      rules: mode === 'normal' ? [] : [mode as RuleId],
    }
    const [session] = await db.insert(gameSessions).values({ code, config }).returning()
    let restoreFault = () => {}
    try {
      const players = await db
        .insert(gamePlayers)
        .values(
          ['Host', 'Alice', 'Bob', 'Chloe'].map((username, i) => ({
            sessionId: session!.id,
            username,
            isHost: i === 0,
          })),
        )
        .returning()
      await state.createGameState(code, players[0]!.id, config)
      for (const p of players)
        await state.addPlayer(code, {
          ...p,
          joinedAt: p.joinedAt.toISOString(),
          posthogAnonId: undefined,
        })
      await engine.startGame(code)
      const { prompt, czarId } = await engine.startRound(code, 1)
      const originals = new Map<string, string[]>()
      const submitters = players.filter((p) => p.id !== czarId)
      for (const p of submitters) {
        const hand = await state.getHand(code, p.id)
        originals.set(p.id, hand)
        await engine.submitCards(code, p.id, hand.slice(0, prompt.pick))
      }
      // Queue a player before completion: recovery must activate/deal once.
      const [queued] = await db
        .insert(gamePlayers)
        .values({ sessionId: session!.id, username: 'Queued', status: 'queued' })
        .returning()
      await state.addPlayer(code, {
        ...queued!,
        joinedAt: queued!.joinedAt.toISOString(),
        posthogAnonId: undefined,
      })
      await expect
        .poll(() => events.filter((e) => e.type === 'card_revealed').length)
        .toBe(submitters.length)
      if (fault === 'reset_during_pause') {
        let release!: () => void
        let reached!: () => void
        const blocked = new Promise<void>((resolve) => {
          release = resolve
        })
        const checkpoint = new Promise<void>((resolve) => {
          reached = resolve
        })
        const realEval = redis.eval.bind(redis)
        const spy = vi
          .spyOn(redis, 'eval')
          .mockImplementation(async (...args: Parameters<typeof redis.eval>) => {
            const result = await realEval(...args)
            if (String(args[0]).includes("'completionEndPublished', '1'")) {
              reached()
              await blocked
            }
            return result
          })
        restoreFault = () => {
          release()
          spy.mockRestore()
        }
        const oldCommand = engine.pickWinner(code, czarId!, '0')
        await checkpoint
        await engine.endGame(code, 'normal', players[0]!.id)
        const rematch = engine.resetGame(code, 'rematch')
        release()
        await oldCommand
        await rematch
        spy.mockRestore()
        await expect
          .poll(() => events.filter((e) => e.type === 'round_started' && e.round === 1).length)
          .toBe(2)
        const rematchIndex = events.findIndex((e) => e.type === 'game_reset')
        expect(
          events
            .slice(rematchIndex)
            .filter((e) => e.type === 'game_over' || (e.type === 'round_started' && e.round !== 1)),
        ).toEqual([])
        const latest = events.filter((e) => e.type === 'round_started').at(-1)!
        const playable = players.find((p) => p.id !== latest.czarId)!
        await engine.submitCards(
          code,
          playable.id,
          (await state.getHand(code, playable.id)).slice(0, latest.prompt!.pick),
        )
        return
      }
      if (fault.endsWith('_sql')) {
        const table = fault === 'end_game_sql' ? 'game_sessions' : 'game_rounds'
        const operation = fault === 'next_round_sql' ? 'INSERT' : 'UPDATE'
        const guard =
          fault === 'end_game_sql' ? "IF NEW.status <> 'ended' THEN RETURN NEW; END IF;" : ''
        await sql.unsafe(
          `CREATE FUNCTION fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${guard} RAISE EXCEPTION 'injected outage'; END $$`,
        )
        await sql.unsafe(
          `CREATE TRIGGER fail_completion BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_completion()`,
        )
        restoreFault = () => {} // SQL fixture removed explicitly below
      } else {
        // Lost Redis acknowledgement after the actual atomic command commits.
        // Only fault injection knows checkpoint names; assertions use engine events.
        const realEval = redis.eval.bind(redis)
        let injected = false
        const spy = vi
          .spyOn(redis, 'eval')
          .mockImplementation(async (...args: Parameters<typeof redis.eval>) => {
            const result = await realEval(...args)
            const matches =
              fault === 'closed_ballot'
                ? String(args[0]).includes("'voteClosed', '1'") &&
                  typeof result === 'string' &&
                  Boolean(JSON.parse(result).leaders)
                : fault === 'last_elimination'
                  ? String(args[0]).includes('#remaining == 1') && Boolean(result)
                  : String(args[0]).includes(`'${fault}'`)
            if (!injected && matches) {
              injected = true
              throw new Error('injected lost Redis acknowledgement')
            }
            return result
          })
        restoreFault = () => spy.mockRestore()
      }
      const resolve = async () => {
        if (mode === 'serious_business') return engine.applyRanking(code, czarId!, ['0', '1', '2'])
        if (mode === 'godmode') {
          const reveal = events.find((e) => e.type === 'card_revealed' && e.submissionIndex === 0)!
          const owner = [...originals].find(([, hand]) => hand.includes(reveal.fills![0]!.id))![0]
          for (const p of submitters) await engine.castVote(code, p.id, p.id === owner ? '1' : '0')
          return
        }
        if (mode === 'survival') {
          const turn = events.filter((e) => e.type === 'elimination_turn').at(-1)!.playerId!
          await engine.eliminateSubmission(code, turn, '0')
          await expect
            .poll(() => events.filter((e) => e.type === 'elimination_turn').length)
            .toBe(2)
          await engine.eliminateSubmission(
            code,
            events.filter((e) => e.type === 'elimination_turn').at(-1)!.playerId!,
            '1',
          )
          return
        }
        return engine.pickWinner(code, czarId!, '0')
      }
      await expect(resolve()).rejects.toThrow()
      restoreFault()
      for (const table of ['game_rounds', 'game_sessions'])
        await sql.unsafe(`DROP TRIGGER IF EXISTS fail_completion ON ${table}`)
      await sql.unsafe('DROP FUNCTION IF EXISTS fail_completion()')
      await engine.restoreRoundTimers()
      await engine.restoreRoundTimers()
      const terminal = finishesGame ? 'game_over' : 'round_started'
      await expect
        .poll(
          () =>
            events.filter((e) => e.type === terminal && (terminal === 'game_over' || e.round === 2))
              .length,
        )
        .toBe(1)
      const outcomes = events.filter((e) => e.type === 'round_won' || e.type === 'round_ranked')
      expect(outcomes).toHaveLength(1)
      if (mode !== 'serious_business')
        expect(outcomes[0]!.scores!.map((p) => p.score).sort()).toEqual([0, 0, 0, 0, 1])
      const ends = events.filter((e) => e.type === 'round_end')
      expect(ends).toHaveLength(1)
      expect(ends[0]!.activatedPlayers).toEqual([queued!.id])
      const refills = events.filter((e) => e.type === 'hand_update')
      expect(refills).toHaveLength(submitters.length + 1)
      const delivered: string[] = []
      for (const refill of refills) {
        expect(refill.hand).toHaveLength(10)
        const ids = refill.hand!.map((c) => c.id)
        delivered.push(...ids)
        const retained = originals.get(refill.playerId!)?.slice(prompt.pick) ?? []
        expect(ids.slice(0, retained.length)).toEqual(retained)
      }
      expect(new Set(delivered).size).toBe(delivered.length)
      // A recovered successor accepts the queued player's real hand as a play.
      if (!finishesGame) {
        const next = events.filter((e) => e.type === 'round_started').at(-1)!
        const playable = refills.find((e) => e.playerId !== next.czarId)!
        await engine.submitCards(
          code,
          playable.playerId!,
          playable.hand!.slice(0, next.prompt!.pick).map((c) => c.id),
        )
      }
    } finally {
      restoreFault()
      for (const table of ['game_rounds', 'game_sessions'])
        await sql.unsafe(`DROP TRIGGER IF EXISTS fail_completion ON ${table}`)
      await sql.unsafe('DROP FUNCTION IF EXISTS fail_completion()')
      const keys = await redis.keys(`game:${code}*`)
      if (keys.length) await redis.del(...keys)
      await db.delete(gameRounds).where(eq(gameRounds.sessionId, session!.id))
      await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, session!.id))
      await db.delete(gameSessions).where(eq(gameSessions.id, session!.id))
      await subscriber.quit()
    }
  },
  20000,
)
