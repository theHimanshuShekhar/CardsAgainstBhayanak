import postgres from 'postgres'
import { schemaSignature } from '../src/db/migrations'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
try {
  console.log(await schemaSignature(sql))
} finally {
  await sql.end()
}
