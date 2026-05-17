import { db } from '~/db'
import { packs, blackCards, whiteCards } from '~/db/schema'
import { seedLogger } from './logger'
import { sql } from 'drizzle-orm'

const API_BASE = 'https://restagainsthumanity.com/api/v2'

type RawCardsResponse = {
  black: { text: string; pick: number; pack: string }[]
  white: { text: string; pack: string }[]
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeBlackText(raw: string): string {
  return raw.replace(/_/g, '__________')
}

async function fetchWithRetry(url: string, attempt = 1): Promise<Response> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  } catch (err) {
    if (attempt >= 5) throw err
    const delay = Math.min(30_000, 1000 * Math.pow(2, attempt - 1))
    seedLogger.warn({ url, attempt, err }, 'seed retry')
    await new Promise((r) => setTimeout(r, delay))
    return fetchWithRetry(url, attempt + 1)
  }
}

export async function seedPacks(): Promise<void> {
  const start = Date.now()
  seedLogger.info('starting REST AH seed')

  const packsRes = await fetchWithRetry(`${API_BASE}/packs`)
  const packNames: string[] = await packsRes.json()
  seedLogger.info({ count: packNames.length }, 'pack names fetched')

  let totalBlack = 0
  let totalWhite = 0

  for (const name of packNames) {
    const slug = slugify(name)
    const [pack] = await db
      .insert(packs)
      .values({ name, slug, cardCount: 0 })
      .onConflictDoNothing({ target: packs.slug })
      .returning()

    const existing =
      pack ??
      (
        await db
          .select()
          .from(packs)
          .where(sql`${packs.slug} = ${slug}`)
      ).at(0)
    if (!existing) continue

    const cardsUrl = `${API_BASE}/cards?packs=${encodeURIComponent(name)}&includePackNames=true`
    const cardsRes = await fetchWithRetry(cardsUrl)
    const cards: RawCardsResponse = await cardsRes.json()

    if (cards.black.length > 0) {
      await db
        .insert(blackCards)
        .values(
          cards.black.map((c) => ({
            packId: existing.id,
            text: normalizeBlackText(c.text),
            pick: c.pick as 1 | 2 | 3,
          })),
        )
        .onConflictDoNothing()
      totalBlack += cards.black.length
    }
    if (cards.white.length > 0) {
      await db
        .insert(whiteCards)
        .values(cards.white.map((c) => ({ packId: existing.id, text: c.text })))
        .onConflictDoNothing()
      totalWhite += cards.white.length
    }

    await db
      .update(packs)
      .set({ cardCount: cards.black.length + cards.white.length })
      .where(sql`${packs.id} = ${existing.id}`)
  }

  // Baked-in synthetic card for the Happy Ending house rule's forced
  // final round (not part of the REST AH packs).
  const [haikuPack] = await db
    .insert(packs)
    .values({ name: 'Haiku Final', slug: 'haiku-final', cardCount: 1 })
    .onConflictDoNothing({ target: packs.slug })
    .returning()
  const hp =
    haikuPack ??
    (
      await db
        .select()
        .from(packs)
        .where(sql`${packs.slug} = 'haiku-final'`)
    ).at(0)
  if (hp) {
    await db
      .insert(blackCards)
      .values({ packId: hp.id, text: 'Make a Haiku.', pick: 3 })
      .onConflictDoNothing()
  }

  seedLogger.info(
    { packs: packNames.length, black: totalBlack, white: totalWhite, ms: Date.now() - start },
    'seed complete',
  )
}

// CLI entry: pnpm seed
if (import.meta.url === `file://${process.argv[1]}`) {
  seedPacks()
    .then(() => process.exit(0))
    .catch((err) => {
      seedLogger.error({ err }, 'seed failed')
      process.exit(1)
    })
}
