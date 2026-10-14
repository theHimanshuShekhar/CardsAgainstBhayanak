# PostgreSQL storage and recovery

## Requirements and assessment (2026-10-14)

PostgreSQL requires a single writer to its data directory, reliable file locking,
atomic rename, durable fsync of WAL/data/directory changes, and a filesystem and
controller that honor flushes through power loss. Keep `fsync`, `full_page_writes`
and `synchronous_commit` enabled. Never attach one PGDATA volume to two servers.
Use PostgreSQL 16 on a Docker local volume backed by host-local ext4/XFS on
persistent block storage; RAID/controller write caches must have protected power
or honor flushes. Docker's `local` driver alone does not prove these properties:
its data root can itself reside on a network filesystem or ephemeral disk.

The checked-in base Compose uses the local driver **with CIFS options**, mounting
an SMB NAS share for PostgreSQL. This is not NFS and is not the supported local
block configuration. Its uid/gid/mode options do not establish fsync, locking,
server cache or outage semantics. Repository evidence cannot verify the deployed
volume, mount options, NAS/controller guarantees, backup schedule or available
capacity. No live deployment or credentials were accessed for this assessment.
Treat the existing setup as unverified until the operator obtains those facts;
if guarantees cannot be established, migrate using the procedure below.

Record a redacted host assessment: deployed image/commit, PG major version,
volume identity and driver type, backing filesystem/device, persistence across
host replacement, controller flush guarantees, free space/inodes, encryption,
backup retention and last successful restore. Inspect volume options locally,
but do not paste raw `docker volume inspect`, Compose interpolation or environment
output into tickets: legacy driver options contain credentials. Confirm a second
PostgreSQL cannot open the same PGDATA, and verify crash recovery only on a
representative disposable volume. A successful process-crash drill cannot prove
power-loss durability or NAS correctness.

## Supported configuration and reversible migration

The base file retains the existing volume definition so an update cannot silently
boot an empty database. The opt-in override uses a distinct `postgres_local_data`
volume and requires Compose >=2.24.4:

```
docker compose -f docker-compose.yml -f docker-compose.local-storage.yml config --quiet
```

Before enabling it, verify the Docker data root is on persistent local block
storage. Do not use `down -v`, rename the old volume, copy live PGDATA, or run
`db:push`. Keep the old image, Compose selection and original volume intact.

1. Announce downtime and stop all application writers, jobs and ingress. Record
   database version, deployed commit and migration history. Back up secrets via
   the existing secret store, separately from the database.
2. With matching-major PostgreSQL tools, create a `pg_dump --no-owner --no-acl`
   logical dump to a protected file outside the DB host. Capture its checksum,
   UTC completion time, source version and image/manifest revision. Verify exit
   status before accepting the file; use restrictive permissions, encryption and
   retention on independent storage. Never log connection strings.
3. Rehearse restoration to a disposable fresh database: restore using
   `psql -X -v ON_ERROR_STOP=1`, run the matching image's `pnpm db:check`, compare
   counts and representative records from every application table and migration
   history, and verify foreign keys/unique constraints. Keep a known-good older
   backup until the new one passes. A file checksum alone proves no recoverability.
4. Start only PostgreSQL with both Compose files selected. The distinct local
   volume must be empty; restore the verified dump, run `db:check`, compare data
   again, then start the intended application image and validate health/history.
   Do not apply schema upgrades during the storage cutover. Keep ingress stopped
   until acceptance; then resume writers. Persist both Compose file selections
   in the deployment manager so subsequent redeploys use the intended volume.
5. Before writers resume, rollback means stopping the candidate PostgreSQL and
   selecting the original Compose file/image/untouched volume. After any new
   writes, the old volume is stale: stop writers again, take and verify a new
   dump from the candidate, restore into another fresh verified target, check
   schema compatibility, then switch. Preserve both originals for diagnosis;
   never overwrite the only good copy. Returning to unverified CIFS is not a
   durability fix.

## Recovery expectations and drill

Run `pnpm test:storage` with Docker available. It always executes or fails; no
credentials or existing volumes are used. It creates a uniquely named local
volume/container on a random loopback port, applies the existing reviewed
migration CLI, writes linked card/game/player/round records and JSON, kills
PostgreSQL abruptly, and verifies committed rows after restart. It dumps and
restores to a different fresh database, checks migration/schema signatures,
compares all application tables/history, and confirms foreign-key rejection.
Finally it removes only its own container and volume. The existing
`test:migrations` drill covers migration failure rollback and restore; these
checks complement rather than replace it.

A logical backup recovers PostgreSQL history up to its consistent snapshot. It
is not continuous WAL archiving or point-in-time recovery. RPO is the age of the
last **verified** backup at failure; choose and monitor a schedule (for example,
nightly implies up to 24 hours plus missed-backup delay). RTO includes provisioning,
fetching/decrypting the dump, restoring, validating and switching ingress; measure
with production-sized data before promising a bound. Tiny-fixture drill timings
are not a production RTO. Keep backups independently accessible after host loss.

PostgreSQL does not contain hands, timers or in-progress room state: Valkey owns
those. A DB-only restore recovers historical records, not resumable live games.
Do not replay stale Redis state against a restored DB; stop ingress and writers,
preserve its volume for diagnosis, start an explicitly fresh Redis instance and
ask players to create new rooms. Valkey AOF defaults can lose about one second
of writes on crash; RDB is periodic, not an independent off-host backup. A
coordinated DB/Valkey restore requires its own tested snapshot procedure.

## Recorded local evidence (2026-10-14)

On the development Docker host, `pnpm test:storage` passed both checks with no
skips using `postgres:16-alpine` and a newly created local-driver volume.
The successful fixture crash/restore run took approximately six seconds,
including migration checks; this excludes real backup transfer and large-data
restore time. The tested configuration preserved committed pack/card/session/
player/round rows, JSON payloads and migration history across process crash and
logical restoration. Migration `check` verified the restored catalog signature;
invalid foreign-key insertion was rejected and no unvalidated constraints
remained. A second server start against the same PGDATA is also rejected.
This is local process-crash and restoration evidence, not a test of deployed
storage, power-loss behavior, independent backup retention or production RTO.
The operator's redacted live assessment and production-size recovery timing
remain outstanding external verification steps.
