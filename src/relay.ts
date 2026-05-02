/**
 * Relay communication via native WebSocket transport.
 *
 * Uses the RelayTransport interface for direct WebSocket connections
 * to Nostr relays. No signal delegation — fully self-contained.
 *
 * Uses injected relay transport interface — no ad4m:host imports.
 */

import type { SignedNostrEvent, NostrFilter } from "./nostr-event.pure.js";
import { getRelayTransport } from "./transport.js";
import { buildNeighbourhoodFilter, generateSubscriptionId } from "./relay.pure.js";
import type { RelayEventCallback, RelayEoseCallback } from "./transport.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _subscriptionId: string | null = null;
let _eventCallback: RelayEventCallback | null = null;

// ---------------------------------------------------------------------------
// Outbound: publish events to relays
// ---------------------------------------------------------------------------

/**
 * Publish a signed event to all write relays via native WebSocket.
 */
export function publishEvent(
    event: SignedNostrEvent,
    relayUrls: string[],
): void {
    getRelayTransport().publish(event, relayUrls).catch(err => {
        console.error("[relay] publish error:", err);
    });
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
// Connection management
// ---------------------------------------------------------------------------

/**
 * Connect to relay URLs. Must be called before subscribe/publish.
 */
export function connectRelays(relayUrls: string[]): void {
    getRelayTransport().connect(relayUrls);
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

/**
 * Subscribe to events matching a filter on read relays.
 * Events are delivered directly to the provided callback.
 */
export function subscribe(
    neighbourhoodId: string,
    kinds: number[],
    relayUrls: string[],
    since?: number,
    onEvent?: RelayEventCallback,
    onEose?: RelayEoseCallback,
): string {
    const subscriptionId = generateSubscriptionId();
    const filter = buildNeighbourhoodFilter(neighbourhoodId, kinds, since);

    // Store the event callback for re-subscription
    if (onEvent) {
        _eventCallback = onEvent;
    }

    getRelayTransport().subscribe(
        subscriptionId,
        [filter],
        onEvent || _eventCallback || (() => {}),
        onEose,
        relayUrls,
    );

    _subscriptionId = subscriptionId;
    return subscriptionId;
}

/**
 * Close a subscription on all relays.
 */
export function unsubscribe(subscriptionId: string, relayUrls: string[]): void {
    getRelayTransport().unsubscribe(subscriptionId, relayUrls);

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
 */
export function getSubscriptionFilter(
    neighbourhoodId: string,
    kinds: number[],
    since?: number,
): NostrFilter {
    return buildNeighbourhoodFilter(neighbourhoodId, kinds, since);
}
