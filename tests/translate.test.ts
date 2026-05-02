/**
 * Tests for Link ↔ Nostr event translation (round-trip, lossy inbound).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    linkToTripleEvent,
    linkToTextNote,
    linkRemovalToDeletionEvent,
    tripleEventToLink,
    textNoteToLink,
    reactionEventToLink,
    deletionEventToRemovals,
    eventToLinks,
    linkContentKey,
    isoToUnix,
    unixToIso,
} from "../src/translate.pure.js";

import { diffToEvents, processInboundEvents } from "../src/translate.js";

import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import type { SignedNostrEvent } from "../src/nostr-event.pure.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

function makeSignedEvent(overrides?: Partial<SignedNostrEvent>): SignedNostrEvent {
    return {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: 1714650000,
        kind: 30078,
        tags: [
            ["d", "ad4m:hash123"],
            ["ad4m:neighbourhood", "Qm123"],
            ["ad4m:source", "literal://hello"],
            ["ad4m:predicate", "sioc://content_of"],
            ["ad4m:target", "literal://world"],
            ["ad4m:did", "did:key:z6MkTest"],
            ["ad4m:proof:sig", "abc123"],
            ["ad4m:proof:key", "key123"],
            ["ad4m:link:hash", "hash123"],
        ],
        content: "",
        sig: "c".repeat(128),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// isoToUnix / unixToIso
// ---------------------------------------------------------------------------

describe("isoToUnix", () => {
    it("converts ISO to unix seconds", () => {
        assert.equal(isoToUnix("2026-05-02T00:00:00.000Z"), 1777680000);
    });

    it("handles timezone-aware ISO", () => {
        const unix = isoToUnix("2026-05-02T10:00:00.000+10:00");
        assert.equal(unix, 1777680000); // Same moment as midnight UTC
    });
});

describe("unixToIso", () => {
    it("converts unix seconds to ISO", () => {
        const iso = unixToIso(1777680000);
        assert.ok(iso.includes("2026-05-02"));
    });

    it("round-trips with isoToUnix", () => {
        const original = "2026-05-02T00:00:00.000Z";
        const unix = isoToUnix(original);
        const iso = unixToIso(unix);
        assert.equal(iso, original);
    });
});

// ---------------------------------------------------------------------------
// linkContentKey
// ---------------------------------------------------------------------------

describe("linkContentKey", () => {
    it("produces deterministic key", () => {
        const link = makeLinkExpression();
        assert.equal(linkContentKey(link), linkContentKey(link));
    });

    it("differs for different links", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });
});

// ---------------------------------------------------------------------------
// Outbound: linkToTripleEvent
// ---------------------------------------------------------------------------

describe("linkToTripleEvent", () => {
    it("creates a kind 30078 event with correct tags", () => {
        const link = makeLinkExpression();
        const event = linkToTripleEvent(link, "Qm123", "hash456");

        assert.equal(event.kind, 30078);
        assert.equal(event.content, "");

        // d tag uses link hash, not neighbourhood ID
        const dTag = event.tags.find(t => t[0] === "d");
        assert.equal(dTag![1], "ad4m:hash456");

        // All link data in tags
        assert.equal(event.tags.find(t => t[0] === "ad4m:source")![1], "literal://hello");
        assert.equal(event.tags.find(t => t[0] === "ad4m:predicate")![1], "sioc://content_of");
        assert.equal(event.tags.find(t => t[0] === "ad4m:target")![1], "literal://world");
        assert.equal(event.tags.find(t => t[0] === "ad4m:did")![1], "did:key:z6MkTest");
        assert.equal(event.tags.find(t => t[0] === "ad4m:proof:sig")![1], "abc123");
        assert.equal(event.tags.find(t => t[0] === "ad4m:proof:key")![1], "key123");
    });
});

// ---------------------------------------------------------------------------
// Outbound: linkToTextNote
// ---------------------------------------------------------------------------

describe("linkToTextNote", () => {
    it("creates a kind 1 event with content", () => {
        const link = makeChatLink();
        const event = linkToTextNote(link, "Qm123", "Hello from AD4M!");

        assert.equal(event.kind, 1);
        assert.equal(event.content, "Hello from AD4M!");
    });

    it("uses raw target when no resolved content", () => {
        const link = makeChatLink();
        const event = linkToTextNote(link, "Qm123", "expr://msg-001");
        assert.equal(event.content, "expr://msg-001");
    });
});

// ---------------------------------------------------------------------------
// Outbound: linkRemovalToDeletionEvent
// ---------------------------------------------------------------------------

describe("linkRemovalToDeletionEvent", () => {
    it("creates a kind 5 event", () => {
        const event = linkRemovalToDeletionEvent(["event123"], 1714650000);

        assert.equal(event.kind, 5);
        assert.equal(event.tags[0][0], "e");
        assert.equal(event.tags[0][1], "event123");
    });

    it("handles multiple event IDs", () => {
        const event = linkRemovalToDeletionEvent(["e1", "e2", "e3"], 100);
        assert.equal(event.tags.length, 3);
    });
});

// ---------------------------------------------------------------------------
// Inbound: tripleEventToLink (lossless round-trip)
// ---------------------------------------------------------------------------

describe("tripleEventToLink", () => {
    it("extracts link from kind 30078 event tags", () => {
        const event = makeSignedEvent();
        const link = tripleEventToLink(event);

        assert.ok(link);
        assert.equal(link!.data.source, "literal://hello");
        assert.equal(link!.data.predicate, "sioc://content_of");
        assert.equal(link!.data.target, "literal://world");
        assert.equal(link!.author, "did:key:z6MkTest");
        assert.equal(link!.proof.signature, "abc123");
        assert.equal(link!.proof.key, "key123");
    });

    it("returns null when required tags are missing", () => {
        const event = makeSignedEvent({
            tags: [["d", "ad4m:hash"]],
        });
        assert.equal(tripleEventToLink(event), null);
    });

    it("uses nostr pubkey as author when ad4m:did is missing", () => {
        const event = makeSignedEvent({
            tags: [
                ["ad4m:source", "src"],
                ["ad4m:target", "tgt"],
            ],
        });
        const link = tripleEventToLink(event);
        assert.ok(link);
        assert.equal(link!.author, `nostr:${"b".repeat(64)}`);
    });
});

// ---------------------------------------------------------------------------
// Round-trip: link → event → link
// ---------------------------------------------------------------------------

describe("Round-trip: link → triple event → link", () => {
    it("is lossless for kind 30078", () => {
        const original = makeLinkExpression();
        const event = linkToTripleEvent(original, "Qm123", "hash789");

        // Simulate signing
        const signed: SignedNostrEvent = {
            id: "d".repeat(64),
            pubkey: "e".repeat(64),
            sig: "f".repeat(128),
            ...event,
        };

        const roundTripped = tripleEventToLink(signed);
        assert.ok(roundTripped);
        assert.equal(roundTripped!.data.source, original.data.source);
        assert.equal(roundTripped!.data.predicate, original.data.predicate);
        assert.equal(roundTripped!.data.target, original.data.target);
        assert.equal(roundTripped!.author, original.author);
        assert.equal(roundTripped!.proof.signature, original.proof.signature);
        assert.equal(roundTripped!.proof.key, original.proof.key);
    });
});

// ---------------------------------------------------------------------------
// Inbound: textNoteToLink
// ---------------------------------------------------------------------------

describe("textNoteToLink", () => {
    it("creates a synthesized link from kind 1 event", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 1714650000,
            kind: 1,
            tags: [["t", "ad4m"]],
            content: "Hello Nostr!",
            sig: "c".repeat(128),
        };

        const link = textNoteToLink(event, "neighbourhood://test");
        assert.equal(link.data.source, "neighbourhood://test");
        assert.equal(link.data.predicate, "sioc://content_of");
        assert.equal(link.data.target, `nostr:note:${"a".repeat(64)}`);
        assert.equal(link.author, `nostr:${"b".repeat(64)}`);
    });

    it("uses ad4m:did tag when present", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 1,
            tags: [["ad4m:did", "did:key:z6MkAlice"]],
            content: "test",
            sig: "c".repeat(128),
        };

        const link = textNoteToLink(event, "neighbourhood://test");
        assert.equal(link.author, "did:key:z6MkAlice");
    });
});

// ---------------------------------------------------------------------------
// Inbound: reactionEventToLink
// ---------------------------------------------------------------------------

describe("reactionEventToLink", () => {
    it("creates a reaction link from kind 7 event", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 7,
            tags: [["e", "target_event_id"]],
            content: "👍",
            sig: "c".repeat(128),
        };

        const link = reactionEventToLink(event);
        assert.ok(link);
        assert.equal(link!.data.source, "nostr:note:target_event_id");
        assert.equal(link!.data.predicate, "flux://has_reaction");
        assert.equal(link!.data.target, "👍");
    });

    it("returns null when no e tag", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 7,
            tags: [],
            content: "+",
            sig: "c".repeat(128),
        };

        assert.equal(reactionEventToLink(event), null);
    });
});

// ---------------------------------------------------------------------------
// Inbound: deletionEventToRemovals
// ---------------------------------------------------------------------------

describe("deletionEventToRemovals", () => {
    it("creates removal links from kind 5 event", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 5,
            tags: [["e", "event1"], ["e", "event2"]],
            content: "deleted",
            sig: "c".repeat(128),
        };

        const removals = deletionEventToRemovals(event, "neighbourhood://test");
        assert.equal(removals.length, 2);
        assert.equal(removals[0].data.predicate, "nostr://deleted");
        assert.equal(removals[0].data.target, "nostr:note:event1");
        assert.equal(removals[1].data.target, "nostr:note:event2");
    });
});

// ---------------------------------------------------------------------------
// eventToLinks dispatcher
// ---------------------------------------------------------------------------

describe("eventToLinks", () => {
    it("routes kind 30078 to tripleEventToLink", () => {
        const event = makeSignedEvent();
        const links = eventToLinks(event, "neighbourhood://test");
        assert.equal(links.length, 1);
        assert.equal(links[0].data.source, "literal://hello");
    });

    it("routes kind 1 to textNoteToLink", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 1,
            tags: [],
            content: "Hello",
            sig: "c".repeat(128),
        };
        const links = eventToLinks(event, "neighbourhood://test");
        assert.equal(links.length, 1);
        assert.equal(links[0].data.predicate, "sioc://content_of");
    });

    it("routes kind 7 to reactionEventToLink", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 7,
            tags: [["e", "target"]],
            content: "❤️",
            sig: "c".repeat(128),
        };
        const links = eventToLinks(event, "neighbourhood://test");
        assert.equal(links.length, 1);
        assert.equal(links[0].data.predicate, "flux://has_reaction");
    });

    it("routes kind 5 to deletionEventToRemovals", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 5,
            tags: [["e", "del1"]],
            content: "",
            sig: "c".repeat(128),
        };
        const links = eventToLinks(event, "neighbourhood://test");
        assert.equal(links.length, 1);
        assert.equal(links[0].data.predicate, "nostr://deleted");
    });

    it("returns empty for unsupported kinds", () => {
        const event: SignedNostrEvent = {
            id: "a".repeat(64),
            pubkey: "b".repeat(64),
            created_at: 100,
            kind: 9999,
            tags: [],
            content: "",
            sig: "c".repeat(128),
        };
        assert.deepEqual(eventToLinks(event, "neighbourhood://test"), []);
    });
});

// ---------------------------------------------------------------------------
// diffToEvents
// ---------------------------------------------------------------------------

describe("diffToEvents", () => {
    it("produces triple events for additions in native mode", () => {
        const link = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            neighbourhoodId: "Qm123",
            pubkey: "aa".repeat(32),
            settings: { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "native" } },
            hashFn: simpleHash,
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].event.kind, 30078);
        assert.equal(events[0].eventType, "triple");
    });

    it("produces both triple and social events in dual mode", () => {
        const link = makeChatLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            neighbourhoodId: "Qm123",
            pubkey: "aa".repeat(32),
            settings: { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "dual" } },
            hashFn: simpleHash,
        });

        assert.ok(events.length >= 2);
        assert.ok(events.some(e => e.event.kind === 30078));
        assert.ok(events.some(e => e.event.kind === 1));
    });

    it("respects shouldFederate filter", () => {
        const link = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            neighbourhoodId: "Qm123",
            pubkey: "aa".repeat(32),
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            shouldFederate: () => false,
        });

        assert.equal(events.length, 0);
    });

    it("handles empty diff", () => {
        const diff: PerspectiveDiff = { additions: [], removals: [] };
        const events = diffToEvents(diff, {
            neighbourhoodId: "Qm123",
            pubkey: "aa".repeat(32),
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
        });
        assert.equal(events.length, 0);
    });
});

// ---------------------------------------------------------------------------
// processInboundEvents
// ---------------------------------------------------------------------------

describe("processInboundEvents", () => {
    it("processes multiple events into a diff", () => {
        const events: SignedNostrEvent[] = [
            makeSignedEvent({ id: "1".repeat(64) }),
            {
                id: "2".repeat(64),
                pubkey: "b".repeat(64),
                created_at: 100,
                kind: 1,
                tags: [],
                content: "Hello",
                sig: "c".repeat(128),
            },
        ];

        const diff = processInboundEvents(events, "neighbourhood://test");
        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);
    });

    it("separates deletions into removals", () => {
        const events: SignedNostrEvent[] = [
            {
                id: "d".repeat(64),
                pubkey: "b".repeat(64),
                created_at: 100,
                kind: 5,
                tags: [["e", "del1"]],
                content: "",
                sig: "c".repeat(128),
            },
        ];

        const diff = processInboundEvents(events, "neighbourhood://test");
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 1);
    });
});
