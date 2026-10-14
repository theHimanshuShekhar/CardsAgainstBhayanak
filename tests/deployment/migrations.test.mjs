import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import postgres from 'postgres'

// Opt-in deployment drills; use only this dedicated disposable database.
const url = process.env.CAB_MIGRATION_TEST_URL
const testDrill = url ? test : test.skip
const container = process.env.CAB_MIGRATION_TEST_CONTAINER ?? 'cab-audit-test-postgres-20261003'
function cli(command, cwd = process.cwd()) {
  return spawnSync(
    'node',
    ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'scripts/migrate.ts'), command],
    {
      cwd,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    },
  )
}
function succeeds(command, cwd) {
  const result = cli(command, cwd)
  assert.equal(result.status, 0, result.stderr)
}

testDrill(
  'reviewed deployment supports clean install, adoption, drift refusal and failure rollback/restore',
  async () => {
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    const temporary = mkdtempSync(join(tmpdir(), 'cab-issue52-'))
    try {
      assert.match(new URL(url).pathname, /^\/cab_audit_issue(?:45|52)(?:_|$)/)
      const reviewedManifest = JSON.parse(readFileSync('drizzle/manifest.json', 'utf8'))
      const reviewedCount = reviewedManifest.length
      await sql.unsafe(
        'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS cab_migrations CASCADE',
      )
      assert.match(cli('check').stderr, /Unversioned database/)
      succeeds('apply')
      succeeds('check')
      succeeds('apply') // idempotent deployment
      // Recreate an actual baseline-only database, preserving a historical
      // membership through adoption and every reviewed incremental migration.
      await sql.unsafe(
        'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA cab_migrations CASCADE',
      )
      await sql.unsafe(readFileSync(`drizzle/${reviewedManifest[0].file}`, 'utf8'))
      await sql`INSERT INTO packs (id,name,slug) VALUES ('retained-pack','Retained pack','retained-pack')`
      await sql`INSERT INTO game_sessions (id,code,config) VALUES ('retained-session','RETAIN','{}')`
      await sql`INSERT INTO game_players (id,session_id,username,status,score) VALUES ('retained-player','retained-session','Retained','dropped',3)`
      await sql`INSERT INTO black_cards (id,pack_id,text,pick) VALUES ('retained-prompt','retained-pack','Prompt',1)`
      await sql`INSERT INTO game_rounds (id,session_id,round_num,black_card_id,winner_player_id) VALUES ('retained-round','retained-session',1,'retained-prompt','retained-player')`
      assert.match(cli('apply').stderr, /Existing unversioned database/)
      await sql.unsafe('ALTER TABLE packs ADD COLUMN unexpected text')
      assert.match(cli('adopt').stderr, /differs from baseline/)
      await sql.unsafe('ALTER TABLE packs DROP COLUMN unexpected')
      succeeds('adopt')
      succeeds('apply')
      succeeds('check')
      assert.deepEqual(
        (await sql`SELECT id,score,status FROM game_players WHERE id='retained-player'`)[0],
        { id: 'retained-player', score: 3, status: 'dropped' },
      )
      await sql`INSERT INTO game_players (id,session_id,username) VALUES ('replacement-player','retained-session','Retained')`
      assert.equal(
        (await sql`SELECT winner_player_id FROM game_rounds WHERE id='retained-round'`)[0]
          .winner_player_id,
        'retained-player',
      )
      assert.equal(
        (await sql`SELECT name FROM packs WHERE id='retained-pack'`)[0].name,
        'Retained pack',
      )
      await sql.unsafe('ALTER TABLE packs ADD COLUMN unexpected text')
      assert.match(cli('check').stderr, /schema drift/)
      await sql.unsafe('ALTER TABLE packs DROP COLUMN unexpected')
      succeeds('check')
      cpSync('drizzle', join(temporary, 'drizzle'), { recursive: true })
      const manifest = JSON.parse(readFileSync('drizzle/manifest.json', 'utf8'))
      const upgradeSql =
        "ALTER TABLE packs ADD COLUMN migration_note text DEFAULT 'reviewed'; UPDATE packs SET card_count=7 WHERE id='retained-pack';"
      await sql.unsafe("ALTER TABLE packs ADD COLUMN migration_note text DEFAULT 'reviewed'")
      const signature = spawnSync(
        'node',
        ['--import', import.meta.resolve('tsx'), 'scripts/schema-signature.ts'],
        {
          env: { ...process.env, DATABASE_URL: url },
          encoding: 'utf8',
        },
      )
      assert.equal(signature.status, 0, signature.stderr)
      await sql.unsafe('ALTER TABLE packs DROP COLUMN migration_note')
      writeFileSync(join(temporary, 'drizzle/9998_upgrade.sql'), upgradeSql)
      manifest.push({
        file: '9998_upgrade.sql',
        sha256: createHash('sha256').update(upgradeSql).digest('hex'),
        schema: signature.stdout.trim(),
      })
      writeFileSync(join(temporary, 'drizzle/manifest.json'), JSON.stringify(manifest))
      assert.match(cli('check', temporary).stderr, /Pending migrations/)
      succeeds('apply', temporary)
      succeeds('check', temporary)
      assert.match(cli('check').stderr, /Incompatible migration history/)
      assert.equal(
        (await sql`SELECT card_count FROM packs WHERE id='retained-pack'`)[0].card_count,
        7,
      )
      assert.equal(
        (await sql`SELECT migration_note FROM packs WHERE id='retained-pack'`)[0].migration_note,
        'reviewed',
      )
      // Real logical backup, then a reviewed migration whose second statement fails.
      const backup = spawnSync(
        'docker',
        ['exec', container, 'pg_dump', '-U', 'cab_test', '-d', new URL(url).pathname.slice(1)],
        { encoding: 'utf8' },
      )
      assert.equal(backup.status, 0, backup.stderr)
      const badSql =
        'UPDATE packs SET card_count=99; ALTER TABLE missing_table ADD COLUMN impossible text;'
      writeFileSync(join(temporary, 'drizzle/9999_failed.sql'), badSql)
      manifest.push({
        file: '9999_failed.sql',
        sha256: createHash('sha256').update(badSql).digest('hex'),
        schema: 'unused',
      })
      writeFileSync(join(temporary, 'drizzle/manifest.json'), JSON.stringify(manifest))
      assert.match(cli('apply', temporary).stderr, /missing_table/)
      writeFileSync(
        join(temporary, 'drizzle/manifest.json'),
        JSON.stringify(manifest.slice(0, reviewedCount + 1)),
      )
      succeeds('check', temporary)
      assert.equal(
        (await sql`SELECT name FROM packs WHERE id='retained-pack'`)[0].name,
        'Retained pack',
      )
      assert.equal(
        (await sql`SELECT card_count FROM packs WHERE id='retained-pack'`)[0].card_count,
        7,
      )
      await sql.unsafe(
        'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA cab_migrations CASCADE',
      )
      const restored = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'cab_test',
          '-d',
          new URL(url).pathname.slice(1),
        ],
        { input: backup.stdout, encoding: 'utf8' },
      )
      assert.equal(restored.status, 0, restored.stderr)
      writeFileSync(
        join(temporary, 'drizzle/manifest.json'),
        JSON.stringify(manifest.slice(0, reviewedCount + 1)),
      )
      succeeds('check', temporary)
      assert.equal(
        (await sql`SELECT name FROM packs WHERE id='retained-pack'`)[0].name,
        'Retained pack',
      )
    } finally {
      await sql.end()
      rmSync(temporary, { recursive: true, force: true })
    }
  },
)
