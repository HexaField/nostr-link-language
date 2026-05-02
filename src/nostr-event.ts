/**
 * Nostr event types and construction with runtime integration.
 *
 * Re-exports pure types and adds functions that use injected interfaces
 * (crypto, runtime adapter).
 */

export type {
    UnsignedNostrEvent,
    SignedNostrEvent,
    NostrFilter,
} from "./nostr-event.pure.js";

export {
    serializeForId,
    createTripleEvent,
    createTextNoteEvent,
    createReactionEvent,
    createDeletionEvent,
    getTagValue,
    getTagValues,
    isParameterizedReplaceable,
} from "./nostr-event.pure.js";

import type { UnsignedNostrEvent, SignedNostrEvent } from "./nostr-event.pure.js";
import { finalizeAndSignEvent } from "./crypto.js";

/**
 * Finalize an event: compute ID, set pubkey, and sign with Schnorr
 * if a private key is configured.
 */
export async function finalizeEvent(
    event: UnsignedNostrEvent,
    pubkey: string,
): Promise<SignedNostrEvent> {
    return finalizeAndSignEvent(event, pubkey);
}
