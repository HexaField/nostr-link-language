/**
 * Pure functions for telepresence: event construction, parsing, TTL filtering.
 *
 * Zero runtime deps. Testable without network or ad4m:host imports.
 */

import type { UnsignedNostrEvent, SignedNostrEvent } from "./nostr-event.pure.js";

// ---------------------------------------------------------------------------
// Ephemeral event kinds (NIP-16: 20000-29999)
// ---------------------------------------------------------------------------

/** Presence heartbeat — agent online status. */
export const KIND_PRESENCE = 20042;

/** Direct signal — to a specific peer. */
export const KIND_SIGNAL = 20043;

/** Broadcast signal — to all neighbourhood peers. */
export const KIND_BROADCAST = 20044;

/** All telepresence event kinds. */
export const TELEPRESENCE_KINDS = [KIND_PRESENCE, KIND_SIGNAL, KIND_BROADCAST] as const;

/** Default TTL for presence heartbeats (30 seconds). */
export const PRESENCE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PresenceHeartbeat {
    did: string;
    status: unknown;
    timestamp: number;
}

export interface DirectSignalPayload {
    from: string;
    to: string;
    payload: unknown;
}

export interface BroadcastPayload {
    from: string;
    payload: unknown;
}

export interface OnlinePeer {
    did: string;
    status: unknown;
    lastSeen: number;
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

/**
 * Create an unsigned ephemeral presence heartbeat event.
 */
export function createPresenceEvent(
    neighbourhoodId: string,
    did: string,
    status: unknown,
    now?: number,
): UnsignedNostrEvent {
    const timestamp = now ?? Math.floor(Date.now() / 1000);
    return {
        kind: KIND_PRESENCE,
        created_at: timestamp,
        tags: [
            ["d", neighbourhoodId],
            ["t", "ad4m-presence"],
        ],
        content: JSON.stringify({
            did,
            status,
            timestamp: timestamp * 1000, // ms for content
        } satisfies PresenceHeartbeat),
    };
}

/**
 * Create an unsigned ephemeral direct signal event.
 */
export function createSignalEvent(
    neighbourhoodId: string,
    fromDid: string,
    toDid: string,
    recipientPubkey: string,
    payload: unknown,
    now?: number,
): UnsignedNostrEvent {
    const timestamp = now ?? Math.floor(Date.now() / 1000);
    return {
        kind: KIND_SIGNAL,
        created_at: timestamp,
        tags: [
            ["d", neighbourhoodId],
            ["p", recipientPubkey],
            ["t", "ad4m-signal"],
        ],
        content: JSON.stringify({
            from: fromDid,
            to: toDid,
            payload,
        } satisfies DirectSignalPayload),
    };
}

/**
 * Create an unsigned ephemeral broadcast signal event.
 */
export function createBroadcastEvent(
    neighbourhoodId: string,
    fromDid: string,
    payload: unknown,
    now?: number,
): UnsignedNostrEvent {
    const timestamp = now ?? Math.floor(Date.now() / 1000);
    return {
        kind: KIND_BROADCAST,
        created_at: timestamp,
        tags: [
            ["d", neighbourhoodId],
            ["t", "ad4m-broadcast"],
        ],
        content: JSON.stringify({
            from: fromDid,
            payload,
        } satisfies BroadcastPayload),
    };
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

/**
 * Parse a presence heartbeat from an event's content.
 * Returns null if the content is invalid.
 */
export function parsePresenceContent(content: string): PresenceHeartbeat | null {
    try {
        const parsed = JSON.parse(content);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            typeof parsed.did === "string" &&
            "status" in parsed &&
            typeof parsed.timestamp === "number"
        ) {
            return parsed as PresenceHeartbeat;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Parse a direct signal payload from an event's content.
 * Returns null if the content is invalid.
 */
export function parseSignalContent(content: string): DirectSignalPayload | null {
    try {
        const parsed = JSON.parse(content);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            typeof parsed.from === "string" &&
            typeof parsed.to === "string" &&
            "payload" in parsed
        ) {
            return parsed as DirectSignalPayload;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Parse a broadcast payload from an event's content.
 * Returns null if the content is invalid.
 */
export function parseBroadcastContent(content: string): BroadcastPayload | null {
    try {
        const parsed = JSON.parse(content);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            typeof parsed.from === "string" &&
            "payload" in parsed
        ) {
            return parsed as BroadcastPayload;
        }
        return null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Presence TTL filtering
// ---------------------------------------------------------------------------

/**
 * Filter a map of online peers, removing entries older than the TTL.
 * Returns a new Map with only fresh entries.
 */
export function filterStalePeers(
    peers: Map<string, OnlinePeer>,
    now: number,
    ttlMs: number = PRESENCE_TTL_MS,
): Map<string, OnlinePeer> {
    const fresh = new Map<string, OnlinePeer>();
    for (const [did, peer] of peers) {
        if (now - peer.lastSeen < ttlMs) {
            fresh.set(did, peer);
        }
    }
    return fresh;
}

/**
 * Get the list of online agents from a peer map, filtering stale entries.
 */
export function getOnlineAgentsList(
    peers: Map<string, OnlinePeer>,
    now: number,
    ttlMs: number = PRESENCE_TTL_MS,
): OnlinePeer[] {
    const result: OnlinePeer[] = [];
    for (const [, peer] of peers) {
        if (now - peer.lastSeen < ttlMs) {
            result.push(peer);
        }
    }
    return result;
}

/**
 * Extract the neighbourhood ID (d tag) from a signed event.
 */
export function getNeighbourhoodFromEvent(event: SignedNostrEvent): string | null {
    for (const tag of event.tags) {
        if (tag[0] === "d" && tag.length > 1) {
            return tag[1];
        }
    }
    return null;
}

/**
 * Classify a telepresence event by kind.
 */
export function classifyTelepresenceEvent(
    event: SignedNostrEvent,
): "presence" | "signal" | "broadcast" | null {
    switch (event.kind) {
        case KIND_PRESENCE:
            return "presence";
        case KIND_SIGNAL:
            return "signal";
        case KIND_BROADCAST:
            return "broadcast";
        default:
            return null;
    }
}
