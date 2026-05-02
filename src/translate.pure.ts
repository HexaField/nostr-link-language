/**
 * Pure translation functions: Link ↔ Nostr event.
 *
 * Zero runtime deps. All functions are deterministic and testable.
 *
 * Spec §6: Bidirectional Translation.
 */

import type { LinkExpression } from "./types.js";
import type { UnsignedNostrEvent, SignedNostrEvent } from "./nostr-event.pure.js";
import {
    createTripleEvent,
    createTextNoteEvent,
    createReactionEvent,
    createDeletionEvent,
    getTagValue,
} from "./nostr-event.pure.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ISO timestamp to unix seconds.
 */
export function isoToUnix(iso: string): number {
    const ms = new Date(iso).getTime();
    return Math.floor(ms / 1000);
}

/**
 * Convert unix seconds to ISO timestamp.
 */
export function unixToIso(unix: number): string {
    return new Date(unix * 1000).toISOString();
}

/**
 * Deterministic content key for a LinkExpression.
 */
export function linkContentKey(link: LinkExpression): string {
    return `${link.data.source || ""}:${link.data.predicate || ""}:${link.data.target || ""}:${link.author}:${link.timestamp}`;
}

// ---------------------------------------------------------------------------
// Outbound: Link → Nostr Event
// ---------------------------------------------------------------------------

/**
 * Translate a LinkExpression to a kind 30078 triple event.
 *
 * This is the lossless representation — all link data is preserved in tags.
 */
export function linkToTripleEvent(
    link: LinkExpression,
    neighbourhoodId: string,
    linkHash: string,
): UnsignedNostrEvent {
    return createTripleEvent(
        neighbourhoodId,
        link.data.source || "",
        link.data.predicate || "",
        link.data.target || "",
        link.author,
        link.proof.signature,
        link.proof.key,
        linkHash,
        isoToUnix(link.timestamp),
    );
}

/**
 * Translate a chat-style link to a kind 1 text note.
 *
 * The content is either resolved expression content or the raw target URI.
 */
export function linkToTextNote(
    link: LinkExpression,
    neighbourhoodId: string,
    content: string,
    replyToEventId?: string,
    replyToPubkey?: string,
): UnsignedNostrEvent {
    return createTextNoteEvent(
        content,
        neighbourhoodId,
        link.author,
        isoToUnix(link.timestamp),
        replyToEventId,
        replyToPubkey,
    );
}

/**
 * Translate a reaction link to a kind 7 reaction event.
 */
export function linkToReactionEvent(
    reaction: string,
    targetEventId: string,
    targetPubkey: string,
    createdAt: number,
): UnsignedNostrEvent {
    return createReactionEvent(reaction, targetEventId, targetPubkey, createdAt);
}

/**
 * Translate a link removal to a kind 5 deletion event.
 */
export function linkRemovalToDeletionEvent(
    originalEventIds: string[],
    createdAt: number,
): UnsignedNostrEvent {
    return createDeletionEvent(originalEventIds, createdAt);
}

// ---------------------------------------------------------------------------
// Inbound: Nostr Event → Link
// ---------------------------------------------------------------------------

/**
 * Translate a kind 30078 triple event back to a LinkExpression.
 *
 * Lossless: all data is extracted from tags.
 * Returns null if required tags are missing.
 */
export function tripleEventToLink(event: SignedNostrEvent): LinkExpression | null {
    const source = getTagValue(event, "ad4m:source");
    const predicate = getTagValue(event, "ad4m:predicate");
    const target = getTagValue(event, "ad4m:target");

    if (source === null || target === null) return null;

    const authorDid = getTagValue(event, "ad4m:did");
    const proofSig = getTagValue(event, "ad4m:proof:sig");
    const proofKey = getTagValue(event, "ad4m:proof:key");

    return {
        author: authorDid || `nostr:${event.pubkey}`,
        timestamp: unixToIso(event.created_at),
        data: {
            source,
            target,
            predicate: predicate || undefined,
        },
        proof: {
            signature: proofSig || "",
            key: proofKey || "",
        },
    };
}

/**
 * Translate a kind 1 text note event to a synthesized LinkExpression.
 *
 * Lossy: the link triple is synthesized from the note's metadata.
 * source = neighbourhoodUrl, predicate = "sioc://content_of", target = event content key
 */
export function textNoteToLink(
    event: SignedNostrEvent,
    neighbourhoodUrl: string,
): LinkExpression {
    const authorDid = getTagValue(event, "ad4m:did");

    return {
        author: authorDid || `nostr:${event.pubkey}`,
        timestamp: unixToIso(event.created_at),
        data: {
            source: neighbourhoodUrl,
            predicate: "sioc://content_of",
            target: `nostr:note:${event.id}`,
        },
        proof: {
            signature: "",
            key: "",
        },
    };
}

/**
 * Translate a kind 7 reaction event to a LinkExpression.
 */
export function reactionEventToLink(
    event: SignedNostrEvent,
): LinkExpression | null {
    const targetEventId = getTagValue(event, "e");
    if (!targetEventId) return null;

    const authorDid = getTagValue(event, "ad4m:did");

    return {
        author: authorDid || `nostr:${event.pubkey}`,
        timestamp: unixToIso(event.created_at),
        data: {
            source: `nostr:note:${targetEventId}`,
            predicate: "flux://has_reaction",
            target: event.content || "👍",
        },
        proof: {
            signature: "",
            key: "",
        },
    };
}

/**
 * Translate a kind 5 deletion event to removal LinkExpressions.
 *
 * Returns one link per deleted event ID.
 */
export function deletionEventToRemovals(
    event: SignedNostrEvent,
    neighbourhoodUrl: string,
): LinkExpression[] {
    const removals: LinkExpression[] = [];
    for (const tag of event.tags) {
        if (tag[0] === "e" && tag[1]) {
            removals.push({
                author: `nostr:${event.pubkey}`,
                timestamp: unixToIso(event.created_at),
                data: {
                    source: neighbourhoodUrl,
                    predicate: "nostr://deleted",
                    target: `nostr:note:${tag[1]}`,
                },
                proof: { signature: "", key: "" },
            });
        }
    }
    return removals;
}

/**
 * Generic inbound event → LinkExpression dispatcher.
 *
 * Routes to the appropriate handler based on event kind.
 */
export function eventToLinks(
    event: SignedNostrEvent,
    neighbourhoodUrl: string,
): LinkExpression[] {
    switch (event.kind) {
        case 30078: {
            const link = tripleEventToLink(event);
            return link ? [link] : [];
        }
        case 1: {
            return [textNoteToLink(event, neighbourhoodUrl)];
        }
        case 7: {
            const link = reactionEventToLink(event);
            return link ? [link] : [];
        }
        case 5: {
            return deletionEventToRemovals(event, neighbourhoodUrl);
        }
        default:
            return [];
    }
}
