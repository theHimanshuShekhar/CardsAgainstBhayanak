# Runtime ownership

Run exactly **one production app process** for a deployment. Give it a private
PostgreSQL database and a dedicated Redis/Valkey logical database. Do not point
different deployments at the same Redis database, even if their PostgreSQL
databases differ. Redis pub/sub channels are server-wide, so isolated deployments
on the same Redis server must also avoid reusing room codes; separate Redis
servers provide full isolation. Development servers and direct engine scripts
must use separate disposable storage.

The production entry checks the reviewed schema, then acquires a PostgreSQL
session advisory lock before importing the HTTP/WebSocket engines. A second app
using the same PostgreSQL database exits with status 1 and a `Runtime ownership
refused` message. It starts no room recovery, round timers, disconnect
reconciliation, keepalive enforcement, sweeper or background card seeding, and
does not listen for gameplay traffic. The lock is independent of the migration
CLI's transaction lock. It does not make applying migrations with writers running
safe; follow the existing stopped-writer migration procedure.

The ownership connection is dedicated, has no client-side idle/lifetime expiry,
and never silently reconnects after ownership is established. Connect directly
to PostgreSQL, or through a session-preserving proxy. Transaction/statement
pooling and independent writable PostgreSQL primaries are unsupported.

## Restart and ownership loss

Normal process exit, container removal and crashes close the PostgreSQL session
and release its lock automatically. There is no persistent owner row, unlock
command or expiring runtime lease to clean up. Start the replacement after the
old process has exited and PostgreSQL has released its connection. Stop the old
app before an upgrade; overlapping rolling replicas are unsupported. A refused
second replica may keep restarting under Compose's restart policy until the
configuration is corrected.

If PostgreSQL reports that the ownership session closed, the app immediately
exits with status 1 and `Runtime ownership lost`. It also probes that same
session once per second, with a five-second response deadline: a silent network
failure stops the process within approximately six seconds while the event loop
is progressing. This is a fail-stop policy, including a temporary database
network outage after startup. The app does not drain sockets, pause timers or
resume in place after losing ownership. Its supervisor must restart it; the new
process checks schema, reacquires ownership and restores durable room deadlines
and completion checkpoints. Clients reconnect through the ordinary session flow.
An initial transient schema-storage outage still uses the health-only retry
listener before ownership acquisition.

This guard prevents accidental competing processes in the supported topology.
It is not a distributed fencing protocol: an event-loop stall, storage failover
or administrative termination of the ownership session can delay detection, and
already-issued storage commands can finish. Do not promote a replacement while
the previous app may still be running. PostgreSQL and Redis durability and the
documented room-recovery limitations still apply.

## Deployment regression

The test owns only its app subprocesses and forwarding sockets. Shared backing
services stay running. Supply migrated disposable `cab_audit_issue54` and Redis
DB9; the test resets their room data and seeds its own card catalog:

```sh
pnpm build
DATABASE_URL=... REDIS_URL=... SESSION_SECRET=... \
  node --test tests/deployment/runtime-ownership.test.mjs
```

Assertions use the real production CLI and HTTP/WebSocket behavior: competing
startup refusal, exactly one round timeout and disconnect drop, crash restart,
and fail-stop/restart after the ownership session is lost.

## Future scaling path

Multiple runtimes would need a separate design with exclusive, renewable
per-room leases and monotonically increasing fencing tokens. Every room mutation,
timer continuation, disconnect effect and publication would have to validate
the current token, including work already in flight when a lease expires. A
runtime losing its lease would stop accepting commands and scheduling effects
for that room; a new owner would restore durable deadlines and completion
checkpoints. Socket routing, cross-runtime connection presence, global jobs,
lease renewal during partitions and failover would need explicit policies and
failure tests. Sticky sockets or the current Redis checkpoints alone do not
provide ownership. This ticket introduces no per-room leasing or multi-runtime
support.
