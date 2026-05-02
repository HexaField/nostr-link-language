/**
 * Tests for sync coordination: event accumulation, dedup.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";
import * as store from "../src/store.js";

import {
    bufferEvent,
    getBufferSize,
    clearBuffer,
    sync,
    handleInboundSignal,
} from "../src/sync.js";

import type { SignedNostrEvent } from "../src/nostr-event.pure.js";

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        return prefix ? all.filter(k => k.startsWith(prefix)) : all;
    }
}

class MockRuntime implements RuntimeAdapter {
    signals: string[] = [];
    diffs: unknown[] = [];
    hash(data: string): string {
        let h = 0;
        for (let i = 0; i < data.length; i++) {
            h = ((h << 5) - h + data.charCodeAt(i)) | 0;
        }
        return `Qm${Math.abs(h).toString(16)}`;
    }
    emitSignal(data: string): void { this.signals.push(data); }
    emitPerspectiveDiff(diff: unknown): void { this.diffs.push(diff); }
}

function makeTripleEvent(id: string, source: string, target: string): SignedNostrEvent {
    return {
        id,
        pubkey: "b".repeat(64),
        created_at: 1714650000,
        kind: 30078,
        tags: [
            ["d", `ad4m:hash_${id}`],
            ["ad4m:neighbourhood", "Qm123"],
            ["ad4m:source", source],
            ["ad4m:predicate", "sioc://content_of"],
            ["ad4m:target", target],
            ["ad4m:did", "did:key:z6MkTest"],
            ["ad4m:proof:sig", "sig"],
            ["ad4m:proof:key", "key"],
            ["ad4m:link:hash", `hash_${id}`],
        ],
        content: "",
        sig: "c".repeat(128),
    };
}

function makeTextNoteEvent(id: string): SignedNostrEvent {
    return {
        id,
        pubkey: "b".repeat(64),
        created_at: 1714650000,
        kind: 1,
        tags: [["t", "ad4m"]],
        content: "Hello",
        sig: "c".repeat(128),
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup() {
    const mockStorage = new MockStorage();
    const mockRuntime = new MockRuntime();
    initRuntime(mockRuntime);
    initStorage(mockStorage);
    store.initStore();
    clearBuffer();
    return { mockStorage, mockRuntime };
}

// ---------------------------------------------------------------------------
// bufferEvent / getBufferSize / clearBuffer
// ---------------------------------------------------------------------------

describe("Event buffer", () => {
    beforeEach(() => setup());

    it("starts empty", () => {
        assert.equal(getBufferSize(), 0);
    });

    it("accumulates events", () => {
        bufferEvent(makeTripleEvent("a".repeat(64), "src1", "tgt1"));
        bufferEvent(makeTripleEvent("b".repeat(64), "src2", "tgt2"));
        assert.equal(getBufferSize(), 2);
    });

    it("clears the buffer", () => {
        bufferEvent(makeTripleEvent("a".repeat(64), "src", "tgt"));
        clearBuffer();
        assert.equal(getBufferSize(), 0);
    });
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

describe("sync", () => {
    beforeEach(() => setup());

    it("returns empty diff when buffer is empty", () => {
        const diff = sync("neighbourhood://test");
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("processes buffered triple events into additions", () => {
        bufferEvent(makeTripleEvent("1".repeat(64), "src1", "tgt1"));
        bufferEvent(makeTripleEvent("2".repeat(64), "src2", "tgt2"));

        const diff = sync("neighbourhood://test");
        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);
    });

    it("drains the buffer after sync", () => {
        bufferEvent(makeTripleEvent("1".repeat(64), "src", "tgt"));
        sync("neighbourhood://test");
        assert.equal(getBufferSize(), 0);
    });

    it("deduplicates events by ID", () => {
        const event = makeTripleEvent("a".repeat(64), "src", "tgt");
        bufferEvent(event);
        bufferEvent(event); // Same event from different relay

        const diff = sync("neighbourhood://test");
        assert.equal(diff.additions.length, 1);
    });

    it("stores links in the store", () => {
        bufferEvent(makeTripleEvent("1".repeat(64), "src1", "tgt1"));
        sync("neighbourhood://test");

        const links = store.allLinks();
        assert.equal(links.links.length, 1);
    });

    it("tracks peers from events", () => {
        bufferEvent(makeTripleEvent("1".repeat(64), "src", "tgt"));
        sync("neighbourhood://test");

        const peers = store.listPeers();
        assert.ok(peers.length > 0);
    });

    it("updates revision to latest timestamp", () => {
        bufferEvent(makeTripleEvent("1".repeat(64), "src", "tgt"));
        sync("neighbourhood://test");

        const rev = store.getRevision();
        assert.ok(rev);
        assert.equal(parseInt(rev!, 10), 1714650000);
    });

    it("handles text note events", () => {
        bufferEvent(makeTextNoteEvent("3".repeat(64)));
        const diff = sync("neighbourhood://test");
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.predicate, "sioc://content_of");
    });

    it("processes deletion events as removals", () => {
        const delEvent: SignedNostrEvent = {
            id: "d".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 1714650100,
            kind: 5,
            tags: [["e", "target_event_id"]],
            content: "",
            sig: "c".repeat(128),
        };
        bufferEvent(delEvent);
        const diff = sync("neighbourhood://test");
        assert.equal(diff.removals.length, 1);
    });

    it("second sync after first returns no duplicates", () => {
        bufferEvent(makeTripleEvent("1".repeat(64), "src", "tgt"));
        sync("neighbourhood://test");

        // Buffer same event again
        bufferEvent(makeTripleEvent("1".repeat(64), "src", "tgt"));
        const diff2 = sync("neighbourhood://test");
        assert.equal(diff2.additions.length, 0); // Already seen
    });
});

// ---------------------------------------------------------------------------
// handleInboundSignal
// ---------------------------------------------------------------------------

describe("handleInboundSignal", () => {
    beforeEach(() => setup());

    it("buffers nostr:event signals", () => {
        const event = makeTripleEvent("1".repeat(64), "src", "tgt");
        const result = handleInboundSignal({ type: "nostr:event", event });

        assert.equal(result.kind, "event");
        assert.equal(getBufferSize(), 1);
    });

    it("ignores non-object signals", () => {
        const result = handleInboundSignal("not an object");
        assert.equal(result.kind, "ignored");
    });

    it("ignores null signals", () => {
        const result = handleInboundSignal(null);
        assert.equal(result.kind, "ignored");
    });

    it("ignores unknown signal types", () => {
        const result = handleInboundSignal({ type: "unknown:type" });
        assert.equal(result.kind, "ignored");
        assert.ok(result.reason?.includes("unknown"));
    });

    it("ignores signals without event", () => {
        const result = handleInboundSignal({ type: "nostr:event" });
        assert.equal(result.kind, "ignored");
    });
});
