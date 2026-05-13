import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'

// ── Enums ────────────────────────────────────────────────────────

export const sessionStatusEnum = pgEnum('session_status', [
  'lobby',
  'active',
  'paused',
  'ended',
  'abandoned',
])

export const endModeEnum = pgEnum('end_mode', [
  'normal',
  'happy_ending',
  'rando_won',
  'deck_exhausted',
  'abandoned',
])

export const playerStatusEnum = pgEnum('player_status', [
  'active',
  'queued',
  'spectator',
  'grace',
  'dropped',
])

export const playerRoleEnum = pgEnum('player_role', ['player', 'spectator'])

// ── Tables ───────────────────────────────────────────────────────

export const packs = pgTable('packs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  cardCount: integer('card_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const blackCards = pgTable(
  'black_cards',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    packId: text('pack_id')
      .notNull()
      .references(() => packs.id),
    text: text('text').notNull(),
    pick: integer('pick').notNull(),
  },
  (t) => [unique().on(t.packId, t.text, t.pick)],
)

export const whiteCards = pgTable(
  'white_cards',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    packId: text('pack_id')
      .notNull()
      .references(() => packs.id),
    text: text('text').notNull(),
  },
  (t) => [unique().on(t.packId, t.text)],
)

export const gameSessions = pgTable(
  'game_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    code: char('code', { length: 6 }).notNull().unique(),
    status: sessionStatusEnum('status').notNull().default('lobby'),
    config: jsonb('config').notNull(),
    hostPlayerId: text('host_player_id'),
    winnerPlayerId: text('winner_player_id'),
    endMode: endModeEnum('end_mode'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_sessions_last_activity')
      .on(t.lastActivityAt)
      .where(sql`${t.status} IN ('active', 'paused')`),
  ],
)

export const gamePlayers = pgTable(
  'game_players',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text('session_id')
      .notNull()
      .references(() => gameSessions.id),
    username: text('username').notNull(),
    role: playerRoleEnum('role').notNull().default('player'),
    score: integer('score').notNull().default(0),
    status: playerStatusEnum('status').notNull().default('active'),
    isHost: boolean('is_host').notNull().default(false),
    isRando: boolean('is_rando').notNull().default(false),
    discardsUsed: integer('discards_used').notNull().default(0),
    posthogAnonId: text('posthog_anon_id'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.sessionId, t.username),
    // at most one Rando per game
    uniqueIndex('unique_rando_per_session')
      .on(t.sessionId)
      .where(sql`${t.isRando} = true`),
  ],
)

export const gameRounds = pgTable(
  'game_rounds',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text('session_id')
      .notNull()
      .references(() => gameSessions.id),
    roundNum: integer('round_num').notNull(),
    blackCardId: text('black_card_id')
      .notNull()
      .references(() => blackCards.id),
    czarPlayerId: text('czar_player_id').references(() => gamePlayers.id),
    winnerPlayerId: text('winner_player_id').references(() => gamePlayers.id),
    winningSubmissionFills: jsonb('winning_submission_fills'),
    ranking: jsonb('ranking'),
    voteTally: jsonb('vote_tally'),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.sessionId, t.roundNum),
    index('gin_winning_fills').on(t.winningSubmissionFills),
  ],
)

// ── Relations ────────────────────────────────────────────────────

export const packsRelations = relations(packs, ({ many }) => ({
  blackCards: many(blackCards),
  whiteCards: many(whiteCards),
}))

export const blackCardsRelations = relations(blackCards, ({ one }) => ({
  pack: one(packs, { fields: [blackCards.packId], references: [packs.id] }),
}))

export const whiteCardsRelations = relations(whiteCards, ({ one }) => ({
  pack: one(packs, { fields: [whiteCards.packId], references: [packs.id] }),
}))

export const gameSessionsRelations = relations(gameSessions, ({ one, many }) => ({
  hostPlayer: one(gamePlayers, {
    fields: [gameSessions.hostPlayerId],
    references: [gamePlayers.id],
    relationName: 'host',
  }),
  winnerPlayer: one(gamePlayers, {
    fields: [gameSessions.winnerPlayerId],
    references: [gamePlayers.id],
    relationName: 'winner',
  }),
  players: many(gamePlayers),
  rounds: many(gameRounds),
}))

export const gamePlayersRelations = relations(gamePlayers, ({ one }) => ({
  session: one(gameSessions, {
    fields: [gamePlayers.sessionId],
    references: [gameSessions.id],
  }),
}))

export const gameRoundsRelations = relations(gameRounds, ({ one }) => ({
  session: one(gameSessions, { fields: [gameRounds.sessionId], references: [gameSessions.id] }),
  blackCard: one(blackCards, { fields: [gameRounds.blackCardId], references: [blackCards.id] }),
  czar: one(gamePlayers, {
    fields: [gameRounds.czarPlayerId],
    references: [gamePlayers.id],
    relationName: 'czar',
  }),
  winner: one(gamePlayers, {
    fields: [gameRounds.winnerPlayerId],
    references: [gamePlayers.id],
    relationName: 'round_winner',
  }),
}))
