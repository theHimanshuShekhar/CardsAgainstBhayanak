import postgres from 'postgres'

// Session ownership is database-wide and distinct from the migration lock.
// Keep this connection private: a pooled/reconnecting session is not an owner.
export async function acquireRuntimeOwnership(): Promise<void> {
  let owned = false
  const lost = (reason: unknown): never => {
    console.error('Runtime ownership lost; exiting. Restart the app to recover rooms.', reason)
    // Graceful draining could run timers or socket-close effects without ownership.
    process.exit(1)
  }
  const owner = postgres(process.env['DATABASE_URL']!, {
    max: 1,
    idle_timeout: undefined,
    max_lifetime: null,
    connect_timeout: 5,
    connection: { application_name: 'cab-runtime-owner' },
    onclose: () => {
      if (owned) lost('PostgreSQL ownership session closed')
    },
  })
  try {
    const [lock] = await owner`SELECT pg_try_advisory_lock(520054) AS acquired`
    if (!lock?.acquired)
      throw new Error(
        'Runtime ownership refused: another app already owns this PostgreSQL database. Run exactly one app with its own PostgreSQL and Redis databases.',
      )
    owned = true
  } catch (error) {
    await owner.end({ timeout: 1 })
    throw error
  }
  // Bound silent network failure without reconnecting the ownership session:
  // one probe each second, at most five seconds waiting for its response.
  const probe = async () => {
    const deadline = setTimeout(() => lost('PostgreSQL ownership probe timed out'), 5000)
    try {
      await owner`SELECT 1`
    } catch (error) {
      lost(error)
    } finally {
      clearTimeout(deadline)
    }
    setTimeout(() => void probe(), 1000).unref()
  }
  setTimeout(() => void probe(), 1000).unref()
}
