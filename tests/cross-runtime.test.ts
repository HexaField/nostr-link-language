/**
 * Cross-runtime test harness.
 *
 * Exercises the full production modules using mock adapters that
 * simulate an alternative runtime. Proves that the core logic has
 * NO hidden dependency on ad4m:host.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Adapter interfaces
import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport } from "../src/transport.js";
import type { SigningAdapter } from "../src/signing-interface.js";
import { initSigning } from "../src/signing-interface.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";

// Production modules under test
import * as store from "../src/store.js";
import { diffToEvents, linkContentKey, processInboundEvents } from "../src/translate.js";
import { shouldFederate, linkOriginKey, linkContentHash } from "../src/dual-language.js";
import { sync, bufferEvent, clearBuffer } from "../src/sync.js";
import { detectPattern } from "../src/sdna.js";
import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";

// Types
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import type { SignedNostrEvent } from "../src/nostr-event.pure.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
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
        const all = [...this.data.keys()];
        if (!prefix) return all;
        return all.filter(k => k.startsWith(prefix));
    }

    _dump(): Map<string, string> {
        return new Map(this.data);
    }

    _clear(): void {
        this.data.clear();
    }
}

class MockTransport implements Transport {
    public requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        this.requests.push({ url, method, headers, body });
        return { status: 200, headers: {}, body: "" };
    }
}

class MockSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string {
        return "mocksig" + payload.length.toString(16);
    }

    signingKeyId(): string {
        return "mock-key-id";
    }
}

class MockRuntime implements RuntimeAdapter {
    public signals: string[] = [];
    public diffs: unknown[] = [];

    hash(data: string): string {
        return simpleHash(data);
    }

    emitSignal(data: string): void {
        this.signals.push(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        this.diffs.push(diff);
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEIGHBOURHOOD_ID = "Qm123abc";
const NEIGHBOURHOOD_URL = `neighbourhood://${NEIGHBOURHOOD_ID}`;
const PUBKEY = "aa".repeat(32);

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

function makeChatLink(): LinkExpression {
    return makeLinkExpression({
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
    });
}

function makeTripleEvent(id: string, source: string, target: string): SignedNostrEvent {
    return {
        id,
        pubkey: PUBKEY,
        created_at: 1714650000,
        kind: 30078,
        tags: [
            ["d", `ad4m:hash_${id}`],
            ["ad4m:neighbourhood", NEIGHBOURHOOD_ID],
            ["ad4m:source", source],
            ["ad4m:predicate", "sioc://content_of"],
            ["ad4m:target", target],
            ["ad4m:did", "did:key:z6MkTest"],
            ["ad4m:proof:sig", "sig"],
            ["ad4m:proof:key", "key"],
            ["ad4m:link:hash", `hash_${id}`],
        ],
        content: "",
        sig: "cc".repeat(64),
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockStorage: MockStorageAdapter;
let mockTransport: MockTransport;
let mockSigning: MockSigningAdapter;
let mockRuntime: MockRuntime;

function initAllAdapters(): void {
    mockStorage = new MockStorageAdapter();
    mockTransport = new MockTransport();
    mockSigning = new MockSigningAdapter();
    mockRuntime = new MockRuntime();

    initRuntime(mockRuntime);
    initStorage(mockStorage);
    initTransport(mockTransport);
    initSigning(mockSigning);
    store.initStore(simpleHash);
    clearBuffer();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Store operations via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Store operations", () => {
    beforeEach(() => initAllAdapters());

    it("stores and retrieves a link", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        assert.ok(hash);

        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        assert.equal(retrieved!.data.source, "literal://hello");
    });

    it("indexes by source, target, and predicate", () => {
        const link = makeLinkExpression();
        store.putLink(link);

        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 1);
        assert.equal(store.queryLinks({ target: "literal://world" }).length, 1);
        assert.equal(store.queryLinks({ predicate: "sioc://content_of" }).length, 1);
    });

    it("returns empty for queries with no matches", () => {
        store.putLink(makeLinkExpression());
        assert.equal(store.queryLinks({ source: "nonexistent" }).length, 0);
    });

    it("removes links and cleans up indexes", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        store.removeLink(link);
        assert.equal(store.getLink(hash), null);
        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 0);
    });

    it("applies PerspectiveDiff", () => {
        const link1 = makeLinkExpression();
        store.putLink(link1);

        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });

        store.applyDiff({
            additions: [link2],
            removals: [link1],
        });

        assert.equal(store.getLink(store.hashLink(link1)), null);
        assert.ok(store.getLink(store.hashLink(link2)));
    });

    it("allLinks returns all stored links", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "x", target: "y", predicate: "z" },
            timestamp: "2026-05-02T01:00:00.000Z",
        }));
        assert.equal(store.allLinks().links.length, 2);
    });

    it("manages revision tracking", () => {
        assert.equal(store.getRevision(), null);
        store.setRevision("12345");
        assert.equal(store.getRevision(), "12345");
    });

    it("manages event ID mapping", () => {
        store.setEventId("linkHash1", "eventId1");
        assert.equal(store.getEventId("linkHash1"), "eventId1");
        assert.equal(store.getLinkHashByEventId("eventId1"), "linkHash1");
    });

    it("manages peers", () => {
        store.setPeer("pk1", { name: "Alice" });
        store.setPeer("pk2", { name: "Bob" });
        assert.equal(store.listPeers().length, 2);

        const meta = store.getPeerMetadata("pk1");
        assert.ok(meta);
        assert.equal(meta!.name, "Alice");

        store.removePeer("pk1");
        assert.equal(store.listPeers().length, 1);
    });

    it("manages event deduplication", () => {
        assert.equal(store.hasSeenEvent("event1"), false);
        store.markEventSeen("event1");
        assert.equal(store.hasSeenEvent("event1"), true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Translation via mock runtime
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Translation", () => {
    beforeEach(() => initAllAdapters());

    it("converts additions to triple events in native mode", () => {
        const link = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            neighbourhoodId: NEIGHBOURHOOD_ID,
            pubkey: PUBKEY,
            settings: { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "native" } },
            hashFn: simpleHash,
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].event.kind, 30078);
        assert.equal(events[0].eventType, "triple");
    });

    it("produces dual events for chat links in dual mode", () => {
        const link = makeChatLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            neighbourhoodId: NEIGHBOURHOOD_ID,
            pubkey: PUBKEY,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
        });

        assert.ok(events.length >= 2);
        assert.ok(events.some(e => e.event.kind === 30078));
        assert.ok(events.some(e => e.event.kind === 1));
    });

    it("respects federation filter", () => {
        const link = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            neighbourhoodId: NEIGHBOURHOOD_ID,
            pubkey: PUBKEY,
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            shouldFederate: () => false,
        });

        assert.equal(events.length, 0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Sync pipeline via mock adapters
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Sync pipeline", () => {
    beforeEach(() => initAllAdapters());

    it("full round-trip: link → event → buffer → sync → link", () => {
        // 1. Create a link and translate to event
        const original = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [original], removals: [] };
        const events = diffToEvents(diff, {
            neighbourhoodId: NEIGHBOURHOOD_ID,
            pubkey: PUBKEY,
            settings: { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "native" } },
            hashFn: simpleHash,
        });
        assert.equal(events.length, 1);

        // 2. Simulate the event arriving from a relay
        const signedEvent: SignedNostrEvent = {
            id: "e".repeat(64),
            pubkey: PUBKEY,
            sig: "f".repeat(128),
            ...events[0].event,
        };

        // 3. Buffer and sync
        bufferEvent(signedEvent);
        const syncDiff = sync(NEIGHBOURHOOD_URL);

        // 4. Verify round-trip
        assert.equal(syncDiff.additions.length, 1);
        const roundTripped = syncDiff.additions[0];
        assert.equal(roundTripped.data.source, original.data.source);
        assert.equal(roundTripped.data.predicate, original.data.predicate);
        assert.equal(roundTripped.data.target, original.data.target);
        assert.equal(roundTripped.author, original.author);
        assert.equal(roundTripped.proof.signature, original.proof.signature);
    });

    it("deduplicates events from multiple relays", () => {
        const event = makeTripleEvent("a".repeat(64), "src", "tgt");

        // Same event from 3 relays
        bufferEvent(event);
        bufferEvent(event);
        bufferEvent(event);

        const diff = sync(NEIGHBOURHOOD_URL);
        assert.equal(diff.additions.length, 1);
    });

    it("processes mixed event types", () => {
        // Triple event
        bufferEvent(makeTripleEvent("1".repeat(64), "src1", "tgt1"));

        // Text note
        bufferEvent({
            id: "2".repeat(64),
            pubkey: PUBKEY,
            created_at: 1714650001,
            kind: 1,
            tags: [["t", "ad4m"]],
            content: "Hello",
            sig: "c".repeat(128),
        });

        // Deletion
        bufferEvent({
            id: "3".repeat(64),
            pubkey: PUBKEY,
            created_at: 1714650002,
            kind: 5,
            tags: [["e", "old_event"]],
            content: "",
            sig: "c".repeat(128),
        });

        const diff = sync(NEIGHBOURHOOD_URL);
        assert.equal(diff.additions.length, 2); // triple + text note
        assert.equal(diff.removals.length, 1); // deletion
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Dual-language integration
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Dual-language", () => {
    beforeEach(() => initAllAdapters());

    it("prevents echo loop for nostr-origin links", () => {
        // Mark a link as coming from Nostr
        const link = makeLinkExpression();
        const linkHash = store.hashLink(link);
        mockStorage.put(linkOriginKey(linkHash), "nostr");

        // Should not federate
        assert.equal(shouldFederate(linkHash, (key) => mockStorage.get(key)), false);
    });

    it("federates native-origin links", () => {
        const link = makeLinkExpression();
        const linkHash = store.hashLink(link);
        mockStorage.put(linkOriginKey(linkHash), "native");

        assert.equal(shouldFederate(linkHash, (key) => mockStorage.get(key)), true);
    });

    it("federates new local commits (no origin)", () => {
        const link = makeLinkExpression();
        const linkHash = store.hashLink(link);
        // No origin stored

        assert.equal(shouldFederate(linkHash, (key) => mockStorage.get(key)), true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SDNA pattern detection integration
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: SDNA patterns", () => {
    it("detects chat patterns", () => {
        const link = makeChatLink();
        const pattern = detectPattern(link, DEFAULT_SETTINGS.rendering.chatPredicates);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects reaction patterns", () => {
        const link = makeLinkExpression({
            data: { source: "expr://msg", target: "👍", predicate: "flux://has_reaction" },
        });
        const pattern = detectPattern(link, DEFAULT_SETTINGS.rendering.chatPredicates);
        assert.equal(pattern.type, "reaction");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Settings parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Settings", () => {
    it("parses settings from JSON string", () => {
        const settings = parseSettings(JSON.stringify({
            syncMode: "publish-only",
            rendering: { strategy: "native" },
        }));
        assert.equal(settings.syncMode, "publish-only");
        assert.equal(settings.rendering.strategy, "native");
    });

    it("handles invalid input gracefully", () => {
        const settings = parseSettings("not-json");
        assert.equal(settings.syncMode, "bidirectional");
    });
});
