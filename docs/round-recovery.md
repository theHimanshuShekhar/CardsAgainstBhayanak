# Round completion recovery

A round's terminal command atomically records its result and a completion intent
before awarding points or removing submitted cards. The intent lives on the room
hash, so initializing the successor round cannot erase unfinished work.

The continuation uses these checkpoints:

- Score deltas and `completionScores` commit in one Redis script.
- PostgreSQL outcome updates target the original round number and can repeat.
- Public result publication and `completionPublished` commit together, after SQL.
- Submitted-card discards, refills, queued-player activation, gamble cleanup and
  the pause deadline commit with `completionCards` in one Redis script.
- Private hand updates and public `round_end` publish atomically with a marker.
- Successor startup reserves its black card before SQL, accepts its previously
  inserted round row, and checkpoints initialization and announcement. Rando's
  draw and Packing Heat's extra cards are idempotent during startup replay.
- Game completion records its target before changing session status. Recovery
  includes ended SQL sessions whose public completion is still pending.

The pause cursor is read without being consumed. The intent is acknowledged only
after successor startup or durable game completion succeeds. Runtime failures
retry after one second; boot recovery uses the same continuation. Concurrent
callers in one server process share a promise. Redis checkpoints additionally
prevent repeated scores, card transfers and result publications. Redis must retain
its room state across a process restart, as required by the deployment's durable
Redis configuration. Pub/sub delivery itself remains transient: reconnecting
clients restore the authoritative state through their ordinary snapshot.

A closed final ballot or final elimination can be recovered even if the process
dies before recording the shared intent. Reset blocks retry entry, drains the current continuation, and clears the previous
match's continuation metadata before rebuilding the room. The continuation checks
its intent again after the result pause, so delayed work cannot advance a rematch.

Run the fault regressions against dedicated migrated and seeded databases:

```sh
DATABASE_URL=... REDIS_URL=... CAB_ROUND_RESULT_PAUSE_MS=5 \
  pnpm test:integration tests/integration/round-completion.test.ts
```

The suite injects actual PostgreSQL trigger failures and lost Redis acknowledgments
at checkpoint boundaries. Assertions use the engine's public event stream and
subsequent accepted play: one result, one round end, one successor/game-over,
retained cards in order, unique ten-card refills and exactly one queued activation.
