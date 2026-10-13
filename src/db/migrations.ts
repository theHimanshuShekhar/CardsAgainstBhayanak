import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

// Catalog definitions include types, defaults, nullability, keys and indexes.
// Ordering is explicit; OIDs and data never enter the compatibility signature.
export async function schemaSignature(sql: postgres.Sql) {
  const rows = await sql`
    SELECT kind, name, definition FROM (
      SELECT 'column' AS kind, c.relname || '.' || a.attname AS name,
        format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' ||
        coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL
      SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname='public'
      UNION ALL
      SELECT 'enum', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
      FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
      JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' GROUP BY t.typname
    ) definitions ORDER BY kind, name`
  return digest(JSON.stringify(rows))
}

type Migration = { file: string; sha256: string; schema: string }

export async function manageSchema(command: 'check' | 'apply' | 'adopt') {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const manifest: Migration[] = JSON.parse(await readFile('drizzle/manifest.json', 'utf8'))
  if (!manifest.length) throw new Error('Empty migration manifest')
  const migrations = await Promise.all(
    manifest.map(async (entry) => {
      const sql = await readFile(`drizzle/${entry.file}`, 'utf8')
      if (digest(sql) !== entry.sha256)
        throw new Error(`Migration checksum mismatch: ${entry.file}`)
      return { ...entry, sql }
    }),
  )
  const client = postgres(process.env.DATABASE_URL, { max: 1 })
  try {
    await client.begin(async (tx) => {
      // Serialize migration/check/adoption across deployment processes.
      await tx`SELECT pg_advisory_xact_lock(520052)`
      const sql = tx as unknown as postgres.Sql
      const [exists] = await tx`SELECT to_regclass('cab_migrations.history') AS history`
      if (!exists?.history && command === 'check')
        throw new Error('Unversioned database; run reviewed db:migrate or db:baseline first')
      if (!exists?.history) {
        await tx`CREATE SCHEMA cab_migrations`
        await tx`CREATE TABLE cab_migrations.history (position integer PRIMARY KEY, file text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
      }
      const history =
        await tx`SELECT position, file, sha256 FROM cab_migrations.history ORDER BY position`
      for (const [index, row] of history.entries()) {
        const entry = migrations[index]
        if (
          !entry ||
          row.position !== index ||
          row.file !== entry.file ||
          row.sha256 !== entry.sha256
        ) {
          throw new Error('Incompatible migration history; refusing altered or newer schema')
        }
      }
      if (command === 'adopt') {
        if (history.length) throw new Error('Baseline adoption requires an unversioned database')
        if ((await schemaSignature(sql)) !== migrations[0]!.schema)
          throw new Error('Existing schema differs from baseline; review drift before adoption')
        await tx`INSERT INTO cab_migrations.history (position, file, sha256) VALUES (0, ${migrations[0]!.file}, ${migrations[0]!.sha256})`
        return
      }
      if (
        history.length &&
        (await schemaSignature(sql)) !== migrations[history.length - 1]!.schema
      ) {
        throw new Error('Database schema drift detected; refusing deployment')
      }
      if (command === 'check') {
        if (history.length !== migrations.length)
          throw new Error('Pending migrations; run reviewed db:migrate before startup')
        return
      }
      if (!history.length) {
        const [objects] =
          await tx`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','m','S')`
        if (objects?.count)
          throw new Error('Existing unversioned database; use db:baseline after backup and review')
      }
      for (let index = history.length; index < migrations.length; index++) {
        const entry = migrations[index]!
        await tx.unsafe(entry.sql)
        if ((await schemaSignature(sql)) !== entry.schema)
          throw new Error(`Migration schema mismatch: ${entry.file}`)
        await tx`INSERT INTO cab_migrations.history (position, file, sha256) VALUES (${index}, ${entry.file}, ${entry.sha256})`
      }
    })
  } finally {
    await client.end()
  }
}
