import { describe, it, expect, afterAll } from "vitest";
import { db } from "./client";
import { packs, blackCards, whiteCards } from "./schema";
import { eq } from "drizzle-orm";

const TEST_PACK_NAME = "__vitest_test_pack__";

afterAll(async () => {
  await db.delete(packs).where(eq(packs.name, TEST_PACK_NAME));
});

describe("Drizzle schema", () => {
  it("inserts and retrieves a pack with cards", async () => {
    const [pack] = await db
      .insert(packs)
      .values({ name: TEST_PACK_NAME, official: false })
      .returning();

    expect(pack.id).toBeGreaterThan(0);
    expect(pack.name).toBe(TEST_PACK_NAME);

    await db.insert(blackCards).values({
      packId: pack.id,
      text: "Test black card _.",
      pick: 1,
    });

    await db.insert(whiteCards).values({
      packId: pack.id,
      text: "Test white card.",
    });

    const blacks = await db
      .select()
      .from(blackCards)
      .where(eq(blackCards.packId, pack.id));
    const whites = await db
      .select()
      .from(whiteCards)
      .where(eq(whiteCards.packId, pack.id));

    expect(blacks).toHaveLength(1);
    expect(whites).toHaveLength(1);
    expect(blacks[0].pick).toBe(1);
  });

  it("seeder is idempotent — pack count stays stable after double insert", async () => {
    const before = await db.select().from(packs);

    await db
      .insert(packs)
      .values({ name: TEST_PACK_NAME, official: false })
      .onConflictDoUpdate({
        target: packs.name,
        set: { official: false },
      });

    const after = await db.select().from(packs);
    expect(after.length).toBe(before.length);
  });
});
