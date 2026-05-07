import { describe, it, expect, afterAll } from "vitest";
import { db } from "../../../../src/db/client";
import { users } from "../../../../src/db/schema";
import { eq } from "drizzle-orm";
import { hashPassphrase } from "../../../../src/lib/password";
import { signToken } from "../../../../src/lib/auth";

const TEST_USERNAME = "__vitest_reg_user__";

afterAll(async () => {
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
});

describe("register logic", () => {
  it("creates a user and returns a signed token", async () => {
    const hash = await hashPassphrase("supersecret");
    const [user] = await db
      .insert(users)
      .values({ username: TEST_USERNAME, passphraseHash: hash })
      .returning();

    expect(user.id).toBeGreaterThan(0);
    expect(user.username).toBe(TEST_USERNAME);

    const token = await signToken({
      sub: String(user.id),
      username: user.username,
    });
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  it("rejects a duplicate username (unique constraint)", async () => {
    const hash = await hashPassphrase("another");
    await expect(
      db
        .insert(users)
        .values({ username: TEST_USERNAME, passphraseHash: hash })
    ).rejects.toThrow();
  });
});
