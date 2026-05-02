/**
 * Pure Nostr event types and construction functions.
 *
 * NIP-01 compliant event model. Zero runtime deps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An unsigned Nostr event — has all fields except id, pubkey, sig.
 */
export interface UnsignedNostrEvent {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
}

/**
 * A fully signed Nostr event per NIP-01.
 */
export interface SignedNostrEvent {
    id: string;        // 32-byte hex SHA-256 of serialized event
    pubkey: string;    // 32-byte hex of creator's secp256k1 pubkey
    created_at: number; // unix timestamp in seconds
    kind: number;      // event kind number
    tags: string[][];  // array of tag arrays
    content: string;   // arbitrary string
    sig: string;       // 64-byte hex Schnorr signature of id
}

/**
 * Nostr subscription filter per NIP-01.
 */
export interface NostrFilter {
    ids?: string[];
    authors?: string[];
    kinds?: number[];
    since?: number;
    until?: number;
    limit?: number;
    [tagFilter: `#${string}`]: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Event serialization for ID computation
// ---------------------------------------------------------------------------

/**
 * Serialize an event for ID computation per NIP-01:
 * JSON.serialize([0, pubkey, created_at, kind, tags, content])
 *
 * The result is the input to SHA-256 to produce the event ID.
 */
export function serializeForId(event: UnsignedNostrEvent, pubkey: string): string {
    return JSON.stringify([
        0,
        pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content,
    ]);
}

// ---------------------------------------------------------------------------
// Event construction helpers
// ---------------------------------------------------------------------------

/**
 * Create an unsigned kind 30078 (parameterized replaceable) event
 * for an AD4M link triple.
 */
export function createTripleEvent(
    neighbourhoodId: string,
    source: string,
    predicate: string,
    target: string,
    authorDid: string,
    proofSig: string,
    proofKey: string,
    linkHash: string,
    createdAt: number,
): UnsignedNostrEvent {
    return {
        kind: 30078,
        created_at: createdAt,
        tags: [
            ["d", `ad4m:${linkHash}`],
            ["ad4m:neighbourhood", neighbourhoodId],
            ["ad4m:source", source],
            ["ad4m:predicate", predicate],
            ["ad4m:target", target],
            ["ad4m:did", authorDid],
            ["ad4m:proof:sig", proofSig],
            ["ad4m:proof:key", proofKey],
            ["ad4m:link:hash", linkHash],
        ],
        content: "",
    };
}

/**
 * Create an unsigned kind 1 (short text note) event.
 */
export function createTextNoteEvent(
    content: string,
    neighbourhoodId: string,
    authorDid: string,
    createdAt: number,
    replyToEventId?: string,
    replyToPubkey?: string,
): UnsignedNostrEvent {
    const tags: string[][] = [
        ["t", "ad4m"],
        ["ad4m:neighbourhood", neighbourhoodId],
        ["ad4m:did", authorDid],
    ];

    // NIP-10 reply threading
    if (replyToEventId) {
        tags.push(["e", replyToEventId, "", "reply"]);
        if (replyToPubkey) {
            tags.push(["p", replyToPubkey]);
        }
    }

    return {
        kind: 1,
        created_at: createdAt,
        tags,
        content,
    };
}

/**
 * Create an unsigned kind 7 (reaction) event.
 */
export function createReactionEvent(
    reaction: string,
    targetEventId: string,
    targetPubkey: string,
    createdAt: number,
): UnsignedNostrEvent {
    return {
        kind: 7,
        created_at: createdAt,
        tags: [
            ["e", targetEventId],
            ["p", targetPubkey],
        ],
        content: reaction,
    };
}

/**
 * Create an unsigned kind 5 (deletion request) event.
 */
export function createDeletionEvent(
    targetEventIds: string[],
    createdAt: number,
    reason: string = "Link removed from AD4M perspective",
): UnsignedNostrEvent {
    return {
        kind: 5,
        created_at: createdAt,
        tags: targetEventIds.map(id => ["e", id]),
        content: reason,
    };
}

/**
 * Extract a tag value from a signed event by tag name.
 * Returns the first value (index 1) of the first matching tag.
 */
export function getTagValue(event: SignedNostrEvent, tagName: string): string | null {
    for (const tag of event.tags) {
        if (tag[0] === tagName && tag.length > 1) {
            return tag[1];
        }
    }
    return null;
}

/**
 * Extract all values for a tag name from a signed event.
 */
export function getTagValues(event: SignedNostrEvent, tagName: string): string[] {
    const values: string[] = [];
    for (const tag of event.tags) {
        if (tag[0] === tagName && tag.length > 1) {
            values.push(tag[1]);
        }
    }
    return values;
}

/**
 * Check if an event is a parameterized replaceable event (kind 30000-39999).
 */
export function isParameterizedReplaceable(kind: number): boolean {
    return kind >= 30000 && kind < 40000;
}
