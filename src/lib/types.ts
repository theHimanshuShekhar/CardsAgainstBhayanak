// ── Player & role ────────────────────────────────────────────────

export type Role = 'player' | 'spectator'

export type PlayerStatus = 'active' | 'queued' | 'spectator' | 'grace' | 'dropped'

export type GamePlayer = {
  id: string
  username: string
  role: Role
  status: PlayerStatus
  score: number
  isHost: boolean
  isRando: boolean
  discardsUsed: number
  hasGambled?: boolean
  posthogAnonId?: string
  joinedAt: string
}

export type PlayerScore = {
  playerId: string
  username: string
  score: number
  isJudge: boolean
  isRando: boolean
}

// ── Cards ─────────────────────────────────────────────────────────

export type Card = {
  id: string
  text: string
}

export type BlackCard = Card & { pick: 1 | 2 | 3 }

export type Hand = Card[]

export type Pack = {
  id: string
  name: string
  slug: string
  cardCount: number
}

// ── Submissions ───────────────────────────────────────────────────

export type Submission = {
  submissionId: string
  // Rejoin snapshots keep shuffled slots but redact fills until reveal.
  fills: Card[]
  playerId?: string
  rank?: 1 | 2 | 3
  eliminated?: boolean
}

// ── Phase & session state ─────────────────────────────────────────

export type GamePhase =
  | 'picking'
  | 'waiting'
  | 'judging'
  | 'eliminating'
  | 'ranking'
  | 'reveal'
  | 'transition'

export type SessionState = {
  phase: GamePhase
  round: number
  prompt: BlackCard
  czarId: string | null
  // host_changed migrates this mid-game (longest-present active player),
  // so the snapshot is the floor — the client keeps it in sync via the
  // broadcast event.
  hostId: string | null
  // The config doesn't change mid-game (lobby PATCH is rejected once
  // active), so the rejoin snapshot is enough — the client uses it to
  // decide which house-rule buttons to render.
  config: GameConfig
  hand?: Hand
  submissions: Submission[]
  scores: PlayerScore[]
  revealIndex: number
  /** @deprecated Compatibility alias for winningPlayerId; never a submission ID. */
  winnerId: string | null
  winningPlayerId: string | null
  winningSubmissionId: string | null
  // Picking-phase progress (server-authoritative); reaches submitted ===
  // expected exactly when the round resolves.
  submitted: number
  expected: number
  // Epoch ms when the round timer fires; null when timer is Off. Used by
  // the client purely for a display-only countdown — the server remains
  // the sole authority on phase transitions.
  roundTimerExpiresAt: number | null
  eliminationTurnPlayerId?: string
  voteTally?: Record<string, number>
  ranking?: Submission[]
  // Never Have I Ever: only the requesting player's count is needed —
  // the button disables at 3, and the engine is authoritative on the cap.
  myDiscardsUsed: number
  // Gambling (base mechanic): the engine flips this when the player wagers
  // and the round resolves; the rejoin must restore so the player can finish
  // a gamble across a refresh.
  myHasGambled: boolean
  // Private action receipts let reconnects reconcile a lost acknowledgement.
  mySubmissionCount: number
  myVotedSubmissionId: string | null
}

// ── Session-level status ──────────────────────────────────────────

export type SessionStatus = 'lobby' | 'active' | 'paused' | 'ended' | 'abandoned'

// ── House rule IDs ────────────────────────────────────────────────

export type ModalRuleId = 'godmode' | 'survival' | 'serious_business'

export type OrthogonalRuleId =
  | 'rebooting'
  | 'packing_heat'
  | 'rando'
  | 'never_have_i_ever'
  | 'happy_ending'

export type RuleId = ModalRuleId | OrthogonalRuleId

// ── Config ────────────────────────────────────────────────────────

export type GameConfig = {
  maxPlayers: number
  roundsToWin: number
  timer: '30s' | '60s' | '90s' | 'Off'
  packs: string[]
  rules: RuleId[]
}

// ── Game-over outcome ─────────────────────────────────────────────

export type GameOverMode = 'normal' | 'happy_ending' | 'rando_won' | 'deck_exhausted' | 'abandoned'

