/**
 * Tests for telepresence: presence tracking, signal construction,
 * callback routing, and DID↔pubkey mapping.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Pure function tests
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
    filterStalePeers,
    getOnlineAgentsList,
    getNeighbourhoodFromEvent,
    classifyTelepresenceEvent,
} from "../src/telepresence.pure.js";
import type { OnlinePeer } from "../src/telepresence.pure.js";
import type { SignedNostrEvent } from "../src/nostr-event.pure.js";

// Impure module tests
import {
    initTelepresence,
    handleTelepresenceEvent,
    storePeerMapping,
    getPubkeyForDid,
    getDidForPubkey,
    setOnlineStatus,
    getOnlineAgents,
    sendSignal,
    sendBroadcast,
    registerSignalCallback,
    _resetForTesting,
    _getOnlinePeers,
    _getSignalCallbacks,
} from "../src/telepresence.js";

import { initStorage } from "../src/storage-interface.js";
import type { StorageAdapter } from "../src/storage-interface.js";

// ---------------------------------------------------------------------------
// In-memory storage for tests
// ---------------------------------------------------------------------------

class MemoryStorage implements StorageAdapter {
    private data = new Map<string, string>();

    get(key: string): string | null {
        return this.data.get(key) ?? null;
    }

    put(key: string, value: string): void {
        this.data.set(key, value);
    }

    delete(key: string): void {
        this.data.delete(key);
    }

    listKeys(prefix?: string): string[] {
        const keys: string[] = [];
        for (const key of this.data.keys()) {
            if (!prefix || key.startsWith(prefix)) {
                keys.push(key);
            }
        }
        return keys;
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEIGHBOURHOOD_ID = "test-neighbourhood-123";
const MY_DID = "did:key:z6MkMyAgent";
const MY_PUBKEY = "a".repeat(64);
const REMOTE_DID = "did:key:z6MkRemoteAgent";
const REMOTE_PUBKEY = "b".repeat(64);

/** Mock finalizeEvent that just fills in id/pubkey/sig fields. */
async function mockFinalizeEvent(event: any, pubkey: string): Promise<SignedNostrEvent> {
    return {
        ...event,
        id: "e".repeat(64),
        pubkey,
        sig: "f".repeat(128),
    };
}

/** Captures published events for assertions. */
const publishedEvents: Array<{ event: SignedNostrEvent; relays: string[] }> = [];
function mockPublishEvent(event: SignedNostrEvent, relayUrls: string[]): void {
    publishedEvents.push({ event, relays: relayUrls });
}

