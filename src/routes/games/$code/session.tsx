import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Scoreboard } from '~/components/game/Scoreboard'
import { HandDock } from '~/components/game/HandDock'
import { SubmissionsGrid } from '~/components/game/SubmissionsGrid'
import { PromptStage } from '~/components/game/PromptStage'
import { useSession } from '~/hooks/useSession'
import { useGameSocket } from '~/hooks/useGameSocket'
import type { BlackCard, Card, GamePhase, PlayerScore, Submission } from '~/lib/types'

export const Route = createFileRoute('/games/$code/session')({
  component: SessionScreen,
})

function SessionScreen() {
  const navigate = useNavigate()
  const { code } = Route.useParams()
  const { session, setSession } = useSession()

  const [round, setRound] = useState(0)
  const [phase, setPhase] = useState<GamePhase>('picking')
  const [prompt, setPrompt] = useState<BlackCard | null>(null)
  const [czarId, setCzarId] = useState<string | null>(null)
  const [hand, setHand] = useState<Card[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [scores, setScores] = useState<PlayerScore[]>([])
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [revealIndex, setRevealIndex] = useState(-1)
  const [winnerId, setWinnerId] = useState<string | null>(null)
  // Winner's handle for the result badge. Resolved from scores by the
  // winning playerId — the grid highlights by submissionId, but the
  // client never maps submission→playerId, so the name must come from
  // round_won.winnerId / the snapshot's winnerId (both playerIds).
  const [winnerName, setWinnerName] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(0)
  const [expected, setExpected] = useState(0)
  // Read inside the socket handler without putting `round` in the effect
  // deps — re-subscribing mid-game drops WS frames in the cleanup→setup gap.
  const roundRef = useRef(round)
  useEffect(() => {
    roundRef.current = round
  }, [round])

  const myId = session?.playerId ?? ''
  const isCzar = czarId === myId
  const czarScore = scores.find((s) => s.playerId === czarId)
  const czarName = czarScore?.username ?? 'Judge'

  const { on, send } = useGameSocket(code, session?.sessionToken ?? null, session?.anonId ?? '')

  useEffect(() => {
    const off = on((event) => {
      if (event.type === 'state_snapshot') {
        // Hydration path: the session WS connects after navigation, so the
        // live game_started/round_started already fired on the lobby socket.
        // The rejoin reply carries the authoritative round state.
        const s = event.state
        setRound(s.round)
        setPrompt(s.prompt)
        setCzarId(s.czarId)
        setScores(s.scores)
        setSubmissions(s.submissions)
        setRevealIndex(s.revealIndex)
        setWinnerId(s.winnerId)
        // Snapshot winnerId is a playerId (server's getRoundWinner);
        // resolve its handle from the snapshot scores.
        setWinnerName(s.scores.find((x) => x.playerId === s.winnerId)?.username ?? null)
        setSubmitted(s.submitted)
        setExpected(s.expected)
        if (s.hand) setHand(s.hand)
        setPhase(s.phase === 'picking' && s.czarId === myId ? 'waiting' : s.phase)
      }
      if (event.type === 'round_started') {
        setRound(event.round)
        setPrompt(event.prompt)
        setCzarId(event.czarId)
        setSelected([])
        setSubmissions([])
        setRevealIndex(-1)
        setWinnerId(null)
        setWinnerName(null)
        setSubmitted(event.submitted)
        setExpected(event.expected)
        if (event.hand) setHand(event.hand)
        setPhase(event.czarId === myId ? 'waiting' : 'picking')
      }
      if (event.type === 'hand_update' && event.playerId === myId) {
        setHand(event.hand)
      }
      if (event.type === 'player_played' || event.type === 'player_skipped') {
        // Server-authoritative progress: reaches submitted === expected
        // exactly when the round resolves (skips shrink expected).
        setSubmitted(event.submitted)
        setExpected(event.expected)
      }
      if (event.type === 'reveal_start') {
        setPhase('reveal')
        setRevealIndex(0)
        // Rebuild cleanly from card_revealed; the server's permuted index
        // is the authoritative opaque submissionId used by pick/vote.
        setSubmissions([])
      }
      if (event.type === 'card_revealed') {
        setRevealIndex(event.submissionIndex + 1)
        setSubmissions((prev) => {
          const next = [...prev]
          next[event.submissionIndex] = {
            submissionId: String(event.submissionIndex),
            fills: event.fills,
          }
          return next
        })
      }
      if (event.type === 'round_won') {
        // N-3: SubmissionsGrid highlights by submissionId, so track the
        // winning submission — not event.winnerId, which is a playerId.
        // The grid stays up (phase still 'judging', winnerId set) until
        // the server's ROUND_RESULT_PAUSE_MS-delayed round_started — the
        // pace is server-driven, never a client timer (which round_started
        // used to race, so the winner never showed).
        setWinnerId(event.submissionId)
        setScores(event.scores)
        // event.winnerId is the winning playerId; resolve its handle
        // from the same scores payload for the result badge (#1).
        setWinnerName(event.scores.find((x) => x.playerId === event.winnerId)?.username ?? null)
      }
      if (event.type === 'round_end') {
        const myHand = event.handsRefilled[myId]
        if (myHand) setHand(myHand)
      }
      if (event.type === 'game_over') {
        sessionStorage.setItem(
          'cab_last_game_over',
          JSON.stringify({
            finalScores: event.finalScores,
            winnerId: event.winnerId,
            mode: event.mode,
            totalRounds: roundRef.current,
          }),
        )
        void navigate({ to: '/games/$code/end', params: { code } })
      }
      if (event.type === 'auth_error') {
        setSession(null)
        void navigate({ to: '/' })
      }
    })
    return () => {
      off()
    }
  }, [on, code, navigate, setSession, myId])

  const handleToggle = useCallback(
    (cardId: string) => {
      if (!prompt) return
      setSelected((prev) => {
        if (prev.includes(cardId)) return prev.filter((id) => id !== cardId)
        // Quota full: ignore taps on new cards (#6). Evicting pick #1 to
        // append the tap silently renumbered every remaining pick. The
        // player must explicitly deselect one first; HandDock renumbers
        // correctly via selected.indexOf on deselect/reselect.
        if (prev.length >= prompt.pick) return prev
        return [...prev, cardId]
      })
    },
    [prompt],
  )

  const handleSubmit = useCallback(() => {
    if (!prompt || selected.length < prompt.pick) return
    send({ type: 'play', cardIds: selected })
    setPhase('waiting')
  }, [prompt, selected, send])

  // The server sends reveal_start automatically; this is a no-op UI affordance
  const handleStartReveal = useCallback(() => {
    // server controls reveal; nothing to send
  }, [])

  const handlePickWinner = useCallback(
    (submissionId: string) => {
      send({ type: 'pick', submissionId })
      setWinnerId(submissionId)
    },
    [send],
  )

  return (
    <div className="scene game-scene">
      <Topbar
        right={
          <>
            <div className="pill">
              <span className="dot live" />
              {round > 0 ? `Round ${round}` : 'Round —'}
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate({ to: '/games/$code/lobby', params: { code } })}
            >
              Leave
            </button>
          </>
        }
      />

      <div className="game-wrap">
        {scores.length > 0 && <Scoreboard scores={scores} czarId={czarId} />}

        {prompt ? (
          <>
            {phase === 'picking' || phase === 'waiting' ? (
              <div className="stage stage-solo">
                <PromptStage
                  prompt={prompt}
                  phase={phase}
                  czarName={czarName}
                  submitted={submitted}
                  expected={expected}
                />
              </div>
            ) : (
              <div className="stage">
                <PromptStage
                  prompt={prompt}
                  phase={phase}
                  czarName={czarName}
                  submitted={submitted}
                  expected={expected}
                />
                {(phase === 'judging' || phase === 'reveal') && (
                  <SubmissionsGrid
                    submissions={submissions}
                    phase={phase as 'judging' | 'reveal'}
                    revealIndex={revealIndex}
                    winnerId={winnerId}
                    winnerName={winnerName}
                    isCzar={isCzar}
                    onStartReveal={handleStartReveal}
                    onPickWinner={handlePickWinner}
                  />
                )}
              </div>
            )}

            {phase === 'picking' && !isCzar && hand.length > 0 && (
              <HandDock
                hand={hand}
                selected={selected}
                blanks={prompt.pick}
                onToggle={handleToggle}
                onSubmit={handleSubmit}
              />
            )}

            {phase === 'judging' && isCzar && (
              <div className="judge-bar">
                <span className="muted">All cards in. Time to read them and pick a winner.</span>
                <button className="btn btn-primary btn-sm" onClick={handleStartReveal}>
                  Start reveal →
                </button>
              </div>
            )}

            {phase === 'transition' && (
              <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
                <div className="muted">Next round starting…</div>
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
            <div className="muted">Waiting for round to start…</div>
          </div>
        )}
      </div>
    </div>
  )
}
