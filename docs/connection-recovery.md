# Connection recovery

Authenticated sockets persist their UUID and absolute heartbeat expiry in a room/player Redis hash. Auth and accepted messages renew only that socket. A lease lasts the existing 45-second half-open timeout; clean close removes its socket lease and starts the existing 30-second grace only when no valid socket remains. Participation (`active`, `queued`, `spectator`) does not change during grace.

Boot and a nonoverlapping one-second sweep reconcile persisted leases and grace generations. A valid lease is respected even if the current runtime has no local peer for it. When all leases have expired, grace ends 30 seconds after the final heartbeat expiry, independent of restart time. The expiring grace key and durable connection generation allow recovery both before and after grace expires. Reauthentication also reconciles that identity before restoring connectivity, so an already expired identity cannot escape a delayed background sweep.

The generation-checked player drop atomically publishes the terminal roster event and stores pending consequences with the original round identity. Boot reconciliation replays SQL departure, host succession and active-game consequences until they finish; already dropped identities remain eligible for this pending work. Preparing a void atomically returns cards once, clears round state and records its successor continuation, so recovery can resume from transition or a partially initialized successor. The original round identity fences delayed consequences from later rounds. Reconnect atomically replaces grace with its new socket lease; a callback or recovery pass holding an older generation cannot drop it. Dropped identities cannot acquire leases. Redis room TTL remains the authority for room lifetime.

This is recovery for the existing runtime model, not a distributed execution or deployment ownership protocol. Multiple valid socket leases are preserved; distributed round execution remains outside this change.

## Verification

With dedicated migrated/seeded issue37 backing stores, run:

```sh
pnpm test:integration tests/integration/restored-disconnects.test.ts
pnpm build
node --test tests/deployment/disconnect-restart.test.mjs
```

The deployment regression owns and SIGKILLs its child server on port3137. It uses real heartbeat/grace durations and HTTP/WebSocket observations to verify reconnect before expiry, no early drop at restart, one terminal roster event, host succession, queued-player exclusion from the round quorum, and startup after an abrupt-death deadline has already elapsed. It never signals pre-existing servers or restarts backing services.

The focused integration regression injects a real PostgreSQL departure-write failure, a successor-round INSERT failure after atomic void preparation, and a Redis transport error at final acknowledgement. It verifies one departure, one void, unique returned cards, one successor announcement, and successful play/judgment into the following round without repairing room state.