function makeSignedEvent(overrides: Partial<SignedNostrEvent>): SignedNostrEvent {
    return {
        id: "e".repeat(64),
        pubkey: REMOTE_PUBKEY,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_PRESENCE,
        tags: [["d", NEIGHBOURHOOD_ID]],
        content: "",
        sig: "f".repeat(128),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Pure: Event construction
// ---------------------------------------------------------------------------

describe("createPresenceEvent", () => {
    it("creates a kind 20042 event with correct structure", () => {
        const event = createPresenceEvent(NEIGHBOURHOOD_ID, MY_DID, { online: true }, 1714650000);

        assert.equal(event.kind, KIND_PRESENCE);
        assert.equal(event.created_at, 1714650000);

        // Check tags
        const dTag = event.tags.find(t => t[0] === "d");
        assert.ok(dTag);
        assert.equal(dTag![1], NEIGHBOURHOOD_ID);

        const tTag = event.tags.find(t => t[0] === "t");
        assert.ok(tTag);
        assert.equal(tTag![1], "ad4m-presence");

        // Check content
        const content = JSON.parse(event.content);
        assert.equal(content.did, MY_DID);
        assert.deepEqual(content.status, { online: true });
        assert.equal(content.timestamp, 1714650000 * 1000);
    });

    it("uses current time when now is not provided", () => {
        const before = Math.floor(Date.now() / 1000);
        const event = createPresenceEvent(NEIGHBOURHOOD_ID, MY_DID, "online");
        const after = Math.floor(Date.now() / 1000);

        assert.ok(event.created_at >= before);
        assert.ok(event.created_at <= after);
    });
});

describe("createSignalEvent", () => {
    it("creates a kind 20043 event with correct structure", () => {
        const payload = { type: "offer", sdp: "..." };
        const event = createSignalEvent(
            NEIGHBOURHOOD_ID, MY_DID, REMOTE_DID, REMOTE_PUBKEY, payload, 1714650000
        );

        assert.equal(event.kind, KIND_SIGNAL);
        assert.equal(event.created_at, 1714650000);

        // Check tags
        const dTag = event.tags.find(t => t[0] === "d");
        assert.equal(dTag![1], NEIGHBOURHOOD_ID);

        const pTag = event.tags.find(t => t[0] === "p");
        assert.ok(pTag);
        assert.equal(pTag![1], REMOTE_PUBKEY);

        const tTag = event.tags.find(t => t[0] === "t");
        assert.equal(tTag![1], "ad4m-signal");

        // Check content
        const content = JSON.parse(event.content);
        assert.equal(content.from, MY_DID);
        assert.equal(content.to, REMOTE_DID);
        assert.deepEqual(content.payload, payload);
    });
});

describe("createBroadcastEvent", () => {
    it("creates a kind 20044 event with correct structure", () => {
        const payload = { type: "sync-request" };
        const event = createBroadcastEvent(NEIGHBOURHOOD_ID, MY_DID, payload, 1714650000);

        assert.equal(event.kind, KIND_BROADCAST);
        assert.equal(event.created_at, 1714650000);

        const dTag = event.tags.find(t => t[0] === "d");
        assert.equal(dTag![1], NEIGHBOURHOOD_ID);

        const tTag = event.tags.find(t => t[0] === "t");
        assert.equal(tTag![1], "ad4m-broadcast");

        const content = JSON.parse(event.content);
        assert.equal(content.from, MY_DID);
        assert.deepEqual(content.payload, payload);
    });
});

// ---------------------------------------------------------------------------
// Pure: Content parsing
// ---------------------------------------------------------------------------

describe("parsePresenceContent", () => {
    it("parses valid presence content", () => {
        const content = JSON.stringify({ did: MY_DID, status: "online", timestamp: 1714650000000 });
        const parsed = parsePresenceContent(content);

        assert.ok(parsed);
        assert.equal(parsed!.did, MY_DID);
        assert.equal(parsed!.status, "online");
        assert.equal(parsed!.timestamp, 1714650000000);
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parsePresenceContent("not json"), null);
    });

    it("returns null for missing did", () => {
        assert.equal(parsePresenceContent(JSON.stringify({ status: "online", timestamp: 1 })), null);
    });

    it("returns null for missing status", () => {
        assert.equal(parsePresenceContent(JSON.stringify({ did: "x", timestamp: 1 })), null);
    });

    it("returns null for missing timestamp", () => {
        assert.equal(parsePresenceContent(JSON.stringify({ did: "x", status: "y" })), null);
    });
});

describe("parseSignalContent", () => {
    it("parses valid signal content", () => {
        const content = JSON.stringify({ from: MY_DID, to: REMOTE_DID, payload: { data: 1 } });
        const parsed = parseSignalContent(content);

        assert.ok(parsed);
        assert.equal(parsed!.from, MY_DID);
        assert.equal(parsed!.to, REMOTE_DID);
        assert.deepEqual(parsed!.payload, { data: 1 });
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseSignalContent("nope"), null);
    });

    it("returns null for missing from", () => {
        assert.equal(parseSignalContent(JSON.stringify({ to: "x", payload: {} })), null);
    });
});

describe("parseBroadcastContent", () => {
    it("parses valid broadcast content", () => {
        const content = JSON.stringify({ from: MY_DID, payload: { action: "ping" } });
        const parsed = parseBroadcastContent(content);

        assert.ok(parsed);
        assert.equal(parsed!.from, MY_DID);
        assert.deepEqual(parsed!.payload, { action: "ping" });
    });

    it("returns null for invalid content", () => {
        assert.equal(parseBroadcastContent("bad"), null);
    });
});

// ---------------------------------------------------------------------------
// Pure: TTL filtering
// ---------------------------------------------------------------------------

