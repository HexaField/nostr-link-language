/**
 * # Nostr Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via the Nostr relay network.
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Publishes links as Nostr events (kind 30078 for triples, kind 1 for
 * social text notes), processes inbound events from relay subscriptions,
 * and handles multi-relay deduplication.
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
import { publishEvents } from "./src/relay.js";
import { subscribe, unsubscribe, getActiveSubscriptionId } from "./src/relay.js";
import { sync as doSync, handleInboundSignal, clearBuffer } from "./src/sync.js";

// Adapter imports
import { initTransport } from "./src/transport.js";
import { DenoTransport } from "./src/transport-deno.js";
import { initStorage, getStorage } from "./src/storage-interface.js";
import { DenoStorageAdapter } from "./src/storage-deno.js";
import { initSigning } from "./src/signing-interface.js";
import { DenoSigningAdapter } from "./src/signing-deno.js";
import { initRuntime } from "./src/runtime-interface.js";
import { DenoRuntime } from "./src/runtime-deno.js";

import type { SignedNostrEvent } from "./src/nostr-event.pure.js";

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
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
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
        console.log(`[nostr-link-language] pubkey: ${pubkey}`);

        // Subscribe to events if not in publish-only mode
        if (settings.syncMode !== "publish-only") {
            const lastRevision = store.getRevision();
            const since = lastRevision ? parseInt(lastRevision, 10) : undefined;
            subscribe(
                NOSTR_NEIGHBOURHOOD_ID,
                settings.filter.kinds,
                readRelays(),
                since,
            );
        }
    },

    async teardown() {
        const subId = getActiveSubscriptionId();
        if (subId) {
            unsubscribe(subId, readRelays());
        }
        myDid = "";
        console.log("[nostr-link-language] teardown");
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

            // 7. Publish to write relays via signal delegation
            if (events.length > 0) {
                const signedEvents = events.map(e => ({
                    id: "", // Filled by executor after signing
                    pubkey,
                    created_at: e.event.created_at,
                    kind: e.event.kind,
                    tags: e.event.tags,
                    content: e.event.content,
                    sig: "", // Filled by executor after signing
                } as SignedNostrEvent));

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
// Signal handler
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * The executor forwards inbound Nostr events as signals:
 * { type: "nostr:event", event: <SignedNostrEvent> }
 */
export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return;
    }

    const result = handleInboundSignal(signal);

    if (result.kind === "ignored") {
        console.log(`[nostr-link-language] signal ignored: ${result.reason}`);
    }
}
