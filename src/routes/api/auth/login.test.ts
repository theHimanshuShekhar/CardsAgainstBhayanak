import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { hashPassphrase, verifyPassphrase } from "../../../lib/password";

const TEST_USERNAME = "__vitest_login_user__";
const TEST_PASSPHRASE = "correcthorsebatterystaple";

beforeAll(async () => {
  const hash = await hashPassphrase(TEST_PASSPHRASE);
  await db
    .insert(users)
    .values({ username: TEST_USERNAME, passphraseHash: hash })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
});

describe("login logic", () => {
  it("returns true for the correct passphrase", async () => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, TEST_USERNAME))
      .limit(1);
    const ok = await verifyPassphrase(TEST_PASSPHRASE, user.passphraseHash);
    expect(ok).toBe(true);
  });

  it("returns false for a wrong passphrase", async () => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, TEST_USERNAME))
      .limit(1);
    const ok = await verifyPassphrase("wrongpassphrase", user.passphraseHash);
    expect(ok).toBe(false);
  });
});
