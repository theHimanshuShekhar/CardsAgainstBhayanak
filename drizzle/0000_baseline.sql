CREATE TYPE "public"."end_mode" AS ENUM('normal', 'happy_ending', 'rando_won', 'deck_exhausted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."player_role" AS ENUM('player', 'spectator');--> statement-breakpoint
CREATE TYPE "public"."player_status" AS ENUM('active', 'queued', 'spectator', 'grace', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('lobby', 'active', 'paused', 'ended', 'abandoned');--> statement-breakpoint
CREATE TABLE "black_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"text" text NOT NULL,
	"pick" integer NOT NULL,
	CONSTRAINT "black_cards_pack_id_text_pick_unique" UNIQUE("pack_id","text","pick")
);
--> statement-breakpoint
CREATE TABLE "game_players" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"username" text NOT NULL,
	"role" "player_role" DEFAULT 'player' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"status" "player_status" DEFAULT 'active' NOT NULL,
	"is_host" boolean DEFAULT false NOT NULL,
	"is_rando" boolean DEFAULT false NOT NULL,
	"discards_used" integer DEFAULT 0 NOT NULL,
	"posthog_anon_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_players_session_id_username_unique" UNIQUE("session_id","username")
);
--> statement-breakpoint
CREATE TABLE "game_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"round_num" integer NOT NULL,
	"black_card_id" text NOT NULL,
	"czar_player_id" text,
	"winner_player_id" text,
	"winning_submission_fills" jsonb,
	"ranking" jsonb,
	"vote_tally" jsonb,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_rounds_session_id_round_num_unique" UNIQUE("session_id","round_num")
);
--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" char(6) NOT NULL,
	"status" "session_status" DEFAULT 'lobby' NOT NULL,
	"config" jsonb NOT NULL,
	"host_player_id" text,
	"winner_player_id" text,
	"end_mode" "end_mode",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "game_sessions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"card_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "white_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "white_cards_pack_id_text_unique" UNIQUE("pack_id","text")
);
--> statement-breakpoint
ALTER TABLE "black_cards" ADD CONSTRAINT "black_cards_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_black_card_id_black_cards_id_fk" FOREIGN KEY ("black_card_id") REFERENCES "public"."black_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_czar_player_id_game_players_id_fk" FOREIGN KEY ("czar_player_id") REFERENCES "public"."game_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_winner_player_id_game_players_id_fk" FOREIGN KEY ("winner_player_id") REFERENCES "public"."game_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "white_cards" ADD CONSTRAINT "white_cards_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_rando_per_session" ON "game_players" USING btree ("session_id") WHERE "game_players"."is_rando" = true;--> statement-breakpoint
CREATE INDEX "gin_winning_fills" ON "game_rounds" USING btree ("winning_submission_fills");--> statement-breakpoint
CREATE INDEX "idx_sessions_last_activity" ON "game_sessions" USING btree ("last_activity_at") WHERE "game_sessions"."status" IN ('active', 'paused');