describe("filterStalePeers", () => {
    it("keeps fresh peers", () => {
        const now = Date.now();
        const peers = new Map<string, OnlinePeer>([
            ["did:1", { did: "did:1", status: "online", lastSeen: now - 5000 }],
            ["did:2", { did: "did:2", status: "online", lastSeen: now - 10000 }],
        ]);

        const fresh = filterStalePeers(peers, now);
        assert.equal(fresh.size, 2);
    });

    it("removes stale peers", () => {
        const now = Date.now();
        const peers = new Map<string, OnlinePeer>([
            ["did:fresh", { did: "did:fresh", status: "online", lastSeen: now - 5000 }],
            ["did:stale", { did: "did:stale", status: "online", lastSeen: now - 60000 }],
        ]);

        const fresh = filterStalePeers(peers, now);
        assert.equal(fresh.size, 1);
        assert.ok(fresh.has("did:fresh"));
        assert.ok(!fresh.has("did:stale"));
    });

    it("respects custom TTL", () => {
        const now = Date.now();
        const peers = new Map<string, OnlinePeer>([
            ["did:1", { did: "did:1", status: "online", lastSeen: now - 5000 }],
        ]);

        const fresh = filterStalePeers(peers, now, 3000);
        assert.equal(fresh.size, 0);
    });
});

describe("getOnlineAgentsList", () => {
    it("returns only fresh peers as list", () => {
        const now = Date.now();
        const peers = new Map<string, OnlinePeer>([
            ["did:1", { did: "did:1", status: "online", lastSeen: now - 1000 }],
            ["did:2", { did: "did:2", status: "away", lastSeen: now - 60000 }],
        ]);

        const list = getOnlineAgentsList(peers, now);
        assert.equal(list.length, 1);
        assert.equal(list[0].did, "did:1");
        assert.equal(list[0].status, "online");
    });
});

// ---------------------------------------------------------------------------
// Pure: Event classification
// ---------------------------------------------------------------------------

describe("getNeighbourhoodFromEvent", () => {
    it("extracts d tag value", () => {
        const event = makeSignedEvent({ tags: [["d", "my-hood"], ["t", "test"]] });
        assert.equal(getNeighbourhoodFromEvent(event), "my-hood");
    });

    it("returns null if no d tag", () => {
        const event = makeSignedEvent({ tags: [["t", "test"]] });
        assert.equal(getNeighbourhoodFromEvent(event), null);
    });
});

describe("classifyTelepresenceEvent", () => {
    it("classifies presence events", () => {
        const event = makeSignedEvent({ kind: KIND_PRESENCE });
        assert.equal(classifyTelepresenceEvent(event), "presence");
    });

    it("classifies signal events", () => {
        const event = makeSignedEvent({ kind: KIND_SIGNAL });
        assert.equal(classifyTelepresenceEvent(event), "signal");
    });

    it("classifies broadcast events", () => {
        const event = makeSignedEvent({ kind: KIND_BROADCAST });
        assert.equal(classifyTelepresenceEvent(event), "broadcast");
    });

    it("returns null for unknown kinds", () => {
        const event = makeSignedEvent({ kind: 1 });
        assert.equal(classifyTelepresenceEvent(event), null);
    });
});

// ---------------------------------------------------------------------------
// Impure: Telepresence module integration
// ---------------------------------------------------------------------------

