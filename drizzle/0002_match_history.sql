-- A room and its memberships survive replays; each playthrough owns rounds
-- and a frozen outcome. Legacy rooms are backfilled as their first match.
CREATE TABLE game_matches (
  id text PRIMARY KEY,
  session_id text NOT NULL CONSTRAINT game_matches_session_id_game_sessions_id_fk REFERENCES game_sessions(id) ON DELETE CASCADE,
  status session_status NOT NULL DEFAULT 'active',
  config jsonb NOT NULL,
  winner_player_id text,
  end_mode end_mode,
  final_players jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
ALTER TABLE game_sessions ADD COLUMN current_match_id text;
ALTER TABLE game_rounds ADD COLUMN match_id text;
-- Backfill snapshots from durable membership data. Scores lost by an earlier
-- destructive reset or held only in Redis cannot be reconstructed from SQL;
-- this preserves the durable membership values that still exist.
INSERT INTO game_matches (id, session_id, status, config, winner_player_id, end_mode, final_players, started_at, ended_at)
SELECT gs.id, gs.id, gs.status, gs.config, gs.winner_player_id, gs.end_mode,
  CASE WHEN gs.status IN ('ended', 'abandoned') THEN coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', gp.id, 'username', gp.username,
      'role', gp.role, 'score', gp.score, 'status', gp.status,
      'isHost', gp.is_host, 'isRando', gp.is_rando, 'discardsUsed', gp.discards_used,
      'joinedAt', gp.joined_at) ORDER BY gp.joined_at, gp.id)
    FROM game_players gp WHERE gp.session_id = gs.id
  ), '[]'::jsonb) ELSE NULL END,
  gs.created_at, gs.ended_at
FROM game_sessions gs
WHERE gs.status <> 'lobby' OR EXISTS (SELECT 1 FROM game_rounds gr WHERE gr.session_id = gs.id);
UPDATE game_sessions gs SET current_match_id = gm.id FROM game_matches gm WHERE gm.session_id = gs.id;
UPDATE game_rounds SET match_id = session_id;
ALTER TABLE game_rounds ALTER COLUMN match_id SET NOT NULL;
ALTER TABLE game_rounds ADD CONSTRAINT game_rounds_match_id_game_matches_id_fk FOREIGN KEY (match_id) REFERENCES game_matches(id);
ALTER TABLE game_rounds DROP CONSTRAINT game_rounds_session_id_round_num_unique;
ALTER TABLE game_rounds ADD CONSTRAINT game_rounds_match_id_round_num_unique UNIQUE (match_id, round_num);
DROP INDEX unique_rando_per_session;
CREATE UNIQUE INDEX unique_rando_per_session ON game_players USING btree (session_id) WHERE is_rando = true AND status <> 'dropped';
