/**
 * Deno-native WebSocket relay transport implementation.
 *
 * Uses Deno's built-in WebSocket global to connect directly to Nostr
 * relays. No signal delegation to the executor — fully self-contained.
 *
 * Implements NIP-01 protocol:
 *   Client → Relay: ["EVENT", event], ["REQ", subId, ...filters], ["CLOSE", subId]
 *   Relay → Client: ["EVENT", subId, event], ["OK", eventId, ok, msg], ["EOSE", subId], ["NOTICE", msg]
 *
 * Features:
 * - Multiple relay support (connect to all relays in the list)
 * - Automatic reconnection with exponential backoff
 * - Subscription management across relays
 * - Event deduplication across relays
 *
 * Only imported by index.ts — never by core modules or tests.
 */

import type { SignedNostrEvent, NostrFilter } from "./nostr-event.pure.js";
import type {
    RelayTransport,
    RelayEventCallback,
    RelayEoseCallback,
    RelayStatusCallback,
    RelayOkCallback,
} from "./transport.js";
import {
    buildEventMessage,
    buildReqMessage,
    buildCloseMessage,
    parseRelayMessage,
} from "./relay.pure.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelayConnection {
    url: string;
    ws: WebSocket | null;
    connected: boolean;
    reconnectAttempts: number;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    /** Queued messages to send once connected */
    pendingMessages: string[];
}

interface Subscription {
    id: string;
    filters: NostrFilter[];
    onEvent: RelayEventCallback;
    onEose?: RelayEoseCallback;
    relayUrls?: string[];
    /** Track which relays have sent EOSE for this sub */
    eoseReceived: Set<string>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;
const RECONNECT_JITTER_MS = 500;

// ---------------------------------------------------------------------------
// DenoRelayTransport
// ---------------------------------------------------------------------------

export class DenoRelayTransport implements RelayTransport {
    private connections = new Map<string, RelayConnection>();
    private subscriptions = new Map<string, Subscription>();
    private statusCallbacks: RelayStatusCallback[] = [];
    private okCallbacks: RelayOkCallback[] = [];
    private seenEventIds = new Set<string>();
    private reconnectBaseMs: number;
    private reconnectMaxMs: number;
    private closed = false;

