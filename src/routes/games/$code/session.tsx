import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { HostMenu } from '~/components/ui/HostMenu'
import { Scoreboard } from '~/components/game/Scoreboard'
import { HandDock } from '~/components/game/HandDock'
import { SubmissionsGrid } from '~/components/game/SubmissionsGrid'
import { PromptStage } from '~/components/game/PromptStage'
import { useSession } from '~/hooks/useSession'
import { useGameSocket } from '~/hooks/useGameSocket'
import type { BlackCard, Card, GameConfig, GamePhase, PlayerScore, Submission } from '~/lib/types'

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
  const [hostId, setHostId] = useState<string | null>(null)
  // Rule visibility flags read from the rejoin snapshot — the config is
  // immutable once a game is active, so set-and-forget is fine.
  const [config, setConfig] = useState<GameConfig | null>(null)
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
  // Server-authoritative round-timer expiry (epoch ms; null when timer
  // Off). Drives a display-only countdown — never a client phase timer.
  const [timerExpiresAt, setTimerExpiresAt] = useState<number | null>(null)
  // Per-rule state for this player. Hydrated from the rejoin snapshot
  // and live-updated via hand_update / player_gambled.
  const [discardsUsed, setDiscardsUsed] = useState(0)
  const [hasGambled, setHasGambled] = useState(false)
  // Gambling submission tracker: a gambler submits twice in one picking
  // phase. After the first play we keep the UI in `picking` (cleared
  // selection); only the second play moves us to `waiting`. Resets on
  // round_started.
  const [mySubmissionsSent, setMySubmissionsSent] = useState(0)
  // Never Have I Ever: a second tap on a hand card normally toggles
  // selection — entering discard mode reroutes the next click to a
  // confess_discard send. Cleared after the click or by toggling off.
  const [discardMode, setDiscardMode] = useState(false)
  // God Is Dead: per-round vote state. The engine enforces one vote per
  // round; the client mirrors that so all vote buttons disable after a
  // tap, and renders the live tally beneath each card.
  const [myVotedSubmissionId, setMyVotedSubmissionId] = useState<string | null>(null)
  const [voteTally, setVoteTally] = useState<Record<string, number>>({})
  // Survival of the Fittest: the engine drives whose turn it is via
  // `elimination_turn` events. The client also tracks locally-eliminated
  // submissionIds — the card_eliminated event only carries the id, not a
  // refreshed submission — so the "Eliminated" label and disabled state
  // render immediately, not just on rejoin.
  const [eliminationTurn, setEliminationTurn] = useState<string | null>(null)
  const [eliminatedIds, setEliminatedIds] = useState<Set<string>>(new Set())
  // Serious Business: the czar builds an ordered ranking client-side and
  // sends it via `{type:'rank', ranking}` once confirmed. The list holds
  // submissionIds in 1st/2nd/3rd order.
  const [myRanking, setMyRanking] = useState<string[]>([])
  // `round_ranked` arrives with the full ranking. We display the engine's
  // resolved order in the rank badge by storing it; non-czars need it too.
  const [serverRanking, setServerRanking] = useState<Submission[] | null>(null)
  // Read inside the socket handler without putting `round` in the effect
  // deps — re-subscribing mid-game drops WS frames in the cleanup→setup gap.
  const roundRef = useRef(round)
  useEffect(() => {
    roundRef.current = round
  }, [round])

  const myId = session?.playerId ?? ''
  const isCzar = czarId === myId
  const isHost = hostId !== null && hostId === myId
  const myScore = scores.find((s) => s.playerId === myId)?.score ?? 0
  const czarScore = scores.find((s) => s.playerId === czarId)
  const czarName = czarScore?.username ?? 'Judge'
  // Rebooting allows redraw during picking (HandDock is mounted) when the
  // player has at least one point. Round-1 isn't excluded by the engine,
  // so the score check naturally gates it.
  const canRedraw = !!config?.rules.includes('rebooting') && myScore >= 1 && !isCzar
  // Never Have I Ever: the 3-per-game cap is the engine floor; the
  // button mirrors it so a stale click can't slip past the limit.
  const canDiscard = !!config?.rules.includes('never_have_i_ever') && discardsUsed < 3 && !isCzar
  // Happy Ending: the host menu only matters while a game is active and
  // the rule is on; the engine ignores the trigger otherwise.
  const showHappyEndingTrigger = isHost && !!config?.rules.includes('happy_ending')
  // Modal rules are mutually exclusive AND disable Gambling. Compute once
  // from config so the gate is impossible to mis-spell.
  const modalActive =
    !!config?.rules.includes('godmode') ||
    !!config?.rules.includes('survival') ||
    !!config?.rules.includes('serious_business')
  const isGodmode = !!config?.rules.includes('godmode')
  const isSurvival = !!config?.rules.includes('survival')
  const isSerious = !!config?.rules.includes('serious_business')
  // Gambling base mechanic: enabled outside modal rules, after round 1,
  // for non-Czars with ≥1 pt who haven't already gambled this round.
  const canGamble = !modalActive && round > 1 && myScore >= 1 && !hasGambled && !isCzar
  // Godmode renders without a Czar (czarId === null). Voting opens once
  // every submission has been revealed — the engine flips the phase to
  // `waiting` post-stagger but doesn't push a phase_changed event, so we
  // compute readiness from the local revealIndex instead.
  const canVote =
    isGodmode &&
    phase === 'reveal' &&
    submissions.length > 0 &&
    revealIndex >= submissions.length &&
    !myVotedSubmissionId &&
    winnerId == null
  // Survival: only the elimination-turn holder can eliminate, and only
  // once every card is face-up. The engine flips server phase to
  // 'eliminating' silently — the client stays on 'reveal' until winner.
  const canEliminate =
    isSurvival &&
    phase === 'reveal' &&
    submissions.length > 0 &&
    revealIndex >= submissions.length &&
    eliminationTurn === myId &&
    winnerId == null
  // Serious Business: the czar ranks top 3 once the reveal completes.
  const canRank =
    isSerious &&
    phase === 'reveal' &&
    submissions.length > 0 &&
    revealIndex >= submissions.length &&
    isCzar &&
    serverRanking == null &&
    winnerId == null

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
        setHostId(s.hostId)
        setConfig(s.config)
        setScores(s.scores)
        setSubmissions(s.submissions)
        setRevealIndex(s.revealIndex)
        setWinnerId(s.winnerId)
        // Snapshot winnerId is a playerId (server's getRoundWinner);
        // resolve its handle from the snapshot scores.
        setWinnerName(s.scores.find((x) => x.playerId === s.winnerId)?.username ?? null)
        setSubmitted(s.submitted)
        setExpected(s.expected)
        setTimerExpiresAt(s.roundTimerExpiresAt)
        setDiscardsUsed(s.myDiscardsUsed)
        if (s.hand) setHand(s.hand)
        // Survival/SB rejoin: restore the elimination-turn pointer and any
        // server-resolved ranking. Eliminated flags ride on submissions
        // already (state.getSubmissions preserves them).
        setEliminationTurn(s.eliminationTurnPlayerId ?? null)
        setServerRanking(s.ranking ?? null)
        setEliminatedIds(
          new Set(s.submissions.filter((x) => x.eliminated).map((x) => x.submissionId)),
        )
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
        setTimerExpiresAt(event.roundTimerExpiresAt)
        if (event.hand) setHand(event.hand)
        setPhase(event.czarId === myId ? 'waiting' : 'picking')
        // Discard mode is per-tap; reset on round boundary so a stale
        // armed state doesn't survive into a new picking phase.
        setDiscardMode(false)
        // Per-round gambling + voting state. The engine resets the
        // hasGambled flag at round_end; mirror it locally so the Wager
        // button re-enables for the next round without a refresh.
        setHasGambled(false)
        setMySubmissionsSent(0)
        setMyVotedSubmissionId(null)
        setVoteTally({})
        // Survival/SB: per-round state must reset alongside submissions
        // so a stale eliminate-turn / ranking doesn't survive into the
        // fresh round_started.
        setEliminationTurn(null)
        setEliminatedIds(new Set())
        setMyRanking([])
        setServerRanking(null)
      }
      if (event.type === 'host_changed') {
        setHostId(event.hostId)
      }
      if (event.type === 'hand_update' && event.playerId === myId) {
        setHand(event.hand)
        if (event.discardsUsed !== undefined) setDiscardsUsed(event.discardsUsed)
      }
      // Off-cycle score changes (Rebooting burns a point; future: settled
      // gambles, etc.). The round_won path carries scores too, but those
      // mutations may fire mid-round; without this the scoreboard lags.
      if (event.type === 'scores_update') {
        setScores(event.scores)
      }
      // Gambling: server confirms the wager and pushes a fresh hand
      // (via hand_update, handled above). The flag flips so the Wager
      // button disappears and the gambler keeps `picking` for a 2nd play.
      if (event.type === 'player_gambled' && event.playerId === myId) {
        setHasGambled(true)
      }
      // God Is Dead: live tally for every voter, including a reset to
      // {} on tie revote. Renders as a chip beneath each submission.
      if (event.type === 'vote_tally') {
        setVoteTally(event.votes)
        // Tie revote → engine clears the tally and reopens voting.
        if (Object.keys(event.votes).length === 0) setMyVotedSubmissionId(null)
      }
      // Survival: the engine fires elimination_turn at reveal end and
      // again after each elimination, cycling through active non-Czar
      // submitters. Mirror locally so the elim button enables only on
      // the active player's page.
      if (event.type === 'elimination_turn') {
        setEliminationTurn(event.playerId)
      }
      // Survival: mark the submission eliminated on every client. The
      // engine will follow up with `elimination_turn` for the next player
      // or `round_won` when only one card remains.
      if (event.type === 'card_eliminated') {
        setEliminatedIds((prev) => {
          const next = new Set(prev)
          next.add(event.submissionId)
          return next
        })
      }
      // Serious Business: engine emits the final ranking + score delta.
      // Apply scoresDelta to local scores so the scoreboard reflects the
      // 3/2/1 award without waiting for the next round's payload.
      if (event.type === 'round_ranked') {
        setServerRanking(event.ranking)
        // Pin the top-ranked submission as the round winner so the
        // grid highlights it and the round_end pause renders cleanly.
        const top = event.ranking[0]
        if (top) setWinnerId(top.submissionId)
        // Apply scoresDelta and resolve the top-ranked player's handle
        // in the same setter so we read the freshest scores list.
        setScores((prev) => {
          const next = prev.map((p) =>
            event.scoresDelta[p.playerId] != null
              ? { ...p, score: p.score + (event.scoresDelta[p.playerId] ?? 0) }
              : p,
          )
          if (top?.playerId) {
            setWinnerName(next.find((x) => x.playerId === top.playerId)?.username ?? null)
          }
          return next
        })
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
      // S3-NEW-B: a voided round (czar dropped, or timer expiry with <2
      // submitters) is followed immediately by a fresh round_started from
      // the engine. Drop the dead round's UI state so the incoming round
      // doesn't render against a stale winner badge / partial submissions.
      if (event.type === 'round_voided') {
        setSelected([])
        setSubmissions([])
        setRevealIndex(-1)
        setWinnerId(null)
        setWinnerName(null)
      }
      // S3-NEW-B: rematch/back-to-lobby reset. Normally a player is on
      // /end when this fires (the host can only reset from `ended`), but
      // a defensive handler keeps a still-mounted session screen sane
      // if it raced the navigation. 'lobby' → bounce to /lobby; 'rematch'
      // → clear so the incoming game_started+round_started repopulate.
      if (event.type === 'game_reset') {
        if (event.mode === 'lobby') {
          void navigate({ to: '/games/$code/lobby', params: { code } })
        } else {
          setRound(0)
          setPrompt(null)
          setSelected([])
          setSubmissions([])
          setRevealIndex(-1)
          setWinnerId(null)
          setWinnerName(null)
          setTimerExpiresAt(null)
        }
      }
      if (event.type === 'game_over') {
        // S3-NEW-E: stamp the roomCode so end.tsx can reject a stale
        // payload from a previous game's tab (sessionStorage survives
        // navigation, and a direct visit to a different /end without
        // going through session.tsx would otherwise read someone else's
        // result).
        sessionStorage.setItem(
          'cab_last_game_over',
          JSON.stringify({
            code,
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
      // NHIE discard mode: the next card tap discards the card instead of
      // toggling its selection. One-shot — mode clears either way so a
      // mis-aimed tap doesn't burn a discard.
      if (discardMode) {
        setDiscardMode(false)
        send({ type: 'confess_discard', cardId })
        return
      }
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
    [prompt, discardMode, send],
  )

  const handleRedraw = useCallback(() => {
    send({ type: 'redraw' })
  }, [send])

  const handleToggleDiscardMode = useCallback(() => {
    setDiscardMode((prev) => !prev)
  }, [])

  const handleHappyEnding = useCallback(() => {
    send({ type: 'happy_ending' })
  }, [send])

  const handleGamble = useCallback(() => {
    send({ type: 'gamble' })
  }, [send])

  const handleVote = useCallback(
    (submissionId: string) => {
      // Optimistic disable — engine will silently drop self-votes
      // (which we already gate by not rendering for own submission once
      // playerId is leaked, but during voting submissions are still
      // opaque, so the optimistic flag stands until vote_tally arrives).
      setMyVotedSubmissionId(submissionId)
      send({ type: 'vote', submissionId })
    },
    [send],
  )

  const handleSubmit = useCallback(() => {
    if (!prompt || selected.length < prompt.pick) return
    send({ type: 'play', cardIds: selected })
    // Gambling: a gambler submits twice in one picking phase. The first
    // play keeps the UI in `picking` (cleared selection, extra cards in
    // hand from the wager). Only the second play moves us to `waiting`.
    if (hasGambled && mySubmissionsSent === 0) {
      setSelected([])
      setMySubmissionsSent(1)
      return
    }
    setPhase('waiting')
  }, [prompt, selected, send, hasGambled, mySubmissionsSent])

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

  const handleEliminate = useCallback(
    (submissionId: string) => {
      // Optimistically mark eliminated so the button flips to "Eliminated"
      // before the broadcast lands; card_eliminated handler is idempotent.
      setEliminatedIds((prev) => {
        const next = new Set(prev)
        next.add(submissionId)
        return next
      })
      send({ type: 'eliminate', submissionId })
    },
    [send],
  )

  const handleRankTap = useCallback((submissionId: string) => {
    setMyRanking((prev) => {
      // Toggle out if already ranked; append (up to 3) otherwise.
      if (prev.includes(submissionId)) return prev.filter((id) => id !== submissionId)
      if (prev.length >= 3) return prev
      return [...prev, submissionId]
    })
  }, [])

  const handleConfirmRank = useCallback(() => {
    if (myRanking.length === 0) return
    send({ type: 'rank', ranking: myRanking })
  }, [myRanking, send])

  return (
    <div className="scene game-scene">
      <Topbar
        right={
          <>
            <div className="pill">
              <span className="dot live" />
              {round > 0 ? `Round ${round}` : 'Round —'}
            </div>
            {showHappyEndingTrigger && <HostMenu onEndEarly={handleHappyEnding} />}
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
                  roundTimerExpiresAt={timerExpiresAt}
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
                  roundTimerExpiresAt={timerExpiresAt}
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
                    mode={
                      isGodmode
                        ? 'godmode'
                        : isSurvival
                          ? 'survival'
                          : isSerious
                            ? 'serious_business'
                            : 'normal'
                    }
                    canVote={canVote}
                    myVotedSubmissionId={myVotedSubmissionId}
                    voteTally={voteTally}
                    onVote={handleVote}
                    canEliminate={canEliminate}
                    eliminatedIds={eliminatedIds}
                    onEliminate={handleEliminate}
                    canRank={canRank}
                    myRanking={myRanking}
                    onRankTap={handleRankTap}
                    onConfirmRank={handleConfirmRank}
                  />
                )}
              </div>
            )}

            {phase === 'picking' && !isCzar && hand.length > 0 && (
              <>
                {(canRedraw || canDiscard || canGamble) && (
                  <div className="rule-bar" data-testid="rule-bar">
                    {canRedraw && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleRedraw}
                        data-testid="redraw-btn"
                      >
                        Redraw (–1 pt)
                      </button>
                    )}
                    {canDiscard && (
                      <button
                        className={`btn btn-ghost btn-sm${discardMode ? ' is-armed' : ''}`}
                        onClick={handleToggleDiscardMode}
                        data-testid="discard-btn"
                      >
                        {discardMode ? 'Tap a card to discard…' : `Discard (${discardsUsed}/3)`}
                      </button>
                    )}
                    {canGamble && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleGamble}
                        data-testid="wager-btn"
                      >
                        Wager 1 pt
                      </button>
                    )}
                  </div>
                )}
                <HandDock
                  hand={hand}
                  selected={selected}
                  blanks={prompt.pick}
                  onToggle={handleToggle}
                  onSubmit={handleSubmit}
                />
              </>
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
