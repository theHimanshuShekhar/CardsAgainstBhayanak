import { manageSchema } from '../src/db/migrations'

const command = process.argv[2]
if (command !== 'check' && command !== 'apply' && command !== 'adopt') {
  throw new Error('Usage: migrate.ts check|apply|adopt')
}
try {
  await manageSchema(command)
  console.log(`Database ${command} complete`)
} catch (error) {
  // Do not print connection strings or driver errors containing SQL/data.
  console.error(error instanceof Error ? error.message : 'Database operation failed')
  process.exitCode = 1
}
