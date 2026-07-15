export type WriteEncoding = "utf-8" | "base64";

export type DecodedWrite =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: "invalid_base64" | "too_large" };

/** Decode once, then enforce the limit on the bytes that will reach R2. */
export function decodeWriteContent(content: string, encoding: WriteEncoding, maxBytes: number): DecodedWrite {
  if (encoding === "utf-8") {
    const bytes = new TextEncoder().encode(content);
    return bytes.byteLength <= maxBytes ? { ok: true, bytes } : { ok: false, error: "too_large" };
  }

  // Standard base64 only: padding may appear only at the end and the input
  // cannot have the impossible length remainder of one.
  if (
    content.length > Math.ceil(maxBytes / 3) * 4 + 4
    || content.length % 4 === 1
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
  ) {
    return { ok: false, error: content.length > Math.ceil(maxBytes / 3) * 4 + 4 ? "too_large" : "invalid_base64" };
  }

  try {
    const binary = atob(content);
    if (binary.length > maxBytes) return { ok: false, error: "too_large" };
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { ok: true, bytes };
  } catch {
    return { ok: false, error: "invalid_base64" };
  }
}

/**
 * OAuth redirect policy: public HTTPS clients, plus loopback HTTP for local
 * native clients. User-info and fragments are never valid redirect targets.
 */
export function isSafeOAuthRedirectUri(value: string): boolean {
  if (!value || value.length > 2048) return false;
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.hash) return false;
    if (uri.protocol === "https:") return true;
    const loopback = uri.hostname === "localhost"
      || uri.hostname === "127.0.0.1"
      || uri.hostname === "[::1]"
      || uri.hostname === "::1";
    return uri.protocol === "http:" && loopback;
  } catch {
    return false;
  }
}
