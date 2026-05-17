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
import { WINNER_PAUSE } from '~/lib/timing'

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
  // round_won schedules a delayed phase→transition. If the next round starts
  // before WINNER_PAUSE elapses, that stale timer would clobber the new
  // round's phase — hold it so round_started / unmount can cancel it.
  const winnerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
        if (s.hand) setHand(s.hand)
        setPhase(s.phase === 'picking' && s.czarId === myId ? 'waiting' : s.phase)
      }
      if (event.type === 'round_started') {
        if (winnerTimer.current) {
          clearTimeout(winnerTimer.current)
          winnerTimer.current = null
        }
        setRound(event.round)
        setPrompt(event.prompt)
        setCzarId(event.czarId)
        setSelected([])
        setSubmissions([])
        setRevealIndex(-1)
        setWinnerId(null)
        if (event.hand) setHand(event.hand)
        setPhase(event.czarId === myId ? 'waiting' : 'picking')
      }
      if (event.type === 'hand_update' && event.playerId === myId) {
        setHand(event.hand)
      }
      if (event.type === 'player_played') {
        // another player submitted — add a placeholder submission for progress tracking
        setSubmissions((prev) => [...prev, { submissionId: event.playerId, fills: [] }])
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
        setWinnerId(event.submissionId)
        setScores(event.scores)
        if (winnerTimer.current) clearTimeout(winnerTimer.current)
        winnerTimer.current = setTimeout(() => setPhase('transition'), WINNER_PAUSE)
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
            totalRounds: round,
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
      if (winnerTimer.current) clearTimeout(winnerTimer.current)
    }
  }, [on, code, navigate, setSession, myId, round])

  const handleToggle = useCallback(
    (cardId: string) => {
      if (!prompt) return
      setSelected((prev) => {
        if (prev.includes(cardId)) return prev.filter((id) => id !== cardId)
        if (prev.length >= prompt.pick) return [...prev.slice(1), cardId]
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
                  submissions={submissions}
                />
              </div>
            ) : (
              <div className="stage">
                <PromptStage
                  prompt={prompt}
                  phase={phase}
                  czarName={czarName}
                  submissions={submissions}
                />
                {(phase === 'judging' || phase === 'reveal') && (
                  <SubmissionsGrid
                    submissions={submissions}
                    phase={phase as 'judging' | 'reveal'}
                    revealIndex={revealIndex}
                    winnerId={winnerId}
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
