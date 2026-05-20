import type { Pack } from './types'

// The CAH Core base set is always locked into a game (auto-selected on
// create, non-removable in the config editor). Shared by the create
// screen and the lobby config editor so the predicate can't diverge.
const BASE_PACK_SLUG = 'cah-base-set'

export const isBasePack = (p: Pack): boolean =>
  p.slug === BASE_PACK_SLUG || /^CAH Base Set/i.test(p.name)
