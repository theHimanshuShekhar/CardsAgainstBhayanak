import { createServerFn } from '@tanstack/react-start'
import { readSiteOrigin } from './site-origin.server'

// Only the validated public origin crosses the server boundary.
export const getSiteOrigin = createServerFn({ method: 'GET' }).handler(() => readSiteOrigin())
