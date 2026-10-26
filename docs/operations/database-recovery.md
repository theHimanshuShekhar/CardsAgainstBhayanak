# PostgreSQL storage and recovery

## Requirements and deployed assessment (2026-10-16)

PostgreSQL requires a single writer to its data directory, reliable file locking,
atomic rename, durable fsync of WAL/data/directory changes, and a filesystem and
controller that honor flushes through power loss. Keep `fsync`, `full_page_writes`
and `synchronous_commit` enabled. Never attach one PGDATA volume to two servers.
Use PostgreSQL 16 on a Docker local volume backed by host-local ext4/XFS on
persistent block storage; RAID/controller write caches must have protected power
or honor flushes. Docker's `local` driver alone does not prove these properties:
its data root can itself reside on a network filesystem or ephemeral disk.

The authorized read-only assessment of the Dockhand host on 2026-10-16 confirms
that the deployed PostgreSQL storage matches the checked-in CIFS configuration.
This is SMB/CIFS, not NFS. The local Docker driver does not make this a local
block-storage deployment.

| Observed item                  | Result                                                                      |
| ------------------------------ | --------------------------------------------------------------------------- |
| PostgreSQL                     | 16.15; container `cab_postgres`                                             |
| Data volume                    | `cardsagainstbhayanak_postgres_data`, mounted at `/var/lib/postgresql/data` |
| Backing filesystem             | CIFS share on NAS `10.1.1.195`                                              |
| Relevant mount flags           | `uid=70`, `gid=70`, `file_mode=0700`, `dir_mode=0700`                       |
| PostgreSQL durability settings | `fsync=on`, `full_page_writes=on`, `synchronous_commit=on`                  |
| Valkey storage                 | `cardsagainstbhayanak_redis_data`, ext4 backing filesystem                  |
| Host free space                | Approximately 73 GB at assessment time; not evidence of NAS free space      |

The deployed CIFS volume remains **unverified for PostgreSQL durability and
locking** and is outside the supported local-block configuration below. The
settings and permission flags do not establish reliable NAS locking, atomic
rename, flush ordering, protected controller caches or power-loss durability.
No crash or second-writer experiment was performed on production storage. NAS
and controller guarantees, persistence through host/NAS failure, and independent
monitored database backup scheduling/retention still require verification. The
observed system timer list showed a package-manager database backup timer; this
does not establish a backup job for the game database. A one-off verified dump
also does not establish a recurring backup service.

The supported alternative and reversible cutover remain available if those
guarantees cannot be established. This assessment does not authorize a storage
migration, and no production data volume was changed for this work.

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

Run `PUBLIC_SITE_URL=https://cards.bhayanak.net pnpm test:storage` with Docker
available (`PUBLIC_SITE_URL` is required when rendering the production Compose
configuration). It always executes or fails; no
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
The live assessment and production-data restore evidence below supersede the
original repository-only assessment. They do not establish production recovery
time or power-loss durability.

## Production-data backup and restoration evidence (2026-10-16)

The authorized repair and release rehearsals produced two protected logical
backups. Their UTC identifiers fall on October 15; the assessments and rehearsals
were on October 16 in Asia/Kolkata. Only credential-free metadata is recorded
here; dumps, secrets and deployment environment files are not committed.

| Snapshot                                     |  Bytes | SHA-256                                                            |
| -------------------------------------------- | -----: | ------------------------------------------------------------------ |
| Initial repair, `20261015T232142Z`           | 680115 | `6d83ea976fdfe1a3fefa67f123c32d9fdff5beabe272eb64302c00b9b7d9bd62` |
| Online release rehearsal, `20261015T233904Z` | 680946 | `0f6dedb2132c5d560096b6fc02c9b5b2a9ae63c232f2bde60341fd4d63f7947f` |

The initial dump was taken with the application stopped and before any schema
change. It was restored to a separate disposable PostgreSQL 16 instance. All six
application-table fingerprints matched the quiesced production database before
baseline adoption; baseline adoption and schema compatibility checks then passed
without changing those application rows.

The fresh online dump was a read-consistent PostgreSQL snapshot, not a coordinated
PostgreSQL/Valkey snapshot or a stopped-writer deployment rollback point. Its
copy outside the deployment host had the recorded SHA-256 verified. It was
restored to an owned, isolated PostgreSQL 16 instance and migrations `0001` through
`0003` were applied after the baseline. The rehearsal reported:

| Retained legacy table | Rows |
| --------------------- | ---: |
| `packs`               |   72 |
| `black_cards`         | 1038 |
| `white_cards`         | 4655 |
| `game_sessions`       |   13 |
| `game_players`        |   46 |
| `game_rounds`         | 1002 |

All six legacy-data fingerprints remained unchanged. The migrated database had
10 matches, all 1002 rounds linked to matches (zero unlinked rounds), four
migration-history entries including the baseline, and zero unvalidated
constraints. These results verify restoration and the rehearsed schema upgrade;
they do not assert that the pending release migrations were applied to production.

The disposable local-volume storage drill also passed on final main
`1d5c7474d93bc1b1fb386e441174314cf6aa8a40` with `PUBLIC_SITE_URL` configured:
2/2 checks passed, zero skips. Total test time was approximately eight seconds;
the fixture crash/restore portion was approximately seven seconds. No shared
service was restarted for that drill. There is no recorded end-to-end timing
for production backup transfer, provisioning, restore, validation and cutover,
so no production RTO is claimed. The one-off backup age can be calculated from
the snapshot timestamp; without a verified recurring schedule there is no
bounded ongoing RPO.

The assessment and evidence were reviewed from the session records
`dockhand-storage-20261016.txt`, `dockhand-repair-record.json`,
`dockhand-release-snapshot.json`, `release-rehearsal.json` and `final-storage.log`.
These session records and protected dumps are not committed; this document
retains the redacted findings and reproducibility instructions.

## Issue #53 acceptance verdict

All three issue criteria are met within their stated scope:

1. Durability/locking requirements are recorded and the actual deployed storage
   has been assessed without embedding credentials: CIFS is confirmed, while its required
   durability/locking guarantees remain unverified.
2. A tested supported local-block configuration and reversible migration plan
   are provided for use if existing storage cannot meet those requirements.
3. Isolated fixture and production-data backup/restore drills have been
   performed, with integrity checks and recovery expectations recorded above.

The issue asks for an assessment, supported alternative and restoration evidence;
it does not require the deployed volume to be migrated as part of acceptance.
This verdict therefore does **not** certify the current CIFS deployment as
supported or establish an ongoing disaster-recovery service. Obtain NAS/controller
locking and power-loss guarantees or schedule the documented supported-storage
cutover, establish independently stored monitored backups with retention and
restore checks, and measure end-to-end recovery before committing to an RPO/RTO.
