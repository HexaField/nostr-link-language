/**
 * Telepresence module — presence tracking, signal routing, DID↔pubkey mapping.
 *
 * Implements the TelepresenceCapability interface for the Nostr link language
 * using ephemeral Nostr events (NIP-16, kinds 20000-29999).
 *
 * Uses injected interfaces only — no ad4m:host imports.
 * Relay publishing and event signing are injected via initTelepresence()
 * to avoid pulling in crypto at import time.
 */

import type { UnsignedNostrEvent, SignedNostrEvent } from "./nostr-event.pure.js";
import { getStorage } from "./storage-interface.js";
import {
    KIND_PRESENCE,
    KIND_SIGNAL,
    KIND_BROADCAST,
    PRESENCE_TTL_MS,
    createPresenceEvent,
    createSignalEvent,
    createBroadcastEvent,
    parsePresenceContent,
    parseSignalContent,
    parseBroadcastContent,
    getNeighbourhoodFromEvent,
    classifyTelepresenceEvent,
    filterStalePeers,
    getOnlineAgentsList,
} from "./telepresence.pure.js";
import type { OnlinePeer } from "./telepresence.pure.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** In-memory presence tracker (transient — not persisted to KV). */
const onlinePeers = new Map<string, OnlinePeer>();

/** Registered signal callbacks. */
const signalCallbacks: Array<(payload: { from: string; payload: unknown }) => void> = [];

/** Telepresence configuration — set via initTelepresence(). */
let _config: TelepresenceConfig | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelepresenceConfig {
    myDid: string;
    pubkey: string;
    neighbourhoodId: string;
    writeRelays: string[];
    /** Sign and finalize an unsigned event. Injected to avoid import-time crypto dep. */
    finalizeEvent: (event: UnsignedNostrEvent, pubkey: string) => Promise<SignedNostrEvent>;
    /** Publish a signed event to relays. Injected to avoid import-time relay transport dep. */
    publishEvent: (event: SignedNostrEvent, relayUrls: string[]) => void;
}

// ---------------------------------------------------------------------------
// KV keys for DID ↔ pubkey mapping
// ---------------------------------------------------------------------------

function peerPubkeyKey(did: string): string {
    return `nostr:peer:${did}`;
}

