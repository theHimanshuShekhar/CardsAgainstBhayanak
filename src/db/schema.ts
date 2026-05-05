import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  json,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passphraseHash: text("passphrase_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const packs = pgTable("packs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  official: boolean("official").notNull().default(true),
});

export const blackCards = pgTable("black_cards", {
  id: serial("id").primaryKey(),
  packId: integer("pack_id")
    .notNull()
    .references(() => packs.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  pick: integer("pick").notNull().default(1),
});

export const whiteCards = pgTable("white_cards", {
  id: serial("id").primaryKey(),
  packId: integer("pack_id")
    .notNull()
    .references(() => packs.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
});

export const gameSessions = pgTable("game_sessions", {
  id: serial("id").primaryKey(),
  roomCode: text("room_code").notNull().unique(),
  config: json("config").notNull(),
  status: text("status").notNull().default("waiting"),
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const gamePlayers = pgTable("game_players", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => gameSessions.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id),
  displayName: text("display_name").notNull(),
  isSpectator: boolean("is_spectator").notNull().default(false),
  isHost: boolean("is_host").notNull().default(false),
  joinedRound: integer("joined_round"),
  finalScore: integer("final_score"),
});

export const gameRounds = pgTable("game_rounds", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => gameSessions.id, { onDelete: "cascade" }),
  roundNum: integer("round_num").notNull(),
  blackCardId: integer("black_card_id")
    .notNull()
    .references(() => blackCards.id),
  winnerPlayerId: integer("winner_player_id").references(() => gamePlayers.id),
  completedAt: timestamp("completed_at"),
});
