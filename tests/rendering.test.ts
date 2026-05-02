/**
 * Tests for Kind-1 note rendering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    generateNoteContent,
    generateReplyTags,
    applyMentions,
    extractHashtags,
    generateHashtagTags,
} from "../src/rendering.pure.js";

import { renderAsTextNote } from "../src/rendering.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChatLink(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
        proof: { signature: "sig", key: "key" },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// generateNoteContent
// ---------------------------------------------------------------------------

describe("generateNoteContent", () => {
    it("uses resolved content when available", () => {
        const link = makeChatLink();
        assert.equal(generateNoteContent(link, "Hello world!"), "Hello world!");
    });

    it("falls back to raw target", () => {
        const link = makeChatLink();
        assert.equal(generateNoteContent(link), "expr://msg-001");
    });

    it("handles empty target", () => {
        const link = makeChatLink({
            data: { source: "s", target: "", predicate: "p" },
        });
        assert.equal(generateNoteContent(link), "");
    });
});

// ---------------------------------------------------------------------------
// generateReplyTags
// ---------------------------------------------------------------------------

describe("generateReplyTags", () => {
    it("generates reply tag for direct reply", () => {
        const tags = generateReplyTags(undefined, "eventid123", "pubkey456");

        const eTag = tags.find(t => t[0] === "e");
        assert.ok(eTag);
        assert.equal(eTag![1], "eventid123");
        assert.equal(eTag![3], "reply");

        const pTag = tags.find(t => t[0] === "p");
        assert.ok(pTag);
        assert.equal(pTag![1], "pubkey456");
    });

    it("generates root and reply tags for threaded reply", () => {
        const tags = generateReplyTags("root123", "reply456", "pk789");

        assert.equal(tags.length, 3);
        const rootTag = tags.find(t => t[3] === "root");
        assert.ok(rootTag);
        assert.equal(rootTag![1], "root123");

        const replyTag = tags.find(t => t[3] === "reply");
        assert.ok(replyTag);
        assert.equal(replyTag![1], "reply456");
    });

    it("returns empty array when no reply info", () => {
        assert.deepEqual(generateReplyTags(), []);
    });

    it("uses relay hint when provided", () => {
        const tags = generateReplyTags(undefined, "eid", undefined, "wss://relay.example.com");
        const eTag = tags.find(t => t[0] === "e");
        assert.ok(eTag);
        assert.equal(eTag![2], "wss://relay.example.com");
    });
});

// ---------------------------------------------------------------------------
// applyMentions
// ---------------------------------------------------------------------------

describe("applyMentions", () => {
    it("replaces DID with nostr pubkey", () => {
        const result = applyMentions(
            "Hello did:key:z6MkAlice!",
            [{ did: "did:key:z6MkAlice", pubkey: "abc123" }],
        );
        assert.equal(result, "Hello nostr:abc123!");
    });

    it("replaces multiple mentions", () => {
        const result = applyMentions(
            "CC: did:key:z6MkAlice and did:key:z6MkBob",
            [
                { did: "did:key:z6MkAlice", pubkey: "pk1" },
                { did: "did:key:z6MkBob", pubkey: "pk2" },
            ],
        );
        assert.equal(result, "CC: nostr:pk1 and nostr:pk2");
    });

    it("handles no mentions", () => {
        assert.equal(applyMentions("Hello world", []), "Hello world");
    });

    it("handles repeated mentions", () => {
        const result = applyMentions(
            "did:key:z6Mk did:key:z6Mk",
            [{ did: "did:key:z6Mk", pubkey: "pk" }],
        );
        assert.equal(result, "nostr:pk nostr:pk");
    });
});

// ---------------------------------------------------------------------------
// extractHashtags
// ---------------------------------------------------------------------------

describe("extractHashtags", () => {
    it("extracts hashtags from content", () => {
        assert.deepEqual(extractHashtags("Hello #world #ad4m"), ["world", "ad4m"]);
    });

    it("returns empty for no hashtags", () => {
        assert.deepEqual(extractHashtags("Hello world"), []);
    });

    it("deduplicates hashtags", () => {
        assert.deepEqual(extractHashtags("#hello #Hello #hello"), ["hello"]);
    });

    it("handles hashtags with underscores and numbers", () => {
        assert.deepEqual(extractHashtags("#test_123"), ["test_123"]);
    });
});

// ---------------------------------------------------------------------------
// generateHashtagTags
// ---------------------------------------------------------------------------

describe("generateHashtagTags", () => {
    it("generates t tags for hashtags", () => {
        const tags = generateHashtagTags("Hello #world #nostr");
        assert.deepEqual(tags, [["t", "world"], ["t", "nostr"]]);
    });

    it("returns empty for no hashtags", () => {
        assert.deepEqual(generateHashtagTags("No tags here"), []);
    });
});

// ---------------------------------------------------------------------------
// renderAsTextNote (integration)
// ---------------------------------------------------------------------------

describe("renderAsTextNote", () => {
    it("renders chat-message link as kind 1 event", () => {
        const link = makeChatLink();
        const event = renderAsTextNote(link, "Qm123", DEFAULT_SETTINGS, "Hello from AD4M!");

        assert.ok(event);
        assert.equal(event!.kind, 1);
        assert.equal(event!.content, "Hello from AD4M!");
    });

    it("returns null for unknown pattern links", () => {
        const link: LinkExpression = {
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            data: { source: "a", target: "b", predicate: "custom://unknown" },
            proof: { signature: "", key: "" },
        };
        assert.equal(renderAsTextNote(link, "Qm123", DEFAULT_SETTINGS), null);
    });

    it("renders reply link with reply tags", () => {
        const link: LinkExpression = {
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            data: {
                source: "expr://parent",
                target: "expr://reply",
                predicate: "flux://has_reply",
            },
            proof: { signature: "", key: "" },
        };

        const event = renderAsTextNote(
            link, "Qm123", DEFAULT_SETTINGS,
            "I agree!",
            "parent_event_id",
            "parent_pubkey",
        );

        assert.ok(event);
        assert.equal(event!.content, "I agree!");
        // Should have reply tags
        const replyTags = event!.tags.filter(t => t[0] === "e" && t[3] === "reply");
        assert.ok(replyTags.length > 0);
    });

    it("adds hashtag tags from content", () => {
        const link = makeChatLink();
        const event = renderAsTextNote(link, "Qm123", DEFAULT_SETTINGS, "Hello #ad4m #nostr!");

        assert.ok(event);
        const hashtagTags = event!.tags.filter(t => t[0] === "t" && (t[1] === "ad4m" || t[1] === "nostr"));
        assert.ok(hashtagTags.length >= 1); // at least the hashtag tags (plus the "ad4m" t tag from createTextNoteEvent)
    });
});
