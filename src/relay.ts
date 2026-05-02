/**
 * Relay communication via signal-based delegation.
 *
 * Since httpFetch can't do WebSocket, relay communication uses signals:
 * - Outbound: emit signal { type: "nostr:publish", event, relays }
 * - Inbound: executor sends signals { type: "nostr:event", event }
 * - Subscription: emit signal { type: "nostr:subscribe", filter, relays }
 *
 * Uses injected runtime interface — no ad4m:host imports.
 */

import type { SignedNostrEvent, NostrFilter } from "./nostr-event.pure.js";
import { getRuntime } from "./runtime-interface.js";
import { buildNeighbourhoodFilter, generateSubscriptionId } from "./relay.pure.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _subscriptionId: string | null = null;

// ---------------------------------------------------------------------------
// Outbound: publish events to relays
// ---------------------------------------------------------------------------

/**
 * Publish a signed event to all write relays via signal delegation.
 *
 * The executor receives this signal, connects to the relays via WebSocket,
 * and publishes the event.
 */
export function publishEvent(
    event: SignedNostrEvent,
    relayUrls: string[],
): void {
    getRuntime().emitSignal(JSON.stringify({
        type: "nostr:publish",
        event,
        relays: relayUrls,
    }));
}

/**
 * Publish multiple events to all write relays.
 */
export function publishEvents(
    events: SignedNostrEvent[],
    relayUrls: string[],
): void {
    for (const event of events) {
        publishEvent(event, relayUrls);
    }
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

/**
 * Request the executor to subscribe to events matching a filter on read relays.
 *
 * The executor will:
 * 1. Connect to the relays via WebSocket
 * 2. Send REQ with the subscription filter
 * 3. Forward matching events back as signals
 */
export function subscribe(
    neighbourhoodId: string,
    kinds: number[],
    relayUrls: string[],
    since?: number,
): string {
    const subscriptionId = generateSubscriptionId();
    const filter = buildNeighbourhoodFilter(neighbourhoodId, kinds, since);

    getRuntime().emitSignal(JSON.stringify({
        type: "nostr:subscribe",
        subscriptionId,
        filter,
        relays: relayUrls,
    }));

    _subscriptionId = subscriptionId;
    return subscriptionId;
}

/**
 * Request the executor to close a subscription.
 */
export function unsubscribe(subscriptionId: string, relayUrls: string[]): void {
    getRuntime().emitSignal(JSON.stringify({
        type: "nostr:unsubscribe",
        subscriptionId,
        relays: relayUrls,
    }));

    if (_subscriptionId === subscriptionId) {
        _subscriptionId = null;
    }
}

/**
 * Get the current active subscription ID.
 */
export function getActiveSubscriptionId(): string | null {
    return _subscriptionId;
}

// ---------------------------------------------------------------------------
// Subscription filter retrieval
// ---------------------------------------------------------------------------

/**
 * Build the subscription filter for the current Neighbourhood.
 * Stored in settings so the executor knows what to subscribe to.
 */
export function getSubscriptionFilter(
    neighbourhoodId: string,
    kinds: number[],
    since?: number,
): NostrFilter {
    return buildNeighbourhoodFilter(neighbourhoodId, kinds, since);
}
