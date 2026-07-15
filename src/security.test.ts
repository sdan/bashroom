import { describe, expect, it } from "vitest";
import { decodeWriteContent, isSafeOAuthRedirectUri } from "./security";

describe("decodeWriteContent", () => {
  it("measures UTF-8 bytes rather than JavaScript characters", () => {
    expect(decodeWriteContent("🙂", "utf-8", 3)).toEqual({ ok: false, error: "too_large" });
    const decoded = decodeWriteContent("🙂", "utf-8", 4);
    expect(decoded.ok && decoded.bytes.byteLength).toBe(4);
  });

  it("strictly decodes standard base64 and caps decoded bytes", () => {
    expect(decodeWriteContent("aGVsbG8=", "base64", 5)).toMatchObject({ ok: true });
    expect(decodeWriteContent("aGVsbG8=", "base64", 4)).toEqual({ ok: false, error: "too_large" });
    expect(decodeWriteContent("not base64", "base64", 100)).toEqual({ ok: false, error: "invalid_base64" });
  });
});

describe("isSafeOAuthRedirectUri", () => {
  it("allows HTTPS and loopback HTTP redirects", () => {
    expect(isSafeOAuthRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isSafeOAuthRedirectUri("http://127.0.0.1:43123/callback")).toBe(true);
    expect(isSafeOAuthRedirectUri("http://localhost:3000/callback")).toBe(true);
  });

  it("rejects remote HTTP, credentials, fragments, and non-HTTP schemes", () => {
    expect(isSafeOAuthRedirectUri("http://example.com/callback")).toBe(false);
    expect(isSafeOAuthRedirectUri("https://user:pass@example.com/callback")).toBe(false);
    expect(isSafeOAuthRedirectUri("https://example.com/callback#fragment")).toBe(false);
    expect(isSafeOAuthRedirectUri("javascript:alert(1)")).toBe(false);
  });
});
