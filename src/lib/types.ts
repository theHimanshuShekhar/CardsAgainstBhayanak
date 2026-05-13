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
  hand?: Hand
  submissions: Submission[]
  scores: PlayerScore[]
  revealIndex: number
  winnerId: string | null
  eliminationTurnPlayerId?: string
  voteTally?: Record<string, number>
  ranking?: Submission[]
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
  | { type: 'play'; cardIds: string[] }
  | { type: 'gamble' }
  | { type: 'pick'; submissionId: string }
  | { type: 'rank'; ranking: string[] }
  | { type: 'vote'; submissionId: string }
  | { type: 'eliminate'; submissionId: string }
  | { type: 'redraw' }
  | { type: 'confess_discard'; cardId: string }
  | { type: 'leave' }
  | { type: 'ping' }

// ── WebSocket: Server → Client ────────────────────────────────────

export type ServerMessage =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; code: ErrorCode; message: string }
  | { type: 'state_snapshot'; state: SessionState }
  | { type: 'player_joined'; player: GamePlayer }
  | { type: 'player_left'; playerId: string }
  | { type: 'game_started'; firstRound: number }
  | { type: 'round_started'; round: number; prompt: BlackCard; czarId: string | null; hand?: Hand }
  | { type: 'player_played'; playerId: string }
  | { type: 'player_gambled'; playerId: string }
  | { type: 'player_skipped'; playerId: string; round: number }
  | { type: 'reveal_start' }
  | { type: 'card_revealed'; submissionIndex: number; fills: Card[] }
  | { type: 'round_won'; winnerId: string; submissionId: string; scores: PlayerScore[] }
  | { type: 'round_ranked'; ranking: Submission[]; scoresDelta: Record<string, number> }
  | { type: 'elimination_turn'; playerId: string }
  | { type: 'card_eliminated'; submissionId: string; byPlayerId: string }
  | { type: 'vote_tally'; votes: Record<string, number> }
  | { type: 'round_end'; activatedPlayers: string[]; handsRefilled: Record<string, Hand> }
  | { type: 'game_over'; finalScores: PlayerScore[]; winnerId: string; mode: GameOverMode }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'pong' }