// Post-game host action: replay the same room. 'rematch' goes straight
// into a fresh game; 'lobby' returns everyone to the lobby to reconfigure.
export type ResetMode = 'rematch' | 'lobby'

// ── Error codes ───────────────────────────────────────────────────

export type ErrorCode =
  | 'not_authorized'
  | 'invalid_token'
  | 'player_dropped'
  | 'spectator_action'
  | 'invalid_state'
  | 'rate_limited'
  | 'room_full'
  | 'room_not_found'
  | 'duplicate_username'
  | 'conflicting_rules'
  | 'host_only'
  | 'score_too_low'
  | 'internal_error'

// ── Pre-game draft (client-side only) ────────────────────────────

export type GameDraft = GameConfig & {
  username: string
  roomCode?: string
  playerId?: string
  role?: Role
}

// ── localStorage shape ────────────────────────────────────────────

export type CabSession = {
  roomCode: string
  playerId: string
  sessionToken: string
  username: string
  role: Role
  anonId: string
}

// ── WebSocket type aliases ────────────────────────────────────────
// Aliases used by WS handler and hooks
export type ClientToServerEvent = ClientMessage
export type ServerToClientEvent = ServerMessage

// ── WebSocket: Client → Server ────────────────────────────────────

export type ClientMessage =
  | { type: 'auth'; sessionToken: string; anonId?: string }
  | { type: 'rejoin' }
  | { type: 'play'; cardIds: string[]; commandId?: string }
  | { type: 'gamble' }
  | { type: 'pick'; submissionId: string; commandId?: string }
  | { type: 'rank'; ranking: string[] }
  | { type: 'vote'; submissionId: string; commandId?: string }
  | { type: 'eliminate'; submissionId: string }
  | { type: 'redraw' }
  | { type: 'confess_discard'; cardId: string }
  | { type: 'happy_ending' }
  | { type: 'leave' }
  | { type: 'ping' }

// ── WebSocket: Server → Client ────────────────────────────────────

export type ServerMessage =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; code: ErrorCode; message: string }
  | { type: 'state_snapshot'; state: SessionState }
  | { type: 'lobby_snapshot'; players: GamePlayer[]; config: GameConfig; gameStatus: SessionStatus }
  | { type: 'player_joined'; player: GamePlayer }
  | { type: 'player_left'; playerId: string }
  | { type: 'host_changed'; hostId: string }
  | { type: 'game_started'; firstRound: number }
  | {
      type: 'round_started'
      round: number
      prompt: BlackCard
      czarId: string | null
      hand?: Hand
      submitted: number
      expected: number
      roundTimerExpiresAt: number | null
    }
  | { type: 'player_played'; playerId: string; submitted: number; expected: number }
  | { type: 'hand_update'; playerId: string; hand: Hand; discardsUsed?: number }
  | { type: 'scores_update'; scores: PlayerScore[] }
  | { type: 'player_gambled'; playerId: string }
  | { type: 'player_skipped'; playerId: string; round: number; submitted: number; expected: number }
  | { type: 'reveal_start'; submissionCount: number }
  | { type: 'card_revealed'; submissionIndex: number; fills: Card[] }
  | {
      type: 'round_won'
      winningPlayerId: string
      winningSubmissionId: string
      /** @deprecated Compatibility alias for winningPlayerId. */
      winnerId: string
      /** @deprecated Compatibility alias for winningSubmissionId. */
      submissionId: string
      scores: PlayerScore[]
    }
  | {
      type: 'round_ranked'
      winningPlayerId: string
      winningSubmissionId: string
      ranking: Submission[]
      scoresDelta: Record<string, number>
    }
  | { type: 'elimination_turn'; playerId: string }
  | { type: 'card_eliminated'; submissionId: string; byPlayerId: string }
  | { type: 'vote_tally'; votes: Record<string, number> }
  | { type: 'round_voided'; round: number; reason: string }
  | { type: 'round_end'; activatedPlayers: string[] }
  | { type: 'game_over'; finalScores: PlayerScore[]; winnerId: string; mode: GameOverMode }
  | { type: 'game_reset'; mode: ResetMode }
  | { type: 'command_accepted'; commandId: string }
  | { type: 'error'; code: ErrorCode; message: string; commandId?: string; retryAfterMs?: number }
  | { type: 'pong' }
