import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "./auth";

describe("JWT helpers", () => {
  it("signs and verifies a token round-trip", async () => {
    const token = await signToken({ sub: "42", username: "testuser" });
    const payload = await verifyToken(token);
    expect(payload?.sub).toBe("42");
    expect(payload?.username).toBe("testuser");
  });

  it("returns null for an invalid token", async () => {
    const result = await verifyToken("not.a.token");
    expect(result).toBeNull();
  });
});
