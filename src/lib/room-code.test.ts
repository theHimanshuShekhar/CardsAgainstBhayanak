import { describe, it, expect } from "vitest";
import { generateRoomCode } from "./room-code";

describe("generateRoomCode", () => {
  it("generates a 6-character code", () => {
    expect(generateRoomCode()).toHaveLength(6);
  });

  it("contains only uppercase letters and digits (no I, O, 0, 1)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it("generates unique codes across 1000 calls", () => {
    const codes = new Set(Array.from({ length: 1000 }, generateRoomCode));
    expect(codes.size).toBeGreaterThan(990);
  });
});
