/**
 * Tests for Nostr event creation, serialization, and ID computation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    serializeForId,
    createTripleEvent,
    createTextNoteEvent,
    createReactionEvent,
    createDeletionEvent,
    getTagValue,
    getTagValues,
    isParameterizedReplaceable,
} from "../src/nostr-event.pure.js";
import type { UnsignedNostrEvent, SignedNostrEvent } from "../src/nostr-event.pure.js";
import { sha256Hex } from "../src/crypto.pure.js";

// ---------------------------------------------------------------------------
// serializeForId
// ---------------------------------------------------------------------------

describe("serializeForId", () => {
    it("produces NIP-01 canonical serialization", () => {
        const event: UnsignedNostrEvent = {
            kind: 1,
            created_at: 1714650000,
            tags: [["t", "ad4m"]],
            content: "Hello Nostr!",
        };
        const pubkey = "a".repeat(64);
        const serialized = serializeForId(event, pubkey);
        const parsed = JSON.parse(serialized);

        assert.equal(parsed[0], 0);
        assert.equal(parsed[1], pubkey);
        assert.equal(parsed[2], 1714650000);
        assert.equal(parsed[3], 1);
        assert.deepEqual(parsed[4], [["t", "ad4m"]]);
        assert.equal(parsed[5], "Hello Nostr!");
    });

    it("handles empty tags and content", () => {
        const event: UnsignedNostrEvent = {
            kind: 30078,
            created_at: 0,
            tags: [],
            content: "",
        };
        const serialized = serializeForId(event, "00".repeat(32));
        const parsed = JSON.parse(serialized);
        assert.deepEqual(parsed[4], []);
        assert.equal(parsed[5], "");
    });

    it("preserves tag order", () => {
        const event: UnsignedNostrEvent = {
            kind: 1,
            created_at: 100,
            tags: [["e", "abc"], ["p", "def"], ["t", "ghi"]],
            content: "",
        };
        const serialized = serializeForId(event, "11".repeat(32));
        const parsed = JSON.parse(serialized);
        assert.equal(parsed[4][0][0], "e");
        assert.equal(parsed[4][1][0], "p");
        assert.equal(parsed[4][2][0], "t");
    });

    it("handles special characters in content", () => {
        const event: UnsignedNostrEvent = {
            kind: 1,
            created_at: 100,
            tags: [],
            content: 'Hello "world" \n\t <>&',
        };
        const serialized = serializeForId(event, "22".repeat(32));
        const parsed = JSON.parse(serialized);
        assert.equal(parsed[5], 'Hello "world" \n\t <>&');
    });
});

// ---------------------------------------------------------------------------
// Event ID computation
// ---------------------------------------------------------------------------

describe("Event ID computation", () => {
    it("computes correct SHA-256 of serialized event", async () => {
        const event: UnsignedNostrEvent = {
            kind: 1,
            created_at: 1714650000,
            tags: [],
            content: "test",
        };
        const pubkey = "aa".repeat(32);
        const serialized = serializeForId(event, pubkey);
        const id = await sha256Hex(serialized);

        // ID should be a 64-char lowercase hex string
        assert.equal(id.length, 64);
        assert.ok(/^[0-9a-f]{64}$/.test(id));
    });

    it("produces different IDs for different events", async () => {
        const pubkey = "bb".repeat(32);
        const event1: UnsignedNostrEvent = {
            kind: 1, created_at: 100, tags: [], content: "a",
        };
        const event2: UnsignedNostrEvent = {
            kind: 1, created_at: 100, tags: [], content: "b",
        };
        const id1 = await sha256Hex(serializeForId(event1, pubkey));
        const id2 = await sha256Hex(serializeForId(event2, pubkey));
        assert.notEqual(id1, id2);
    });

    it("is deterministic", async () => {
        const event: UnsignedNostrEvent = {
            kind: 30078, created_at: 999, tags: [["d", "test"]], content: "",
        };
        const pubkey = "cc".repeat(32);
        const id1 = await sha256Hex(serializeForId(event, pubkey));
        const id2 = await sha256Hex(serializeForId(event, pubkey));
        assert.equal(id1, id2);
    });
});

// ---------------------------------------------------------------------------
// createTripleEvent
// ---------------------------------------------------------------------------

describe("createTripleEvent", () => {
    it("creates a kind 30078 event with all AD4M tags", () => {
        const event = createTripleEvent(
            "Qm123abc",
            "channel://main",
            "flux://has_message",
            "expr://Qm456def",
            "did:key:z6MkAgent",
            "sig123",
            "key123",
            "Qm789ghi",
            1714650000,
        );

        assert.equal(event.kind, 30078);
        assert.equal(event.created_at, 1714650000);
        assert.equal(event.content, "");

        // Check d tag is unique per triple (link hash, not neighbourhood ID)
        const dTag = event.tags.find(t => t[0] === "d");
        assert.ok(dTag);
        assert.equal(dTag![1], "ad4m:Qm789ghi");

        // Check neighbourhood tag
        const nTag = event.tags.find(t => t[0] === "ad4m:neighbourhood");
        assert.ok(nTag);
        assert.equal(nTag![1], "Qm123abc");

        // Check triple tags
        assert.equal(event.tags.find(t => t[0] === "ad4m:source")![1], "channel://main");
        assert.equal(event.tags.find(t => t[0] === "ad4m:predicate")![1], "flux://has_message");
        assert.equal(event.tags.find(t => t[0] === "ad4m:target")![1], "expr://Qm456def");

        // Check proof tags
        assert.equal(event.tags.find(t => t[0] === "ad4m:proof:sig")![1], "sig123");
        assert.equal(event.tags.find(t => t[0] === "ad4m:proof:key")![1], "key123");

        // Check link hash tag
        assert.equal(event.tags.find(t => t[0] === "ad4m:link:hash")![1], "Qm789ghi");
    });

    it("d tag is unique per link hash, not per neighbourhood", () => {
        const event1 = createTripleEvent("Qm123", "a", "b", "c", "did:1", "", "", "hash1", 100);
        const event2 = createTripleEvent("Qm123", "x", "y", "z", "did:2", "", "", "hash2", 200);

        const d1 = event1.tags.find(t => t[0] === "d")![1];
        const d2 = event2.tags.find(t => t[0] === "d")![1];

        // Different link hashes → different d tags (critical for replaceable events)
        assert.notEqual(d1, d2);
    });

    it("handles empty predicate", () => {
        const event = createTripleEvent("N1", "src", "", "tgt", "did:x", "", "", "h1", 100);
        const predTag = event.tags.find(t => t[0] === "ad4m:predicate");
        assert.ok(predTag);
        assert.equal(predTag![1], "");
    });
});

// ---------------------------------------------------------------------------
// createTextNoteEvent
// ---------------------------------------------------------------------------

describe("createTextNoteEvent", () => {
    it("creates a kind 1 event with AD4M tags", () => {
        const event = createTextNoteEvent(
            "Hello from AD4M!",
            "Qm123abc",
            "did:key:z6MkAgent",
            1714650000,
        );

        assert.equal(event.kind, 1);
        assert.equal(event.content, "Hello from AD4M!");
        assert.equal(event.created_at, 1714650000);

        const tTag = event.tags.find(t => t[0] === "t");
        assert.ok(tTag);
        assert.equal(tTag![1], "ad4m");

        const nTag = event.tags.find(t => t[0] === "ad4m:neighbourhood");
        assert.ok(nTag);
        assert.equal(nTag![1], "Qm123abc");
    });

    it("includes NIP-10 reply tags when provided", () => {
        const event = createTextNoteEvent(
            "This is a reply",
            "Qm123",
            "did:key:z6MkAgent",
            100,
            "eventid123",
            "pubkey456",
        );

        const eTag = event.tags.find(t => t[0] === "e");
        assert.ok(eTag);
        assert.equal(eTag![1], "eventid123");
        assert.equal(eTag![3], "reply");

        const pTag = event.tags.find(t => t[0] === "p");
        assert.ok(pTag);
        assert.equal(pTag![1], "pubkey456");
    });

    it("omits reply tags when not provided", () => {
        const event = createTextNoteEvent("No reply", "N1", "did:x", 100);
        const eTag = event.tags.find(t => t[0] === "e");
        assert.equal(eTag, undefined);
    });
});

// ---------------------------------------------------------------------------
// createReactionEvent
// ---------------------------------------------------------------------------

describe("createReactionEvent", () => {
    it("creates a kind 7 event", () => {
        const event = createReactionEvent("👍", "eventid123", "pubkey456", 1714650000);

        assert.equal(event.kind, 7);
        assert.equal(event.content, "👍");

        const eTag = event.tags.find(t => t[0] === "e");
        assert.ok(eTag);
        assert.equal(eTag![1], "eventid123");

        const pTag = event.tags.find(t => t[0] === "p");
        assert.ok(pTag);
        assert.equal(pTag![1], "pubkey456");
    });
});

// ---------------------------------------------------------------------------
// createDeletionEvent
// ---------------------------------------------------------------------------

describe("createDeletionEvent", () => {
    it("creates a kind 5 event with e tags", () => {
        const event = createDeletionEvent(["event1", "event2"], 1714650000);

        assert.equal(event.kind, 5);
        assert.equal(event.content, "Link removed from AD4M perspective");

        const eTags = event.tags.filter(t => t[0] === "e");
        assert.equal(eTags.length, 2);
        assert.equal(eTags[0][1], "event1");
        assert.equal(eTags[1][1], "event2");
    });

    it("accepts custom reason", () => {
        const event = createDeletionEvent(["e1"], 100, "custom reason");
        assert.equal(event.content, "custom reason");
    });
});

// ---------------------------------------------------------------------------
// getTagValue / getTagValues
// ---------------------------------------------------------------------------

describe("getTagValue", () => {
    const event: SignedNostrEvent = {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: 100,
        kind: 30078,
        tags: [
            ["d", "ad4m:hash123"],
            ["ad4m:source", "channel://main"],
            ["ad4m:predicate", "flux://has_message"],
            ["ad4m:target", "expr://msg"],
            ["p", "pubkey1"],
            ["p", "pubkey2"],
        ],
        content: "",
        sig: "c".repeat(128),
    };

    it("returns first matching tag value", () => {
        assert.equal(getTagValue(event, "d"), "ad4m:hash123");
        assert.equal(getTagValue(event, "ad4m:source"), "channel://main");
    });

    it("returns null for missing tag", () => {
        assert.equal(getTagValue(event, "nonexistent"), null);
    });

    it("returns first value when multiple tags match", () => {
        assert.equal(getTagValue(event, "p"), "pubkey1");
    });
});

describe("getTagValues", () => {
    const event: SignedNostrEvent = {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: 100,
        kind: 1,
        tags: [["p", "pk1"], ["p", "pk2"], ["t", "ad4m"]],
        content: "",
        sig: "c".repeat(128),
    };

    it("returns all matching tag values", () => {
        const values = getTagValues(event, "p");
        assert.deepEqual(values, ["pk1", "pk2"]);
    });

    it("returns empty array for missing tag", () => {
        assert.deepEqual(getTagValues(event, "e"), []);
    });
});

// ---------------------------------------------------------------------------
// isParameterizedReplaceable
// ---------------------------------------------------------------------------

describe("isParameterizedReplaceable", () => {
    it("returns true for kind 30078", () => {
        assert.equal(isParameterizedReplaceable(30078), true);
    });

    it("returns true for kind 30000-39999", () => {
        assert.equal(isParameterizedReplaceable(30000), true);
        assert.equal(isParameterizedReplaceable(39999), true);
    });

    it("returns false for kind 1", () => {
        assert.equal(isParameterizedReplaceable(1), false);
    });

    it("returns false for kind 5", () => {
        assert.equal(isParameterizedReplaceable(5), false);
    });

    it("returns false for kind 40000", () => {
        assert.equal(isParameterizedReplaceable(40000), false);
    });
});
