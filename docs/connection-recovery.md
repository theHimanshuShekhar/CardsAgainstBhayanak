# Connection recovery

Authenticated sockets persist their UUID and absolute heartbeat expiry in a room/player Redis hash. Auth and accepted messages renew only that socket. A lease lasts the existing 45-second half-open timeout; clean close removes its socket lease and starts the existing 30-second grace only when no valid socket remains. Participation (`active`, `queued`, `spectator`) does not change during grace.

Boot and a nonoverlapping one-second sweep reconcile persisted leases and grace generations. A valid lease is respected even if the current runtime has no local peer for it. When all leases have expired, grace ends 30 seconds after the final heartbeat expiry, independent of restart time. The expiring grace key and durable connection generation allow recovery both before and after grace expires. Reauthentication also reconciles that identity before restoring connectivity, so an already expired identity cannot escape a delayed background sweep.

The existing generation-checked player drop performs roster publication, SQL departure, host succession and active-game consequences. Reconnect atomically replaces grace with its new socket lease; a callback or recovery pass holding an older generation cannot drop it. Dropped identities cannot acquire leases. Redis room TTL remains the authority for room lifetime.

This is recovery for the existing runtime model, not a distributed execution or deployment ownership protocol. Multiple valid socket leases are preserved; distributed round execution remains outside this change.

## Verification

With dedicated migrated/seeded issue37 backing stores, run:

```sh
pnpm test:integration tests/integration/restored-disconnects.test.ts
pnpm build
node --test tests/deployment/disconnect-restart.test.mjs
```

The deployment regression owns and SIGKILLs its child server on port3137. It uses real heartbeat/grace durations and HTTP/WebSocket observations to verify reconnect before expiry, no early drop at restart, one terminal roster event, host succession, queued-player exclusion from the round quorum, and startup after an abrupt-death deadline has already elapsed. It never signals pre-existing servers or restarts backing services.
