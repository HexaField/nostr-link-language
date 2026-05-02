/**
 * Transport abstraction layer — interfaces and singleton only.
 *
 * Provides two transport types:
 * 1. HTTP transport (fetch-based, for REST APIs)
 * 2. Relay transport (WebSocket-based, for Nostr relay communication)
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in transport-deno.ts.
 */

import type { SignedNostrEvent, NostrFilter } from "./nostr-event.pure.js";

// ---------------------------------------------------------------------------
// HTTP Transport Interfaces (unchanged)
// ---------------------------------------------------------------------------

export interface TransportResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface Transport {
    fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse>;
}

// ---------------------------------------------------------------------------
// WasmTransport — future WASM runtime via http-ext.fetch
// ---------------------------------------------------------------------------

export class WasmTransport implements Transport {
    async fetch(
        _url: string,
        _method: string,
        _headers: Record<string, string>,
        _body: string,
    ): Promise<TransportResponse> {
        throw new Error(
            "WasmTransport: http-ext is not available in the current runtime. " +
            "The executor must provide the http-ext WIT import for WASM Languages " +
            "to make outbound HTTP requests.",
        );
    }
}

// ---------------------------------------------------------------------------
// Relay Transport Interface (WebSocket-based Nostr relay communication)
// ---------------------------------------------------------------------------

/**
 * Callback for receiving events from relay subscriptions.
 */
export type RelayEventCallback = (event: SignedNostrEvent) => void;

/**
 * Callback for EOSE (end of stored events) notifications.
 */
export type RelayEoseCallback = (subscriptionId: string) => void;

/**
 * Callback for relay connection status changes.
 */
export type RelayStatusCallback = (relayUrl: string, status: "connected" | "disconnected" | "error", message?: string) => void;

/**
 * Callback for OK responses from relay after publishing.
 */
export type RelayOkCallback = (eventId: string, accepted: boolean, message: string) => void;

/**
 * Transport interface for Nostr relay WebSocket communication.
 *
 * Handles connecting to multiple relays, publishing events,
 * subscribing to event streams, and reconnection.
 */
export interface RelayTransport {
    /**
     * Connect to one or more relay URLs.
     * Initiates WebSocket connections with automatic reconnection.
     */
    connect(relayUrls: string[]): void;

    /**
     * Publish a signed event to all connected write relays.
     * Returns a promise that resolves when at least one relay accepts.
     */
    publish(event: SignedNostrEvent, relayUrls?: string[]): Promise<void>;

    /**
     * Subscribe to events matching a filter on read relays.
     * Returns a subscription ID that can be used to unsubscribe.
     */
    subscribe(
        subscriptionId: string,
        filters: NostrFilter[],
        onEvent: RelayEventCallback,
        onEose?: RelayEoseCallback,
        relayUrls?: string[],
    ): void;

    /**
     * Close a subscription on all relays.
     */
    unsubscribe(subscriptionId: string, relayUrls?: string[]): void;

    /**
     * Register a callback for relay status changes.
     */
    onStatus(callback: RelayStatusCallback): void;

    /**
     * Register a callback for OK responses from relays.
     */
    onOk(callback: RelayOkCallback): void;

    /**
     * Close all connections and clean up.
     */
    close(): void;

    /**
     * Get currently connected relay URLs.
     */
    connectedRelays(): string[];
}

// ---------------------------------------------------------------------------
// HTTP Transport singleton
// ---------------------------------------------------------------------------

let _transport: Transport | null = null;

export function initTransport(transport: Transport): void {
    _transport = transport;
}

export function getTransport(): Transport {
    if (!_transport) {
        throw new Error(
            "Transport not initialized. Call initTransport() during language init().",
        );
    }
    return _transport;
}

// ---------------------------------------------------------------------------
// Relay Transport singleton
// ---------------------------------------------------------------------------

let _relayTransport: RelayTransport | null = null;

export function initRelayTransport(transport: RelayTransport): void {
    _relayTransport = transport;
}

export function getRelayTransport(): RelayTransport {
    if (!_relayTransport) {
        throw new Error(
            "RelayTransport not initialized. Call initRelayTransport() during language init().",
        );
    }
    return _relayTransport;
}