    constructor(opts?: { reconnectBaseMs?: number; reconnectMaxMs?: number }) {
        this.reconnectBaseMs = opts?.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
        this.reconnectMaxMs = opts?.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    connect(relayUrls: string[]): void {
        for (const url of relayUrls) {
            if (!this.connections.has(url)) {
                this.connectToRelay(url);
            }
        }
    }

    async publish(event: SignedNostrEvent, relayUrls?: string[]): Promise<void> {
        const msg = buildEventMessage(event);
        const targets = relayUrls
            ? [...this.connections.values()].filter(c => relayUrls.includes(c.url))
            : [...this.connections.values()];

        if (targets.length === 0) {
            console.warn("[relay-transport] publish: no connected relays");
            return;
        }

        for (const conn of targets) {
            this.sendToRelay(conn, msg);
        }
    }

    subscribe(
        subscriptionId: string,
        filters: NostrFilter[],
        onEvent: RelayEventCallback,
        onEose?: RelayEoseCallback,
        relayUrls?: string[],
    ): void {
        const sub: Subscription = {
            id: subscriptionId,
            filters,
            onEvent,
            onEose,
            relayUrls,
            eoseReceived: new Set(),
        };
        this.subscriptions.set(subscriptionId, sub);

        // Send REQ to all target relays
        const msg = buildReqMessage(subscriptionId, ...filters);
        const targets = this.getTargetConnections(relayUrls);

        for (const conn of targets) {
            this.sendToRelay(conn, msg);
        }
    }

    unsubscribe(subscriptionId: string, relayUrls?: string[]): void {
        const msg = buildCloseMessage(subscriptionId);
        const targets = this.getTargetConnections(relayUrls);

        for (const conn of targets) {
            this.sendToRelay(conn, msg);
        }

        this.subscriptions.delete(subscriptionId);
    }

    onStatus(callback: RelayStatusCallback): void {
        this.statusCallbacks.push(callback);
    }

    onOk(callback: RelayOkCallback): void {
        this.okCallbacks.push(callback);
    }

    close(): void {
        this.closed = true;
        for (const conn of this.connections.values()) {
            if (conn.reconnectTimer) {
                clearTimeout(conn.reconnectTimer);
                conn.reconnectTimer = null;
            }
            if (conn.ws) {
                try {
                    conn.ws.close(1000, "Language teardown");
                } catch {
                    // ignore close errors
                }
                conn.ws = null;
            }
            conn.connected = false;
        }
        this.connections.clear();
        this.subscriptions.clear();
        this.seenEventIds.clear();
    }

    connectedRelays(): string[] {
        return [...this.connections.values()]
            .filter(c => c.connected)
            .map(c => c.url);
    }

    // -----------------------------------------------------------------------
    // Private: connection management
    // -----------------------------------------------------------------------

    private connectToRelay(url: string): void {
        if (this.closed) return;

        const conn: RelayConnection = {
            url,
            ws: null,
            connected: false,
            reconnectAttempts: 0,
            reconnectTimer: null,
            pendingMessages: [],
        };
        this.connections.set(url, conn);

        this.openWebSocket(conn);
    }

    private openWebSocket(conn: RelayConnection): void {
        if (this.closed) return;

        try {
            console.log(`[relay-transport] connecting to ${conn.url}`);
            const ws = new WebSocket(conn.url);
            conn.ws = ws;

            ws.onopen = () => {
                console.log(`[relay-transport] connected to ${conn.url}`);
                conn.connected = true;
                conn.reconnectAttempts = 0;

                // Notify status callbacks
                for (const cb of this.statusCallbacks) {
                    try { cb(conn.url, "connected"); } catch { /* ignore */ }
                }

                // Send pending messages
                for (const msg of conn.pendingMessages) {
                    this.rawSend(conn, msg);
                }
                conn.pendingMessages = [];

                // Re-send all active subscriptions to this relay
                for (const sub of this.subscriptions.values()) {
                    if (!sub.relayUrls || sub.relayUrls.includes(conn.url)) {
                        const msg = buildReqMessage(sub.id, ...sub.filters);
                        this.rawSend(conn, msg);
                    }
                }
            };

            ws.onmessage = (event: MessageEvent) => {
                this.handleRelayMessage(conn.url, String(event.data));
            };

            ws.onclose = (event: CloseEvent) => {
                console.log(`[relay-transport] disconnected from ${conn.url} (code=${event.code})`);
                conn.connected = false;
                conn.ws = null;

                for (const cb of this.statusCallbacks) {
                    try { cb(conn.url, "disconnected", `code=${event.code}`); } catch { /* ignore */ }
                }

                // Schedule reconnect
                this.scheduleReconnect(conn);
            };

            ws.onerror = (event: Event) => {
                console.error(`[relay-transport] error on ${conn.url}:`, event);

                for (const cb of this.statusCallbacks) {
                    try { cb(conn.url, "error", "WebSocket error"); } catch { /* ignore */ }
                }
                // onclose will fire after onerror, so reconnect is handled there
            };
        } catch (err) {
            console.error(`[relay-transport] failed to connect to ${conn.url}:`, err);
            this.scheduleReconnect(conn);
        }
    }

    private scheduleReconnect(conn: RelayConnection): void {
        if (this.closed) return;
        if (conn.reconnectTimer) return; // Already scheduled

        const attempt = conn.reconnectAttempts;
        const delay = Math.min(
            this.reconnectBaseMs * Math.pow(2, attempt),
            this.reconnectMaxMs,
        ) + Math.random() * RECONNECT_JITTER_MS;

        console.log(`[relay-transport] reconnecting to ${conn.url} in ${Math.round(delay)}ms (attempt ${attempt + 1})`);

        conn.reconnectTimer = setTimeout(() => {
            conn.reconnectTimer = null;
            conn.reconnectAttempts++;
            this.openWebSocket(conn);
        }, delay);
    }

    // -----------------------------------------------------------------------
    // Private: message handling
    // -----------------------------------------------------------------------

    private handleRelayMessage(relayUrl: string, raw: string): void {
        const msg = parseRelayMessage(raw);
        if (!msg) {
            console.warn(`[relay-transport] unparseable message from ${relayUrl}:`, raw.substring(0, 200));
            return;
        }

        switch (msg.type) {
            case "EVENT": {
                // Deduplicate across relays
                if (this.seenEventIds.has(msg.event.id)) {
                    return;
                }
                this.seenEventIds.add(msg.event.id);

                // Cap the seen set to prevent memory leak
                if (this.seenEventIds.size > 10000) {
                    const iter = this.seenEventIds.values();
                    for (let i = 0; i < 2000; i++) {
                        const next = iter.next();
                        if (next.done) break;
                        this.seenEventIds.delete(next.value);
                    }
                }

                // Dispatch to matching subscription
                const sub = this.subscriptions.get(msg.subscriptionId);
                if (sub) {
                    try {
                        sub.onEvent(msg.event);
                    } catch (err) {
                        console.error(`[relay-transport] subscription callback error:`, err);
                    }
                }
                break;
            }

            case "OK": {
                for (const cb of this.okCallbacks) {
                    try { cb(msg.eventId, msg.accepted, msg.message); } catch { /* ignore */ }
                }
                if (!msg.accepted) {
                    console.warn(`[relay-transport] event ${msg.eventId} rejected by ${relayUrl}: ${msg.message}`);
                }
                break;
            }

            case "EOSE": {
                const sub = this.subscriptions.get(msg.subscriptionId);
                if (sub) {
                    sub.eoseReceived.add(relayUrl);
                    if (sub.onEose) {
                        try { sub.onEose(msg.subscriptionId); } catch { /* ignore */ }
                    }
                }
                break;
            }

            case "NOTICE": {
                console.log(`[relay-transport] NOTICE from ${relayUrl}: ${msg.message}`);
                break;
            }

            case "UNKNOWN": {
                // Silently ignore unknown message types (AUTH, etc.)
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Private: sending
    // -----------------------------------------------------------------------

    private sendToRelay(conn: RelayConnection, msg: string): void {
        if (conn.connected && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
            this.rawSend(conn, msg);
        } else {
            // Queue for when connection is established
            conn.pendingMessages.push(msg);
        }
    }

    private rawSend(conn: RelayConnection, msg: string): void {
        try {
            conn.ws?.send(msg);
        } catch (err) {
            console.error(`[relay-transport] send error on ${conn.url}:`, err);
            conn.pendingMessages.push(msg);
        }
    }

    private getTargetConnections(relayUrls?: string[]): RelayConnection[] {
        if (relayUrls) {
            return [...this.connections.values()].filter(c => relayUrls.includes(c.url));
        }
        return [...this.connections.values()];
    }
}

// ---------------------------------------------------------------------------
// DenoTransport — HTTP transport using native fetch
// ---------------------------------------------------------------------------

import type { Transport, TransportResponse } from "./transport.js";

/**
 * HTTP Transport implementation for the Deno runtime.
 * Uses Deno's native fetch instead of ad4m:host httpFetch.
 */
export class DenoTransport implements Transport {
    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        const response = await globalThis.fetch(url, {
            method,
            headers,
            body: method !== "GET" ? body : undefined,
        });

        const responseBody = await response.text();

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });

        return {
            status: response.status,
            headers: responseHeaders,
            body: responseBody,
        };
    }
}
