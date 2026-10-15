import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// This command always runs a real drill or fails; it never silently skips.
function run(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...options })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
test('supported local volume renders without CIFS PostgreSQL mount', () => {
  const config = JSON.parse(
    run(
      [
        'compose',
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.local-storage.yml',
        'config',
        '--format',
        'json',
      ],
      {
        env: {
          ...process.env,
          POSTGRES_PASSWORD: 'disposable-only',
          SESSION_SECRET: 'disposable-only-secret-32-characters',
        },
      },
    ),
  )
  assert.equal(config.services.postgres.volumes[0].source, 'postgres_local_data')
  assert.equal(config.volumes.postgres_local_data.driver, 'local')
  assert.equal(config.volumes.postgres_local_data.driver_opts, undefined)
})

test(
  'local PostgreSQL volume survives abrupt exit and logical backup restores schema and history',
  { timeout: 120_000 },
  async () => {
    const id = `cab-issue53-${process.pid}`
    const database = 'cab_audit_issue53_source'
    const restored = 'cab_audit_issue53_restored'
    const start = Date.now()
    let volumeCreated = false
    let containerCreated = false
    function psql(db, statement) {
      return run([
        'exec',
        id,
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'cab_test',
        '-d',
        db,
        '-Atc',
        statement,
      ])
    }
    async function ready() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = spawnSync('docker', [
          'exec',
          id,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'cab_test',
          '-d',
          database,
        ])
        if (result.status === 0) return
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.fail('Disposable PostgreSQL did not become ready')
    }
    try {
      run(['volume', 'create', id])
      volumeCreated = true
      run([
        'run',
        '-d',
        '--name',
        id,
        '-e',
        'POSTGRES_USER=cab_test',
        '-e',
        'POSTGRES_PASSWORD=cab_test_only',
        '-e',
        `POSTGRES_DB=${database}`,
        '-v',
        `${id}:/var/lib/postgresql/data`,
        '-p',
        '127.0.0.1::5432',
        'postgres:16-alpine',
      ])
      containerCreated = true
      await ready()
      let port = run(['port', id, '5432/tcp']).split(':').at(-1)
      function migration(command, db) {
        const result = spawnSync(
          'node',
          ['--import', import.meta.resolve('tsx'), 'scripts/migrate.ts', command],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              DATABASE_URL: `postgres://cab_test:cab_test_only@127.0.0.1:${port}/${db}`,
            },
          },
        )
        assert.equal(result.status, 0, result.stderr)
      }
      migration('apply', database)
      const secondWriter = spawnSync(
        'docker',
        ['exec', '-u', 'postgres', id, 'pg_ctl', '-D', '/var/lib/postgresql/data', '-w', 'start'],
        { encoding: 'utf8' },
      )
      assert.notEqual(secondWriter.status, 0)
      assert.match(
        secondWriter.stderr + secondWriter.stdout,
        /already running|postmaster.pid|lock file/,
      )
      assert.equal(psql(database, 'SHOW fsync'), 'on')
      assert.equal(psql(database, 'SHOW synchronous_commit'), 'on')
      assert.equal(psql(database, 'SHOW full_page_writes'), 'on')
      psql(
        database,
        `INSERT INTO packs(id,name,slug) VALUES ('pack','Recovery pack','recovery');
      INSERT INTO black_cards(id,pack_id,text,pick) VALUES ('black','pack','Recovery ____',1);
      INSERT INTO white_cards(id,pack_id,text) VALUES ('white','pack','Retained answer');
      INSERT INTO game_sessions(id,code,status,config) VALUES ('game','RCVRY1','ended','{"packs":["recovery"]}');
      INSERT INTO game_players(id,session_id,username,score) VALUES ('player','game','Recovered player',3);
      INSERT INTO game_matches(id,session_id,status,config) VALUES ('match','game','ended','{}');
      UPDATE game_sessions SET current_match_id='match' WHERE id='game';
      INSERT INTO game_rounds(id,session_id,match_id,round_num,black_card_id,winner_player_id,winning_submission_fills)
      VALUES ('round','game','match',1,'black','player','[{"id":"white","text":"Retained answer"}]');`,
      )
      const snapshot = (db) =>
        psql(
          db,
          `SELECT jsonb_build_object('packs',(SELECT jsonb_agg(p) FROM packs p),'black',(SELECT jsonb_agg(p) FROM black_cards p),'white',(SELECT jsonb_agg(p) FROM white_cards p),'games',(SELECT jsonb_agg(p) FROM game_sessions p),'matches',(SELECT jsonb_agg(p) FROM game_matches p),'players',(SELECT jsonb_agg(p) FROM game_players p),'rounds',(SELECT jsonb_agg(p) FROM game_rounds p),'journal',(SELECT jsonb_agg(p) FROM cab_migrations.history p))`,
        )
      const expected = snapshot(database)
      run(['kill', '--signal', 'KILL', id])
      run(['start', id])
      await ready()
      port = run(['port', id, '5432/tcp']).split(':').at(-1)
      assert.equal(snapshot(database), expected)
      migration('check', database)
      const backup = run([
        'exec',
        id,
        'pg_dump',
        '-U',
        'cab_test',
        '--no-owner',
        '--no-acl',
        '-d',
        database,
      ])
      psql('postgres', `CREATE DATABASE ${restored}`)
      run(
        ['exec', '-i', id, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'cab_test', '-d', restored],
        { input: backup },
      )
      migration('check', restored)
      assert.equal(snapshot(restored), expected)
      const invalid = spawnSync(
        'docker',
        [
          'exec',
          id,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'cab_test',
          '-d',
          restored,
          '-c',
          "INSERT INTO white_cards(id,pack_id,text) VALUES ('orphan','missing','bad')",
        ],
        { encoding: 'utf8' },
      )
      assert.notEqual(invalid.status, 0)
      assert.match(invalid.stderr, /foreign key constraint/)
      assert.equal(psql(restored, 'SELECT count(*) FROM pg_constraint WHERE NOT convalidated'), '0')
      console.log(`Disposable crash + backup/restore drill completed in ${Date.now() - start}ms`)
    } finally {
      if (containerCreated) run(['rm', '-f', id])
      if (volumeCreated) run(['volume', 'rm', id])
    }
  },
)
