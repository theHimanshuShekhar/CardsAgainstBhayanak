-- Refuse invalid legacy references before installing constraints. Report the
-- owning row and pointer so operators can review the original outcome; never
-- silently null a winner or assign historical results to another membership.
DO $$
DECLARE invalid_refs text;
BEGIN
  SELECT string_agg(source || ' (' || row_id || ' -> ' || target_id || ')', ', ')
  INTO invalid_refs
  FROM (
    SELECT 'game_sessions.host_player_id' AS source, gs.id AS row_id, gs.host_player_id AS target_id
    FROM game_sessions gs WHERE gs.host_player_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM game_players gp WHERE gp.session_id=gs.id AND gp.id=gs.host_player_id)
    UNION ALL
    SELECT 'game_sessions.winner_player_id', gs.id, gs.winner_player_id
    FROM game_sessions gs WHERE gs.winner_player_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM game_players gp WHERE gp.session_id=gs.id AND gp.id=gs.winner_player_id)
    UNION ALL
    SELECT 'game_sessions.current_match_id', gs.id, gs.current_match_id
    FROM game_sessions gs WHERE gs.current_match_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM game_matches gm WHERE gm.session_id=gs.id AND gm.id=gs.current_match_id)
    UNION ALL
    SELECT 'game_matches.winner_player_id', gm.id, gm.winner_player_id
    FROM game_matches gm WHERE gm.winner_player_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM game_players gp WHERE gp.session_id=gm.session_id AND gp.id=gm.winner_player_id)
    UNION ALL
    SELECT 'game_rounds.winner_player_id', gr.id, gr.winner_player_id
    FROM game_rounds gr WHERE gr.winner_player_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM game_players gp WHERE gp.session_id=gr.session_id AND gp.id=gr.winner_player_id)
    UNION ALL
    SELECT 'game_rounds.match_id', gr.id, gr.match_id
    FROM game_rounds gr WHERE NOT EXISTS (
      SELECT 1 FROM game_matches gm WHERE gm.session_id=gr.session_id AND gm.id=gr.match_id)
    ORDER BY source, row_id LIMIT 10
  ) invalid;
  IF invalid_refs IS NOT NULL THEN
    RAISE EXCEPTION 'Membership integrity preflight failed: %. Repair these references after reviewing room/match history, then retry db:migrate; no history was rewritten.', invalid_refs
      USING ERRCODE = '23503';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "game_matches" ADD CONSTRAINT "game_matches_session_id_id_unique" UNIQUE("session_id","id");--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_session_id_id_unique" UNIQUE("session_id","id");--> statement-breakpoint
ALTER TABLE "game_rounds" DROP CONSTRAINT "game_rounds_match_id_game_matches_id_fk";
--> statement-breakpoint
ALTER TABLE "game_rounds" DROP CONSTRAINT "game_rounds_winner_player_id_game_players_id_fk";
--> statement-breakpoint
ALTER TABLE "game_matches" ADD CONSTRAINT "game_matches_winner_membership_fk" FOREIGN KEY ("session_id","winner_player_id") REFERENCES "public"."game_players"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_match_room_fk" FOREIGN KEY ("session_id","match_id") REFERENCES "public"."game_matches"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_winner_membership_fk" FOREIGN KEY ("session_id","winner_player_id") REFERENCES "public"."game_players"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_host_membership_fk" FOREIGN KEY ("id","host_player_id") REFERENCES "public"."game_players"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_winner_membership_fk" FOREIGN KEY ("id","winner_player_id") REFERENCES "public"."game_players"("session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_current_match_room_fk" FOREIGN KEY ("id","current_match_id") REFERENCES "public"."game_matches"("session_id","id") ON DELETE no action ON UPDATE no action;
