/**
 * Pure relay message builders per NIP-01.
 *
 * Zero runtime deps. Testable without network.
 *
 * Client → Relay messages:
 *   ["EVENT", <signed-event>]
 *   ["REQ", "<sub-id>", <filter>, ...]
 *   ["CLOSE", "<sub-id>"]
 *
 * Relay → Client messages:
 *   ["EVENT", "<sub-id>", <signed-event>]
 *   ["OK", "<event-id>", <accepted>, "<message>"]
 *   ["EOSE", "<sub-id>"]
 *   ["NOTICE", "<message>"]
 */

import type { SignedNostrEvent, NostrFilter } from "./nostr-event.pure.js";

// ---------------------------------------------------------------------------
// Client → Relay message builders
// ---------------------------------------------------------------------------

/**
 * Build an EVENT message for publishing a signed event to a relay.
 */
export function buildEventMessage(event: SignedNostrEvent): string {
    return JSON.stringify(["EVENT", event]);
}

/**
 * Build a REQ message for subscribing to events matching filters.
 */
export function buildReqMessage(subscriptionId: string, ...filters: NostrFilter[]): string {
    return JSON.stringify(["REQ", subscriptionId, ...filters]);
}

/**
 * Build a CLOSE message to unsubscribe from a subscription.
 */
export function buildCloseMessage(subscriptionId: string): string {
    return JSON.stringify(["CLOSE", subscriptionId]);
}

// ---------------------------------------------------------------------------
// Relay → Client message parsing
// ---------------------------------------------------------------------------

export type RelayMessage =
    | { type: "EVENT"; subscriptionId: string; event: SignedNostrEvent }
    | { type: "OK"; eventId: string; accepted: boolean; message: string }
    | { type: "EOSE"; subscriptionId: string }
    | { type: "NOTICE"; message: string }
    | { type: "UNKNOWN"; raw: unknown[] };

/**
 * Parse a relay message from a JSON string.
 */
export function parseRelayMessage(raw: string): RelayMessage | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!Array.isArray(parsed) || parsed.length < 2) return null;

    const type = parsed[0];

    switch (type) {
        case "EVENT": {
            if (parsed.length < 3) return null;
            return {
                type: "EVENT",
                subscriptionId: String(parsed[1]),
                event: parsed[2] as SignedNostrEvent,
            };
        }
        case "OK": {
            if (parsed.length < 4) return null;
            return {
                type: "OK",
                eventId: String(parsed[1]),
                accepted: Boolean(parsed[2]),
                message: String(parsed[3] ?? ""),
            };
        }
        case "EOSE": {
            return {
                type: "EOSE",
                subscriptionId: String(parsed[1]),
            };
        }
        case "NOTICE": {
            return {
                type: "NOTICE",
                message: String(parsed[1]),
            };
        }
        default:
            return { type: "UNKNOWN", raw: parsed as unknown[] };
    }
}

// ---------------------------------------------------------------------------
// Subscription filter builders
// ---------------------------------------------------------------------------

/**
 * Build a subscription filter for a Neighbourhood's triple events.
 */
export function buildNeighbourhoodFilter(
    neighbourhoodId: string,
    kinds: number[],
    since?: number,
): NostrFilter {
    const filter: NostrFilter = {
        kinds,
        "#ad4m:neighbourhood": [neighbourhoodId],
    };
    if (since !== undefined) {
        filter.since = since;
    }
    return filter;
}

/**
 * Generate a unique subscription ID.
 */
export function generateSubscriptionId(prefix: string = "ad4m"): string {
    const rand = Math.random().toString(36).substring(2, 10);
    const ts = Date.now().toString(36);
    return `${prefix}:${ts}:${rand}`;
}
