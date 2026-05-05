// Run once at setup: pnpm seed
// Idempotent — safe to re-run. Fetches from REST Against Humanity API.

import { db } from "../src/db/client";
import { packs, blackCards, whiteCards } from "../src/db/schema";
import { eq } from "drizzle-orm";

const API_BASE = "https://restagainsthumanity.com/api/v2";

interface ApiPack {
  name: string;
  black: Array<{ text: string; pick: number }>;
  white: Array<{ text: string }>;
}

async function fetchPackNames(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/packs`);
  if (!res.ok) throw new Error(`Failed to fetch packs: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.packs ?? [];
}

async function fetchPackCards(packName: string): Promise<ApiPack> {
  const res = await fetch(
    `${API_BASE}/cards?packs=${encodeURIComponent(packName)}`
  );
  if (!res.ok) throw new Error(`Failed to fetch cards for ${packName}: ${res.status}`);
  return res.json();
}

async function seed() {
  console.log("Fetching pack list…");
  const packNames = await fetchPackNames();
  console.log(`Found ${packNames.length} packs`);

  for (const packName of packNames) {
    console.log(`Seeding: ${packName}`);

    const [pack] = await db
      .insert(packs)
      .values({ name: packName, official: true })
      .onConflictDoUpdate({
        target: packs.name,
        set: { official: true },
      })
      .returning();

    const data = await fetchPackCards(packName);

    await db.delete(blackCards).where(eq(blackCards.packId, pack.id));
    await db.delete(whiteCards).where(eq(whiteCards.packId, pack.id));

    if (data.black?.length) {
      await db.insert(blackCards).values(
        data.black.map((c) => ({
          packId: pack.id,
          text: c.text,
          pick: c.pick ?? 1,
        }))
      );
    }

    if (data.white?.length) {
      await db.insert(whiteCards).values(
        data.white.map((c) => ({ packId: pack.id, text: c.text }))
      );
    }

    console.log(
      `  ✓ ${data.black?.length ?? 0} black, ${data.white?.length ?? 0} white`
    );
  }

  console.log("Seed complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
