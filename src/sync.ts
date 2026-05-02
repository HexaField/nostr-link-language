/**
 * Sync coordination module.
 *
 * Since Nostr has no HTTP polling fallback, sync() works by:
 * 1. Accumulating events received via handleSignal() between calls
 * 2. On sync(), drain the event buffer
 * 3. Translate events to links
 * 4. Deduplicate and return diff
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import type { SignedNostrEvent } from "./nostr-event.pure.js";
import { processInboundEvents } from "./translate.js";
import * as store from "./store.js";

// ---------------------------------------------------------------------------
// Event buffer
// ---------------------------------------------------------------------------

let _eventBuffer: SignedNostrEvent[] = [];

/**
 * Add an event to the sync buffer.
 * Called by handleSignal() when the executor forwards Nostr events.
 */
export function bufferEvent(event: SignedNostrEvent): void {
    _eventBuffer.push(event);
}

/**
 * Get the current buffer size (for monitoring).
 */
export function getBufferSize(): number {
    return _eventBuffer.length;
}

/**
 * Clear the event buffer (used after sync or for testing).
 */
export function clearBuffer(): void {
    _eventBuffer = [];
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Drain the event buffer, process events, store links, return diff.
 *
 * Deduplicates events by ID to handle multi-relay delivery.
 */
export function sync(neighbourhoodUrl: string): PerspectiveDiff {
    // Drain the buffer
    const events = _eventBuffer;
    _eventBuffer = [];

    if (events.length === 0) {
        return { additions: [], removals: [] };
    }

    // Deduplicate by event ID
    const uniqueEvents: SignedNostrEvent[] = [];
    for (const event of events) {
        if (!store.hasSeenEvent(event.id)) {
            store.markEventSeen(event.id);
            uniqueEvents.push(event);
        }
    }

    if (uniqueEvents.length === 0) {
        return { additions: [], removals: [] };
    }

    // Process events into links
    const diff = processInboundEvents(uniqueEvents, neighbourhoodUrl);

    // Store links and track peers
    for (const addition of diff.additions) {
        store.putLink(addition);

        // Track the event's pubkey as a peer
        const event = uniqueEvents.find(e =>
            e.created_at === Math.floor(new Date(addition.timestamp).getTime() / 1000)
        );
        if (event) {
            store.setPeer(event.pubkey, { lastSeen: event.created_at });
        }
    }

    // Handle removals: try to find and remove the corresponding links
    for (const removal of diff.removals) {
        // Deletion events reference event IDs — look up the link hash
        const target = removal.data.target;
        if (target.startsWith("nostr:note:")) {
            const eventId = target.replace("nostr:note:", "");
            const linkHash = store.getLinkHashByEventId(eventId);
            if (linkHash) {
                const existingLink = store.getLink(linkHash);
                if (existingLink) {
                    store.removeLink(existingLink);
                }
            }
        }
    }

    // Update revision to latest event timestamp
    const latestTimestamp = Math.max(...uniqueEvents.map(e => e.created_at));
    store.setRevision(latestTimestamp.toString());

    return diff;
}

/**
 * Process a single inbound signal from the executor.
 *
 * Returns: what happened (for logging/callbacks).
 */
export function handleInboundSignal(
    signal: unknown,
): { kind: "event"; event: SignedNostrEvent } | { kind: "ignored"; reason: string } {
    if (typeof signal !== "object" || signal === null) {
        return { kind: "ignored", reason: "not an object" };
    }

    const s = signal as Record<string, unknown>;

    if (s.type === "nostr:event" && s.event && typeof s.event === "object") {
        const event = s.event as SignedNostrEvent;
        bufferEvent(event);
        return { kind: "event", event };
    }

    return { kind: "ignored", reason: `unknown signal type: ${s.type}` };
}
