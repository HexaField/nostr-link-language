/**
 * # Nostr Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via the Nostr relay network.
 * Implements perspective-commit, perspective-sync, perspective-query,
 * peers, and telepresence capabilities.
 *
 * **Self-contained**: Uses Deno-native WebSocket to connect directly to
 * Nostr relays. No executor extensions or signal-based delegation needed.
 *
 * Publishes links as Nostr events (kind 30078 for triples, kind 1 for
 * social text notes), processes inbound events from relay subscriptions,
 * and handles multi-relay deduplication.
 *
 * LIMITATION: Events are published without Schnorr signatures because
 * secp256k1 is not available in the Deno runtime. Permissive relays
 * (nostr-rs-relay in dev mode) accept unsigned events. Production use
 * requires bundling a secp256k1 WASM module.
 *
 * Spec: nostr-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { NostrSettings } from "./src/settings.js";
import { diffToEvents, linkContentKey } from "./src/translate.js";
import { shouldFederate, linkOriginKey, isPredicateExcluded } from "./src/dual-language.js";
import * as store from "./src/store.js";
import { publishEvents, connectRelays } from "./src/relay.js";
import { subscribe, unsubscribe, getActiveSubscriptionId } from "./src/relay.js";
import { sync as doSync, bufferEvent, clearBuffer } from "./src/sync.js";
import { finalizeEvent } from "./src/nostr-event.js";

// Adapter imports
import { initTransport, initRelayTransport } from "./src/transport.js";
import { DenoTransport, DenoRelayTransport } from "./src/transport-deno.js";
import { initStorage, getStorage } from "./src/storage-interface.js";
import { DenoStorageAdapter } from "./src/storage-deno.js";
import { initSigning } from "./src/signing-interface.js";
import { DenoSigningAdapter } from "./src/signing-deno.js";
import { initRuntime } from "./src/runtime-interface.js";
import { DenoRuntime } from "./src/runtime-deno.js";

import type { SignedNostrEvent } from "./src/nostr-event.pure.js";
import { initCryptoSigning, getPublicKey, canSign } from "./src/crypto.js";

// Telepresence imports
import { TELEPRESENCE_KINDS } from "./src/telepresence.pure.js";
import {
    initTelepresence,
    handleTelepresenceEvent,
    setOnlineStatus,
    getOnlineAgents,
    sendSignal,
    sendBroadcast,
    registerSignalCallback,
} from "./src/telepresence.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §9)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const NOSTR_RELAY_URLS = "<to-be-filled>";

//!@ad4m-template-variable
const NOSTR_NEIGHBOURHOOD_ID = "<to-be-filled>";

//!@ad4m-template-variable
const NOSTR_PUBKEY = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

//!@ad4m-template-variable
const NOSTR_PRIVKEY = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: NostrSettings;
let relayUrls: string[] = [];
let pubkey: string = "";
let configured: boolean = false;

/**
 * Check whether a template variable has been filled in.
 * Returns false for the placeholder sentinel, empty strings, or whitespace.
 */
function isTemplateVarFilled(value: string): boolean {
    if (!value) return false;
    const trimmed = value.trim();
    return trimmed !== "" && trimmed !== "<to-be-filled>";
}

/**
 * Parse relay URLs from the template variable.
 * Returns an empty array if the value is still the placeholder.
 */
function parseRelayUrls(): string[] {
    if (!isTemplateVarFilled(NOSTR_RELAY_URLS)) return [];
    try {
        const parsed = JSON.parse(NOSTR_RELAY_URLS);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore */ }
    return [];
}

/**
 * Get all read relay URLs (template + settings).
 */
function readRelays(): string[] {
    return [...new Set([...relayUrls, ...settings.relays.read])];
}

/**
 * Get all write relay URLs (template + settings).
 */
function writeRelays(): string[] {
    return [...new Set([...relayUrls, ...settings.relays.write])];
}

/**
 * Get the neighbourhood URL.
 */
