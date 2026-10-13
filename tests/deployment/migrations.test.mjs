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
      assert.match(new URL(url).pathname, /^\/cab_audit_issue52/)
      await sql.unsafe(
        'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS cab_migrations CASCADE',
      )
      assert.match(cli('check').stderr, /Unversioned database/)
      succeeds('apply')
      succeeds('check')
      succeeds('apply') // idempotent deployment
      await sql`INSERT INTO packs (id,name,slug) VALUES ('retained-pack','Retained pack','retained-pack')`
      // Existing pre-migration database: remove only journal, preserving data.
      await sql.unsafe('DROP SCHEMA cab_migrations CASCADE')
      assert.match(cli('apply').stderr, /Existing unversioned database/)
      succeeds('adopt')
      succeeds('check')
      assert.equal(
        (await sql`SELECT name FROM packs WHERE id='retained-pack'`)[0].name,
        'Retained pack',
      )
      await sql.unsafe('ALTER TABLE packs ADD COLUMN unexpected text')
      assert.match(cli('check').stderr, /schema drift/)
      await sql.unsafe('DROP SCHEMA cab_migrations CASCADE')
      assert.match(cli('adopt').stderr, /differs from baseline/)
      await sql.unsafe('ALTER TABLE packs DROP COLUMN unexpected')
      succeeds('adopt')
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
      writeFileSync(join(temporary, 'drizzle/0001_upgrade.sql'), upgradeSql)
      manifest.push({
        file: '0001_upgrade.sql',
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
      const badSql = 'DELETE FROM packs; ALTER TABLE missing_table ADD COLUMN impossible text;'
      writeFileSync(join(temporary, 'drizzle/0002_failed.sql'), badSql)
      manifest.push({
        file: '0002_failed.sql',
        sha256: createHash('sha256').update(badSql).digest('hex'),
        schema: 'unused',
      })
      writeFileSync(join(temporary, 'drizzle/manifest.json'), JSON.stringify(manifest))
      assert.match(cli('apply', temporary).stderr, /missing_table/)
      writeFileSync(join(temporary, 'drizzle/manifest.json'), JSON.stringify(manifest.slice(0, 2)))
      succeeds('check', temporary)
      assert.equal(
        (await sql`SELECT name FROM packs WHERE id='retained-pack'`)[0].name,
        'Retained pack',
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
      writeFileSync(join(temporary, 'drizzle/manifest.json'), JSON.stringify(manifest.slice(0, 2)))
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
