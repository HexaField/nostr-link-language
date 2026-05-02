/**
 * Pure SHA-256 and hex encoding helpers.
 *
 * Zero runtime deps. Uses Web Crypto API (available in Node 18+, Deno, browsers).
 * For synchronous contexts, provides a simple non-crypto hash fallback.
 */

// ---------------------------------------------------------------------------
// Hex encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array to a lowercase hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
    const hex: string[] = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        hex[i] = bytes[i].toString(16).padStart(2, "0");
    }
    return hex.join("");
}

/**
 * Convert a lowercase hex string to a Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
    const len = hex.length;
    const bytes = new Uint8Array(len / 2);
    for (let i = 0; i < len; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

/**
 * Validate that a string is a valid lowercase hex string of expected length.
 */
export function isValidHex(s: string, expectedBytes?: number): boolean {
    if (typeof s !== "string") return false;
    if (expectedBytes !== undefined && s.length !== expectedBytes * 2) return false;
    if (s.length === 0) return true;
    return /^[0-9a-f]+$/.test(s);
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a string, returning lowercase hex.
 * Uses Web Crypto API (async).
 */
export async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
    return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Compute SHA-256 hash of a Uint8Array, returning a Uint8Array.
 * Uses Web Crypto API (async).
 */
export async function sha256(input: Uint8Array): Promise<Uint8Array> {
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", input);
    return new Uint8Array(hashBuffer);
}

// ---------------------------------------------------------------------------
// Synchronous hash (for deterministic IDs in sync contexts)
// ---------------------------------------------------------------------------

/**
 * Simple synchronous hash function for non-cryptographic use cases.
 * Uses DJB2a variant. Returns a hex string.
 *
 * NOT for cryptographic purposes — only for deterministic content keys
 * when async crypto is unavailable.
 */
export function simpleHash(data: string): string {
    let h = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < data.length; i++) {
        h ^= data.charCodeAt(i);
        h = (h * 0x01000193) | 0; // FNV prime
    }
    // Convert to 8 hex chars (positive)
    return (h >>> 0).toString(16).padStart(8, "0");
}