function neighbourhoodUrl(): string {
    return `neighbourhood://${NOSTR_NEIGHBOURHOOD_ID}`;
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/nostr-link-language",
    version: "0.2.0",

    isPublic: true,

    async init() {
        // Initialize adapters
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());

        // Initialize the native WebSocket relay transport
        const relayTransport = new DenoRelayTransport({
            reconnectBaseMs: 1000,
            reconnectMaxMs: 30000,
        });
        initRelayTransport(relayTransport);

        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());
        relayUrls = parseRelayUrls();
        pubkey = NOSTR_PUBKEY || "";

        // Check whether critical template variables have been filled in
        const hasNeighbourhood = isTemplateVarFilled(NOSTR_NEIGHBOURHOOD_ID);
        const hasRelays = relayUrls.length > 0;
        const hasPubkey = isTemplateVarFilled(NOSTR_PUBKEY);

        if (!hasNeighbourhood || !hasRelays || !hasPubkey) {
            console.warn(
                `[nostr-link-language] init: template variables not configured ` +
                `(neighbourhood=${hasNeighbourhood}, relays=${hasRelays}, pubkey=${hasPubkey}). ` +
                `Language will remain inactive until properly configured.`,
            );
            configured = false;
            return;
        }

        configured = true;

        console.log(`[nostr-link-language] init: did=${myDid}, neighbourhood=${NOSTR_NEIGHBOURHOOD_ID}`);
        console.log(`[nostr-link-language] relays: ${relayUrls.join(", ")}`);
        console.log(`[nostr-link-language] sync mode: ${settings.syncMode}`);
        // Initialize Schnorr signing if private key is provided
        const privkey = isTemplateVarFilled(NOSTR_PRIVKEY) ? NOSTR_PRIVKEY : null;
        initCryptoSigning(privkey);

        // If we have a private key, derive and verify pubkey
        if (canSign()) {
            const derivedPubkey = getPublicKey();
            if (derivedPubkey && derivedPubkey !== pubkey) {
                console.warn(
                    `[nostr-link-language] WARNING: Derived pubkey ${derivedPubkey} ` +
                    `does not match template pubkey ${pubkey}. Using derived pubkey.`
                );
                pubkey = derivedPubkey;
            } else if (derivedPubkey) {
                console.log(`[nostr-link-language] pubkey verified: ${pubkey}`);
            }
        } else {
            console.log(`[nostr-link-language] pubkey: ${pubkey} (signing disabled — no private key)`);
        }
        console.log(`[nostr-link-language] transport: native WebSocket (self-contained)`);
        console.log(`[nostr-link-language] signing: ${canSign() ? 'Schnorr (secp256k1)' : 'DISABLED (events will be unsigned)'}`);


        // Connect to all relays via native WebSocket
        const allRelays = [...new Set([...readRelays(), ...writeRelays()])];
        connectRelays(allRelays);

        // Register relay status logging
        relayTransport.onStatus((url, status, message) => {
            console.log(`[nostr-link-language] relay ${url}: ${status}${message ? ` (${message})` : ""}`);
        });

        // Initialize telepresence
        initTelepresence({
            myDid,
            pubkey,
            neighbourhoodId: NOSTR_NEIGHBOURHOOD_ID,
            writeRelays: writeRelays(),
            finalizeEvent,
            publishEvent,
        });
        console.log(`[nostr-link-language] telepresence: enabled`);

        // Subscribe to events if not in publish-only mode
        if (settings.syncMode !== "publish-only") {
            const lastRevision = store.getRevision();
            const since = lastRevision ? parseInt(lastRevision, 10) : undefined;

            // Events from relay subscriptions are buffered directly
            subscribe(
                NOSTR_NEIGHBOURHOOD_ID,
                settings.filter.kinds,
                readRelays(),
                since,
                (event: SignedNostrEvent) => {
                    // Buffer event for processing during sync()
                    bufferEvent(event);
                },
                (subId: string) => {
                    console.log(`[nostr-link-language] EOSE received for subscription ${subId}`);
                },
            );
        }

        // Subscribe to telepresence ephemeral events (separate subscription)
        subscribe(
            NOSTR_NEIGHBOURHOOD_ID,
            [...TELEPRESENCE_KINDS],
            readRelays(),
            undefined, // no since — ephemeral events aren't stored
            (event: SignedNostrEvent) => {
                handleTelepresenceEvent(event, NOSTR_NEIGHBOURHOOD_ID);
            },
        );
    },

    async teardown() {
        const subId = getActiveSubscriptionId();
        if (subId) {
            unsubscribe(subId, readRelays());
        }

        // Close all relay connections
        try {
            const { getRelayTransport } = await import("./src/transport.js");
            const transport = getRelayTransport();
            transport.close();
        } catch {
            // Transport may not be initialized
        }

        myDid = "";
        console.log("[nostr-link-language] teardown: all relay connections closed");
    },

    interactions() {
        return [];
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // If not configured, skip all relay interaction
            if (!configured) {
                return "";
            }

            // 1. Store links locally
            store.applyDiff(diff);

            // 2. Skip outbound delivery in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return "";
            }

            // 3. Build federation filter using dual-language origin tracking
            const federationFilter = (linkHash: string): boolean => {
                if (settings.dualLanguage.enabled) {
                    return shouldFederate(linkHash, (key) => getStorage().get(key));
                }
                return true;
            };

            // 4. Track origins for new native commits
            if (settings.dualLanguage.enabled) {
                for (const link of diff.additions) {
                    const h = store.hashLink(link);
                    const originKey = linkOriginKey(h);
                    const storage = getStorage();
                    const existing = storage.get(originKey);
                    if (existing === "nostr") {
                        storage.put(originKey, "dual");
                    } else if (!existing) {
                        storage.put(originKey, "native");
                    }
                }
            }

            // 5. Check predicate exclusions
            const shouldPublish = (linkHash: string, link?: LinkExpression): boolean => {
                if (!federationFilter(linkHash)) return false;
                if (link && settings.dualLanguage.enabled) {
                    const pred = link.data.predicate || "";
                    if (isPredicateExcluded(pred, settings.dualLanguage.excludePredicates)) {
                        return false;
                    }
                }
                return true;
            };

            // 6. Translate to Nostr events
            const events = diffToEvents(diff, {
                neighbourhoodId: NOSTR_NEIGHBOURHOOD_ID,
                pubkey,
                settings,
                hashFn: hash,
                shouldFederate: shouldPublish,
            });

            // 7. Finalize events (compute ID) and publish via native WebSocket
            if (events.length > 0) {
                const signedEvents: SignedNostrEvent[] = [];
                for (const e of events) {
                    const signed = await finalizeEvent(e.event, pubkey);
                    signedEvents.push(signed);

                    // Track event ID → link hash mapping
                    store.setEventId(e.linkHash, signed.id);
                }

                publishEvents(signedEvents, writeRelays());
            }

            // 8. Emit the perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            return "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            if (!configured || settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }
            return doSync(neighbourhoodUrl());
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            return store.getRevision() || "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },

    // -----------------------------------------------------------------------
    // telepresence
    // -----------------------------------------------------------------------
    telepresence: {
        async setOnlineStatus(status: unknown) {
            if (!configured) return;
            await setOnlineStatus(status);
        },

        async getOnlineAgents() {
            if (!configured) return [];
            return getOnlineAgents();
        },

        async sendSignal(remoteDid: string, payload: unknown) {
            if (!configured) return { success: false, error: "not configured" };
            return sendSignal(remoteDid, payload);
        },

        async sendBroadcast(payload: unknown) {
            if (!configured) return { success: false, error: "not configured" };
            return sendBroadcast(payload);
        },

        async registerSignalCallback(callback: any) {
            await registerSignalCallback(callback);
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports (required by the AD4M runtime dispatcher)
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
    telepresenceSetOnlineStatus,
    telepresenceGetOnlineAgents,
    telepresenceSendSignal,
    telepresenceSendBroadcast,
    telepresenceRegisterSignalCallback,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal handler (legacy compatibility)
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * LEGACY: With native WebSocket transport, events arrive directly via
 * the relay transport's subscription callback. This handler is kept
 * for backward compatibility with executors that still forward events
 * as signals.
 */
export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return;
    }

    const { handleInboundSignal } = await import("./src/sync.js");
    const result = handleInboundSignal(signal);

    if (result.kind === "ignored") {
        console.log(`[nostr-link-language] signal ignored: ${result.reason}`);
    }
}
