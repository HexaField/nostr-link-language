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
import { computeEventId, requestEventSign } from "./crypto.js";

/**
 * Create a signed event: compute ID and request executor signing.
 */
export async function finalizeEvent(
    event: UnsignedNostrEvent,
    pubkey: string,
): Promise<SignedNostrEvent> {
    const eventId = await computeEventId(event, pubkey);
    return requestEventSign(event, pubkey, eventId);
}