function peerDidKey(pubkey: string): string {
    return `nostr:peer-did:${pubkey}`;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the telepresence module with configuration.
 * Must be called during language init().
 */
export function initTelepresence(config: TelepresenceConfig): void {
    _config = config;
    onlinePeers.clear();
    signalCallbacks.length = 0;
}

function getConfig(): TelepresenceConfig {
    if (!_config) {
        throw new Error(
            "Telepresence not initialized. Call initTelepresence() during language init().",
        );
    }
    return _config;
}

// ---------------------------------------------------------------------------
// DID ↔ Pubkey mapping
// ---------------------------------------------------------------------------

/**
 * Store a DID → pubkey mapping in KV.
 */
export function storePeerMapping(did: string, pubkey: string): void {
    const storage = getStorage();
    storage.put(peerPubkeyKey(did), pubkey);
    storage.put(peerDidKey(pubkey), did);
}

/**
 * Get the pubkey for a DID. Returns null if not known.
 */
export function getPubkeyForDid(did: string): string | null {
    return getStorage().get(peerPubkeyKey(did));
}

/**
 * Get the DID for a pubkey. Returns null if not known.
 */
export function getDidForPubkey(pubkey: string): string | null {
    return getStorage().get(peerDidKey(pubkey));
}

// ---------------------------------------------------------------------------
// Event handling (called from subscription)
// ---------------------------------------------------------------------------

/**
 * Handle an incoming telepresence event from the relay subscription.
 * Routes to presence tracker or signal callbacks.
 */
export function handleTelepresenceEvent(
    event: SignedNostrEvent,
    neighbourhoodId: string,
): void {
    // Verify event is scoped to our neighbourhood
    const eventNeighbourhood = getNeighbourhoodFromEvent(event);
    if (eventNeighbourhood !== neighbourhoodId) return;

    const kind = classifyTelepresenceEvent(event);
    if (!kind) return;

    switch (kind) {
        case "presence":
            handlePresenceEvent(event);
            break;
        case "signal":
            handleSignalEvent(event);
            break;
        case "broadcast":
            handleBroadcastEvent(event);
            break;
    }
}

/**
 * Handle a presence heartbeat event.
 */
function handlePresenceEvent(event: SignedNostrEvent): void {
    const content = parsePresenceContent(event.content);
    if (!content) return;

    // Store DID → pubkey mapping
    storePeerMapping(content.did, event.pubkey);

    // Update presence tracker
    onlinePeers.set(content.did, {
        did: content.did,
        status: content.status,
        lastSeen: Date.now(),
    });
}

/**
 * Handle a direct signal event.
 */
function handleSignalEvent(event: SignedNostrEvent): void {
    const config = getConfig();
    const content = parseSignalContent(event.content);
    if (!content) return;

    // Store DID → pubkey mapping from sender
    storePeerMapping(content.from, event.pubkey);

    // Only process signals addressed to us
    if (content.to !== config.myDid) return;

    // Invoke registered callbacks
    for (const callback of signalCallbacks) {
        try {
            callback({ from: content.from, payload: content.payload });
        } catch (err) {
            console.error("[telepresence] Signal callback error:", err);
        }
    }
}

/**
 * Handle a broadcast signal event.
 */
function handleBroadcastEvent(event: SignedNostrEvent): void {
    const config = getConfig();
    const content = parseBroadcastContent(event.content);
    if (!content) return;

    // Store DID → pubkey mapping from sender
    storePeerMapping(content.from, event.pubkey);

    // Don't echo our own broadcasts back to callbacks
    if (content.from === config.myDid) return;

    // Invoke registered callbacks
    for (const callback of signalCallbacks) {
        try {
            callback({ from: content.from, payload: content.payload });
        } catch (err) {
            console.error("[telepresence] Broadcast callback error:", err);
        }
    }
}

// ---------------------------------------------------------------------------
// TelepresenceCapability implementation
// ---------------------------------------------------------------------------

/**
 * Publish a presence heartbeat to all write relays.
 */
export async function setOnlineStatus(status: unknown): Promise<void> {
    const config = getConfig();

    const unsigned = createPresenceEvent(
        config.neighbourhoodId,
        config.myDid,
        status,
    );

    const signed = await config.finalizeEvent(unsigned, config.pubkey);
    config.publishEvent(signed, config.writeRelays);

    // Update our own presence in the tracker
    onlinePeers.set(config.myDid, {
        did: config.myDid,
        status,
        lastSeen: Date.now(),
    });
}

/**
 * Get all agents who sent a heartbeat within the TTL window.
 */
export async function getOnlineAgents(): Promise<OnlinePeer[]> {
    // Clean stale entries on each call
    const now = Date.now();
    const fresh = filterStalePeers(onlinePeers, now, PRESENCE_TTL_MS);

    // Replace the map with fresh entries
    onlinePeers.clear();
    for (const [did, peer] of fresh) {
        onlinePeers.set(did, peer);
    }

    return getOnlineAgentsList(onlinePeers, now, PRESENCE_TTL_MS);
}

/**
 * Send a signal to a specific peer by DID.
 */
export async function sendSignal(
    remoteDid: string,
    payload: unknown,
): Promise<object> {
    const config = getConfig();

    // Look up the recipient's pubkey
    const recipientPubkey = getPubkeyForDid(remoteDid);
    if (!recipientPubkey) {
        console.warn(
            `[telepresence] Cannot send signal to ${remoteDid}: pubkey not known. ` +
            `The peer may not have sent a heartbeat yet.`,
        );
        return { success: false, error: "recipient pubkey not known" };
    }

    const unsigned = createSignalEvent(
        config.neighbourhoodId,
        config.myDid,
        remoteDid,
        recipientPubkey,
        payload,
    );

    const signed = await config.finalizeEvent(unsigned, config.pubkey);
    config.publishEvent(signed, config.writeRelays);

    return { success: true };
}

/**
 * Send a broadcast signal to all neighbourhood peers.
 */
export async function sendBroadcast(payload: unknown): Promise<object> {
    const config = getConfig();

    const unsigned = createBroadcastEvent(
        config.neighbourhoodId,
        config.myDid,
        payload,
    );

    const signed = await config.finalizeEvent(unsigned, config.pubkey);
    config.publishEvent(signed, config.writeRelays);

    return { success: true };
}

/**
 * Register a callback for incoming signals and broadcasts.
 */
export async function registerSignalCallback(
    callback: (payload: { from: string; payload: unknown }) => void,
): Promise<void> {
    signalCallbacks.push(callback);
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/**
 * Reset module state. For testing only.
 */
export function _resetForTesting(): void {
    onlinePeers.clear();
    signalCallbacks.length = 0;
    _config = null;
}

/**
 * Get the current online peers map. For testing only.
 */
export function _getOnlinePeers(): Map<string, OnlinePeer> {
    return onlinePeers;
}

/**
 * Get registered signal callbacks. For testing only.
 */
export function _getSignalCallbacks(): Array<(payload: { from: string; payload: unknown }) => void> {
    return signalCallbacks;
}
