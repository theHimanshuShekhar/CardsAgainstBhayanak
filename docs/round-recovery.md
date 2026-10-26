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
- Private hand updates, public `round_end`, and removal of the old submission,
  reveal and voting cursors commit atomically with `completionEndPublished`.
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
The end-publication failure regression resolves the successor round fully; a real
WebSocket rejoin preserves the live Survival elimination flags. A local HTTP
telemetry collector verifies event names, actor identity and required properties.

## Boot recovery and readiness

Boot retries incomplete room recovery after 1, 2, 4, 8, 16 and then at most 30
seconds between attempts, until every room has been processed successfully.
One room's failure does not skip later rooms. Recovery awaits overdue timers,
completion continuations and reveal handoffs before counting a room complete.
Future round deadlines share one process timer with ordinary gameplay, including
across the production source WebSocket and bundled HTTP engines. Failed timer
callbacks retry with the same capped backoff. Round IDs and persisted deadlines
continue to fence callbacks from reset matches. Completion continuations share
their existing promise and retry timer across both engine copies as well.

`GET /api/healthz` keeps `db` and `redis` as backing-store checks and reports a
separate `recovery` object:

```json
{
  "ready": false,
  "stage": "rooms",
  "attempts": 3,
  "rooms": { "total": 4, "recovered": 3, "pending": 1 },
  "connectionsReady": true,
  "nextRetryAt": 1800000004000
}
```

`stage` progresses from `schema` to `rooms` to `ready`. Attempt counts restart at
the room stage; room counts describe the current/most recent round recovery pass
over active and ended SQL rooms. `rooms` is null until that query succeeds.
`connectionsReady` tracks the boot disconnect reconciliation separately, including
lobby memberships. `nextRetryAt` is an absolute Unix timestamp in milliseconds,
or null while running or finished. HTTP remains 503 until both stores are healthy
and boot recovery is ready, so reachable stores alone cannot hide stalled rooms.
Health probes return within one second and share outstanding driver work.

Production validates the reviewed schema before importing engines or starting
jobs. Transient PostgreSQL outages keep the process alive behind a temporary
health-only listener with the same retry backoff; ordinary requests receive 503.
Successful validation replaces that listener with the normal HTTP/WS server in
the same process. Credentials/configuration errors, unversioned or incompatible
history, drift, pending migrations and migration checksum failures still refuse
startup. Schema checks never apply migrations automatically.

The deployment regression owns its application process on port3139 and two TCP
proxies, while shared backing services remain running. It requires the dedicated
migrated `cab_audit_issue39` database and Redis DB8, and seeds its own deterministic
catalog. It tests both unavailable stores at startup, a middle room's failed SQL
outcome, recovery progress while both stores are healthy, future and overdue
timers, reveal handoff, one outcome/round end/successor per room, and subsequent
accepted WebSocket play in every recovered room. It also checks schema refusals:

```sh
pnpm build
DATABASE_URL=... REDIS_URL=... SESSION_SECRET=... \
  node --test tests/deployment/boot-recovery.test.mjs
```
