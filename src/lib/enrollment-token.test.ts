import { describe, it, expect } from "bun:test";
import { generateEnrollmentToken, hashEnrollmentToken, looksLikeEnrollmentToken } from "./enrollment-token.ts";
import { hashMachineToken } from "./machine-token.ts";

describe("enrollment tokens", () => {
  it("generates a che_-prefixed, unique cleartext token", () => {
    const a = generateEnrollmentToken();
    const b = generateEnrollmentToken();
    expect(a.startsWith("che_")).toBe(true);
    expect(looksLikeEnrollmentToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("hashes deterministically with the same secret", () => {
    const t = generateEnrollmentToken();
    expect(hashEnrollmentToken(t, "secret")).toBe(hashEnrollmentToken(t, "secret"));
    expect(hashEnrollmentToken(t, "secret")).not.toBe(hashEnrollmentToken(t, "other"));
  });

  it("is cryptographically separated from the machine-token hash (distinct key domain)", () => {
    const t = "che_sharedtokenmaterial";
    expect(hashEnrollmentToken(t, "secret")).not.toBe(hashMachineToken(t, "secret"));
  });

  it("looksLikeEnrollmentToken is false for machine tokens and JWTs", () => {
    expect(looksLikeEnrollmentToken("cht_abc")).toBe(false);
    expect(looksLikeEnrollmentToken("eyJ.a.b")).toBe(false);
  });
});
