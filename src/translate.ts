/**
 * Link ↔ Nostr event translation layer.
 *
 * Implements bidirectional mapping per Spec §6.
 * Uses injected interfaces — no ad4m:host imports.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { UnsignedNostrEvent, SignedNostrEvent } from "./nostr-event.pure.js";
import type { NostrSettings } from "./settings.js";
import type { DetectedPattern } from "./sdna.js";
import { detectPattern } from "./sdna.js";
import {
    linkToTripleEvent,
    linkToTextNote,
    linkRemovalToDeletionEvent,
    linkContentKey,
    isoToUnix,
    eventToLinks,
} from "./translate.pure.js";

// Re-export pure functions
export { linkContentKey, isoToUnix, eventToLinks } from "./translate.pure.js";
export { tripleEventToLink, textNoteToLink, reactionEventToLink, deletionEventToRemovals } from "./translate.pure.js";

// ---------------------------------------------------------------------------
// Outbound: PerspectiveDiff → Nostr Events
// ---------------------------------------------------------------------------

export interface DiffToEventsOptions {
    neighbourhoodId: string;
    pubkey: string;
    settings: NostrSettings;
    hashFn: (data: string) => string;
    /** Optional map of expression URIs → resolved content */
    resolvedContent?: Map<string, string>;
    /** Optional filter: skip links that should not be federated */
    shouldFederate?: (linkHash: string) => boolean;
    /** Optional map of link hash → original event ID (for deletions) */
    linkHashToEventId?: Map<string, string>;
}

export interface OutboundEvent {
    event: UnsignedNostrEvent;
    linkHash: string;
    /** The type of event: "triple", "social", or "deletion" */
    eventType: "triple" | "social" | "deletion";
}

/**
 * Convert a PerspectiveDiff to a set of unsigned Nostr events.
 *
 * Handles rendering strategy:
 * - "native": only kind 30078 triple events
 * - "social": only kind 1/7 social events
 * - "dual": both triple + social events
 */
export function diffToEvents(
    diff: PerspectiveDiff,
    opts: DiffToEventsOptions,
): OutboundEvent[] {
    const events: OutboundEvent[] = [];
    const chatPredicates = opts.settings.rendering.chatPredicates;
    const strategy = opts.settings.rendering.strategy;
    const now = Math.floor(Date.now() / 1000);

    for (const addition of diff.additions) {
        const linkHash = opts.hashFn(linkContentKey(addition));

        // Check federation filter
        if (opts.shouldFederate && !opts.shouldFederate(linkHash)) {
            continue;
        }

        // Always create triple event for "native" and "dual"
        if (strategy === "native" || strategy === "dual") {
            events.push({
                event: linkToTripleEvent(addition, opts.neighbourhoodId, linkHash),
                linkHash,
                eventType: "triple",
            });
        }

        // Create social events for "social" and "dual"
        if (strategy === "social" || strategy === "dual") {
            const pattern = detectPattern(addition, chatPredicates);
            const target = addition.data.target || "";
            const resolved = opts.resolvedContent?.get(target);

            if (pattern.type === "chat-message" || pattern.type === "reply") {
                const content = resolved || target;
                events.push({
                    event: linkToTextNote(
                        addition,
                        opts.neighbourhoodId,
                        content,
                    ),
                    linkHash,
                    eventType: "social",
                });
            } else if (pattern.type === "reaction" && pattern.contentUri) {
                // Reactions need a target event ID — skip if not available
                // (would need event ID mapping which is an executor concern)
            }
            // For unknown patterns in "social" mode, skip social event
        }
    }

    // Handle removals
    for (const removal of diff.removals) {
        const linkHash = opts.hashFn(linkContentKey(removal));

        if (opts.shouldFederate && !opts.shouldFederate(linkHash)) {
            continue;
        }

        const originalEventId = opts.linkHashToEventId?.get(linkHash);
        if (originalEventId) {
            events.push({
                event: linkRemovalToDeletionEvent([originalEventId], now),
                linkHash,
                eventType: "deletion",
            });
        }
    }

    return events;
}

/**
 * Process inbound signed events into links and a PerspectiveDiff.
 */
export function processInboundEvents(
    events: SignedNostrEvent[],
    neighbourhoodUrl: string,
): PerspectiveDiff {
    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];

    for (const event of events) {
        if (event.kind === 5) {
            // Deletion events produce removals
            const delLinks = eventToLinks(event, neighbourhoodUrl);
            removals.push(...delLinks);
        } else {
            const links = eventToLinks(event, neighbourhoodUrl);
            additions.push(...links);
        }
    }

    return { additions, removals };
}
