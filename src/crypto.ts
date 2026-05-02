/**
 * secp256k1 Schnorr signing for Nostr events.
 *
 * Nostr uses BIP-340 Schnorr signatures over secp256k1.
 * AD4M's signing adapter uses Ed25519 (different curve), so Nostr
 * signing requires a separate approach.
 *
 * Strategy: The Neighbourhood's Nostr private key is stored in settings
 * (encrypted at rest). Actual signing is delegated to the executor via
 * signal-based communication. The executor has access to WebSocket and
 * can perform the signing using a full secp256k1 library.
 *
 * This module provides:
 * - Event ID computation (SHA-256 of canonical serialization) — fully implemented
 * - Signature creation via executor delegation (emitSignal)
 * - Signature verification structure
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import { sha256Hex } from "./crypto.pure.js";
import type { UnsignedNostrEvent, SignedNostrEvent } from "./nostr-event.pure.js";
import { serializeForId } from "./nostr-event.pure.js";
import { getRuntime } from "./runtime-interface.js";

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
 * Request the executor to sign a Nostr event via signal delegation.
 *
 * The executor manages the secp256k1 private key and WebSocket connections.
 * It receives the unsigned event, signs it, and sends back the signed
 * event via a return signal.
 *
 * Returns the event with id, pubkey, and sig fields populated by the
 * executor. In the meantime, returns a provisional event with empty sig
 * that can be used optimistically.
 */
export function requestEventSign(
    event: UnsignedNostrEvent,
    pubkey: string,
    eventId: string,
): SignedNostrEvent {
    // Emit signal requesting the executor to sign and publish
    const signRequest = JSON.stringify({
        type: "nostr:sign",
        event: {
            ...event,
            id: eventId,
            pubkey,
        },
    });
    getRuntime().emitSignal(signRequest);

    // Return the event with computed id and pubkey.
    // The sig will be filled by the executor before publishing to relays.
    return {
        id: eventId,
        pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: "", // Filled by executor
    };
}

/**
 * Verify a Nostr event's ID matches its serialized content.
 * This is the first layer of verification — checking structural integrity.
 *
 * Full Schnorr signature verification requires secp256k1 and is
 * delegated to the executor.
 */
export async function verifyEventId(event: SignedNostrEvent): Promise<boolean> {
    const expectedId = await computeEventId(event, event.pubkey);
    return event.id === expectedId;
}

/**
 * Request the executor to verify a Nostr event's Schnorr signature.
 * Returns true optimistically if the event ID is valid — full sig
 * verification is handled by the executor.
 */
export async function verifyEvent(event: SignedNostrEvent): Promise<boolean> {
    // First check event ID integrity (we can do this ourselves)
    const idValid = await verifyEventId(event);
    if (!idValid) return false;

    // If no sig, it's unsigned (e.g. from our own pending events)
    if (!event.sig) return false;

    // Emit verification request for the executor
    getRuntime().emitSignal(JSON.stringify({
        type: "nostr:verify",
        event,
    }));

    // We trust the event if the ID is correct — the executor will
    // async-reject events with bad signatures via signal
    return true;
}
