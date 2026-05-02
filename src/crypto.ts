/**
 * Nostr event cryptography: ID computation and Schnorr signing.
 *
 * Uses @noble/curves for BIP-340 Schnorr signatures over secp256k1.
 * This is a pure JS implementation — no native deps needed.
 *
 * The private key is provided via a template variable (NOSTR_PRIVKEY).
 * If no private key is configured, events are published unsigned.
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import { sha256Hex, bytesToHex, hexToBytes } from "./crypto.pure.js";
import type { UnsignedNostrEvent, SignedNostrEvent } from "./nostr-event.pure.js";
import { serializeForId } from "./nostr-event.pure.js";
import { schnorr } from "@noble/curves/secp256k1";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _privkeyBytes: Uint8Array | null = null;

/**
 * Initialize the signing module with a private key.
 * The private key is a 32-byte hex string (64 chars).
 */
export function initCryptoSigning(privkeyHex: string | null): void {
    if (privkeyHex && privkeyHex.length === 64 && /^[0-9a-f]+$/.test(privkeyHex)) {
        _privkeyBytes = hexToBytes(privkeyHex);
        console.log("[crypto] Schnorr signing initialized with private key");
    } else if (privkeyHex) {
        console.warn("[crypto] Invalid private key format (expected 64 hex chars). Signing disabled.");
        _privkeyBytes = null;
    } else {
        console.log("[crypto] No private key provided. Events will be published unsigned.");
        _privkeyBytes = null;
    }
}

/**
 * Check if signing is available.
 */
export function canSign(): boolean {
    return _privkeyBytes !== null;
}

/**
 * Get the public key corresponding to the configured private key.
 * Returns null if no private key is configured.
 */
export function getPublicKey(): string | null {
    if (!_privkeyBytes) return null;
    try {
        const pubkeyBytes = schnorr.getPublicKey(_privkeyBytes);
        return bytesToHex(pubkeyBytes);
    } catch (err) {
        console.error("[crypto] Failed to derive public key:", err);
        return null;
    }
}

/**
 * Compute the event ID per NIP-01:
 * SHA-256 of JSON.serialize([0, pubkey, created_at, kind, tags, content])
 */
export async function computeEventId(
    event: UnsignedNostrEvent,
    pubkey: string,
): Promise<string> {
    const serialized = serializeForId(event, pubkey);
    return await sha256Hex(serialized);
}

/**
 * Finalize and sign a Nostr event.
 *
 * If a private key is configured, produces a valid Schnorr signature.
 * Otherwise, returns the event with an empty sig field.
 */
export async function finalizeAndSignEvent(
    event: UnsignedNostrEvent,
    pubkey: string,
): Promise<SignedNostrEvent> {
    const eventId = await computeEventId(event, pubkey);

    let sig = "";
    if (_privkeyBytes) {
        try {
            const idBytes = hexToBytes(eventId);
            const sigBytes = schnorr.sign(idBytes, _privkeyBytes);
            sig = bytesToHex(sigBytes);
        } catch (err) {
            console.error("[crypto] Signing failed:", err);
        }
    }

    return {
        id: eventId,
        pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig,
    };
}

/**
 * Verify a Nostr event's ID matches its serialized content.
 */
export async function verifyEventId(event: SignedNostrEvent): Promise<boolean> {
    const expectedId = await computeEventId(event, event.pubkey);
    return event.id === expectedId;
}

/**
 * Verify a Nostr event: check ID and Schnorr signature.
 */
export async function verifyEvent(event: SignedNostrEvent): Promise<boolean> {
    const idValid = await verifyEventId(event);
    if (!idValid) return false;

    if (!event.sig || event.sig.length !== 128) return false;

    try {
        const sigBytes = hexToBytes(event.sig);
        const idBytes = hexToBytes(event.id);
        const pubkeyBytes = hexToBytes(event.pubkey);
        return schnorr.verify(sigBytes, idBytes, pubkeyBytes);
    } catch {
        return false;
    }
}