describe("telepresence module", () => {
    beforeEach(() => {
        _resetForTesting();
        publishedEvents.length = 0;
        initStorage(new MemoryStorage());
        initTelepresence({
            myDid: MY_DID,
            pubkey: MY_PUBKEY,
            neighbourhoodId: NEIGHBOURHOOD_ID,
            writeRelays: ["wss://relay.test"],
            finalizeEvent: mockFinalizeEvent,
            publishEvent: mockPublishEvent,
        });
    });

    describe("DID ↔ pubkey mapping", () => {
        it("stores and retrieves DID → pubkey", () => {
            storePeerMapping(REMOTE_DID, REMOTE_PUBKEY);
            assert.equal(getPubkeyForDid(REMOTE_DID), REMOTE_PUBKEY);
        });

        it("stores and retrieves pubkey → DID", () => {
            storePeerMapping(REMOTE_DID, REMOTE_PUBKEY);
            assert.equal(getDidForPubkey(REMOTE_PUBKEY), REMOTE_DID);
        });

        it("returns null for unknown DID", () => {
            assert.equal(getPubkeyForDid("did:unknown"), null);
        });
    });

    describe("handleTelepresenceEvent — presence", () => {
        it("tracks presence from heartbeat events", () => {
            const content = JSON.stringify({
                did: REMOTE_DID,
                status: "online",
                timestamp: Date.now(),
            });
            const event = makeSignedEvent({
                kind: KIND_PRESENCE,
                content,
                pubkey: REMOTE_PUBKEY,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            const peers = _getOnlinePeers();
            assert.equal(peers.size, 1);
            assert.ok(peers.has(REMOTE_DID));
            assert.equal(peers.get(REMOTE_DID)!.status, "online");
        });

        it("stores DID → pubkey mapping from presence events", () => {
            const content = JSON.stringify({
                did: REMOTE_DID,
                status: "online",
                timestamp: Date.now(),
            });
            const event = makeSignedEvent({
                kind: KIND_PRESENCE,
                content,
                pubkey: REMOTE_PUBKEY,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(getPubkeyForDid(REMOTE_DID), REMOTE_PUBKEY);
            assert.equal(getDidForPubkey(REMOTE_PUBKEY), REMOTE_DID);
        });

        it("ignores events from wrong neighbourhood", () => {
            const content = JSON.stringify({
                did: REMOTE_DID,
                status: "online",
                timestamp: Date.now(),
            });
            const event = makeSignedEvent({
                kind: KIND_PRESENCE,
                content,
                tags: [["d", "wrong-neighbourhood"]],
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            const peers = _getOnlinePeers();
            assert.equal(peers.size, 0);
        });

        it("ignores events with invalid content", () => {
            const event = makeSignedEvent({
                kind: KIND_PRESENCE,
                content: "invalid json",
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            const peers = _getOnlinePeers();
            assert.equal(peers.size, 0);
        });
    });

    describe("handleTelepresenceEvent — signal", () => {
        it("invokes signal callback for signals addressed to us", () => {
            const received: Array<{ from: string; payload: unknown }> = [];
            _getSignalCallbacks().push((p) => received.push(p));

            const content = JSON.stringify({
                from: REMOTE_DID,
                to: MY_DID,
                payload: { type: "offer", sdp: "test" },
            });
            const event = makeSignedEvent({
                kind: KIND_SIGNAL,
                content,
                tags: [["d", NEIGHBOURHOOD_ID], ["p", MY_PUBKEY], ["t", "ad4m-signal"]],
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(received.length, 1);
            assert.equal(received[0].from, REMOTE_DID);
            assert.deepEqual(received[0].payload, { type: "offer", sdp: "test" });
        });

        it("ignores signals not addressed to us", () => {
            const received: unknown[] = [];
            _getSignalCallbacks().push((p) => received.push(p));

            const content = JSON.stringify({
                from: REMOTE_DID,
                to: "did:key:z6MkSomeoneElse",
                payload: { data: 1 },
            });
            const event = makeSignedEvent({
                kind: KIND_SIGNAL,
                content,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(received.length, 0);
        });

        it("stores DID → pubkey mapping from signal events", () => {
            _getSignalCallbacks().push(() => {}); // need callback to not crash

            const content = JSON.stringify({
                from: REMOTE_DID,
                to: MY_DID,
                payload: {},
            });
            const event = makeSignedEvent({
                kind: KIND_SIGNAL,
                content,
                pubkey: REMOTE_PUBKEY,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(getPubkeyForDid(REMOTE_DID), REMOTE_PUBKEY);
        });
    });

    describe("handleTelepresenceEvent — broadcast", () => {
        it("invokes signal callback for broadcasts from other agents", () => {
            const received: Array<{ from: string; payload: unknown }> = [];
            _getSignalCallbacks().push((p) => received.push(p));

            const content = JSON.stringify({
                from: REMOTE_DID,
                payload: { type: "sync-request" },
            });
            const event = makeSignedEvent({
                kind: KIND_BROADCAST,
                content,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(received.length, 1);
            assert.equal(received[0].from, REMOTE_DID);
            assert.deepEqual(received[0].payload, { type: "sync-request" });
        });

        it("does not echo our own broadcasts", () => {
            const received: unknown[] = [];
            _getSignalCallbacks().push((p) => received.push(p));

            const content = JSON.stringify({
                from: MY_DID,
                payload: { type: "sync-request" },
            });
            const event = makeSignedEvent({
                kind: KIND_BROADCAST,
                content,
                pubkey: MY_PUBKEY,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(received.length, 0);
        });
    });

    describe("multiple callbacks", () => {
        it("invokes all registered callbacks", () => {
            const received1: unknown[] = [];
            const received2: unknown[] = [];
            _getSignalCallbacks().push((p) => received1.push(p));
            _getSignalCallbacks().push((p) => received2.push(p));

            const content = JSON.stringify({
                from: REMOTE_DID,
                payload: { type: "ping" },
            });
            const event = makeSignedEvent({
                kind: KIND_BROADCAST,
                content,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(received1.length, 1);
            assert.equal(received2.length, 1);
        });

        it("continues to other callbacks if one throws", () => {
            const received: unknown[] = [];
            _getSignalCallbacks().push(() => { throw new Error("boom"); });
            _getSignalCallbacks().push((p) => received.push(p));

            const content = JSON.stringify({
                from: REMOTE_DID,
                payload: { type: "ping" },
            });
            const event = makeSignedEvent({
                kind: KIND_BROADCAST,
                content,
            });

            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(received.length, 1);
        });
    });

    // -----------------------------------------------------------------------
    // Outbound operations
    // -----------------------------------------------------------------------

    describe("setOnlineStatus", () => {
        it("publishes a presence heartbeat event", async () => {
            await setOnlineStatus({ online: true });

            assert.equal(publishedEvents.length, 1);
            const { event, relays } = publishedEvents[0];
            assert.equal(event.kind, KIND_PRESENCE);
            assert.deepEqual(relays, ["wss://relay.test"]);

            const content = JSON.parse(event.content);
            assert.equal(content.did, MY_DID);
            assert.deepEqual(content.status, { online: true });
        });

        it("updates own presence in the tracker", async () => {
            await setOnlineStatus("active");

            const peers = _getOnlinePeers();
            assert.ok(peers.has(MY_DID));
            assert.equal(peers.get(MY_DID)!.status, "active");
        });
    });

    describe("getOnlineAgents", () => {
        it("returns fresh peers only", async () => {
            // Add a fresh peer via presence event
            const content = JSON.stringify({
                did: REMOTE_DID,
                status: "online",
                timestamp: Date.now(),
            });
            const event = makeSignedEvent({
                kind: KIND_PRESENCE,
                content,
            });
            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            const agents = await getOnlineAgents();
            assert.equal(agents.length, 1);
            assert.equal(agents[0].did, REMOTE_DID);
        });

        it("excludes stale peers", async () => {
            // Manually add a stale peer
            _getOnlinePeers().set("did:stale", {
                did: "did:stale",
                status: "online",
                lastSeen: Date.now() - 60000,
            });

            const agents = await getOnlineAgents();
            assert.equal(agents.length, 0);
            // Also verify it was cleaned from the map
            assert.ok(!_getOnlinePeers().has("did:stale"));
        });
    });

    describe("sendSignal", () => {
        it("publishes a signal event when pubkey is known", async () => {
            storePeerMapping(REMOTE_DID, REMOTE_PUBKEY);

            const result = await sendSignal(REMOTE_DID, { type: "offer", sdp: "test" });
            assert.deepEqual(result, { success: true });

            assert.equal(publishedEvents.length, 1);
            const { event } = publishedEvents[0];
            assert.equal(event.kind, KIND_SIGNAL);

            const content = JSON.parse(event.content);
            assert.equal(content.from, MY_DID);
            assert.equal(content.to, REMOTE_DID);
            assert.deepEqual(content.payload, { type: "offer", sdp: "test" });

            // Check p tag
            const pTag = event.tags.find((t: string[]) => t[0] === "p");
            assert.ok(pTag);
            assert.equal(pTag![1], REMOTE_PUBKEY);
        });

        it("returns error when pubkey is unknown", async () => {
            const result = await sendSignal("did:unknown", { data: 1 });
            assert.deepEqual(result, { success: false, error: "recipient pubkey not known" });
            assert.equal(publishedEvents.length, 0);
        });
    });

    describe("sendBroadcast", () => {
        it("publishes a broadcast event", async () => {
            const result = await sendBroadcast({ type: "sync-request" });
            assert.deepEqual(result, { success: true });

            assert.equal(publishedEvents.length, 1);
            const { event } = publishedEvents[0];
            assert.equal(event.kind, KIND_BROADCAST);

            const content = JSON.parse(event.content);
            assert.equal(content.from, MY_DID);
            assert.deepEqual(content.payload, { type: "sync-request" });
        });
    });

    describe("registerSignalCallback", () => {
        it("registers a callback that receives signals", async () => {
            const received: unknown[] = [];
            await registerSignalCallback((p: any) => received.push(p));

            // Simulate incoming broadcast
            const content = JSON.stringify({
                from: REMOTE_DID,
                payload: { action: "test" },
            });
            const event = makeSignedEvent({
                kind: KIND_BROADCAST,
                content,
            });
            handleTelepresenceEvent(event, NEIGHBOURHOOD_ID);

            assert.equal(received.length, 1);
            assert.deepEqual((received[0] as any).payload, { action: "test" });
        });
    });
});
