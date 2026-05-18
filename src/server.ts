import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createServerEntry } from '@tanstack/react-start/server-entry'
import { ensureServerBoot } from '~/lib/server-boot'

const fetch = createStartHandler(defaultStreamHandler)

// Seed cards, start the stale-game sweeper and keepalive enforcer.
// This runs once when the server process boots (dev or prod).
ensureServerBoot()

export default createServerEntry({ fetch })
