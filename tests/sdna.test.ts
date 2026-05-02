/**
 * Tests for SDNA pattern detection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectPattern, isSocialPattern } from "../src/sdna.js";
import type { DetectedPattern } from "../src/sdna.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT_PREDICATES = ["flux://has_message", "sioc://content_of"];

function makeLink(predicate: string, source: string = "src", target: string = "tgt"): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: { source, target, predicate },
        proof: { signature: "", key: "" },
    };
}

// ---------------------------------------------------------------------------
// detectPattern
// ---------------------------------------------------------------------------

describe("detectPattern", () => {
    it("detects chat-message pattern", () => {
        const link = makeLink("flux://has_message", "channel://main", "expr://msg-001");
        const pattern = detectPattern(link, CHAT_PREDICATES);

        assert.equal(pattern.type, "chat-message");
        assert.equal(pattern.contentUri, "expr://msg-001");
        assert.equal(pattern.channelUri, "channel://main");
    });

    it("detects sioc://content_of as chat-message", () => {
        const link = makeLink("sioc://content_of", "channel://main", "expr://msg");
        const pattern = detectPattern(link, CHAT_PREDICATES);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects reply pattern", () => {
        const link = makeLink("flux://has_reply", "expr://parent", "expr://reply");
        const pattern = detectPattern(link, CHAT_PREDICATES);

        assert.equal(pattern.type, "reply");
        assert.equal(pattern.contentUri, "expr://reply");
        assert.equal(pattern.parentUri, "expr://parent");
    });

    it("detects sioc://reply_of as reply", () => {
        const link = makeLink("sioc://reply_of", "expr://parent", "expr://reply");
        const pattern = detectPattern(link, CHAT_PREDICATES);
        assert.equal(pattern.type, "reply");
    });

    it("detects mention pattern", () => {
        const link = makeLink("flux://has_mention", "expr://msg", "did:key:z6MkAlice");
        const pattern = detectPattern(link, CHAT_PREDICATES);

        assert.equal(pattern.type, "mention");
        assert.equal(pattern.mentionedAgent, "did:key:z6MkAlice");
    });

    it("detects mention with custom predicate containing 'mention'", () => {
        const link = makeLink("custom://user_mention", "expr://msg", "did:key:z6Mk");
        const pattern = detectPattern(link, CHAT_PREDICATES);
        assert.equal(pattern.type, "mention");
    });

    it("detects reaction pattern", () => {
        const link = makeLink("flux://has_reaction", "expr://msg", "👍");
        const pattern = detectPattern(link, CHAT_PREDICATES);

        assert.equal(pattern.type, "reaction");
        assert.equal(pattern.contentUri, "👍");
    });

    it("detects emoji://reaction as reaction", () => {
        const link = makeLink("emoji://reaction", "expr://msg", "❤️");
        const pattern = detectPattern(link, CHAT_PREDICATES);
        assert.equal(pattern.type, "reaction");
    });

    it("returns unknown for unrecognized predicate", () => {
        const link = makeLink("custom://unknown", "a", "b");
        const pattern = detectPattern(link, CHAT_PREDICATES);
        assert.equal(pattern.type, "unknown");
    });

    it("returns unknown for empty predicate", () => {
        const link = makeLink("", "a", "b");
        const pattern = detectPattern(link, CHAT_PREDICATES);
        assert.equal(pattern.type, "unknown");
    });

    it("chat-message takes priority over content (sioc://content_of is in chatPredicates)", () => {
        const link = makeLink("sioc://content_of", "src", "tgt");
        const pattern = detectPattern(link, CHAT_PREDICATES);
        assert.equal(pattern.type, "chat-message");
    });

    it("uses custom chat predicates", () => {
        const link = makeLink("my-app://chat", "ch", "msg");
        const pattern = detectPattern(link, ["my-app://chat"]);
        assert.equal(pattern.type, "chat-message");
    });
});

// ---------------------------------------------------------------------------
// isSocialPattern
// ---------------------------------------------------------------------------

describe("isSocialPattern", () => {
    it("returns true for chat-message", () => {
        assert.equal(isSocialPattern({ type: "chat-message" }), true);
    });

    it("returns true for reply", () => {
        assert.equal(isSocialPattern({ type: "reply" }), true);
    });

    it("returns true for reaction", () => {
        assert.equal(isSocialPattern({ type: "reaction" }), true);
    });

    it("returns false for content", () => {
        assert.equal(isSocialPattern({ type: "content" }), false);
    });

    it("returns false for mention", () => {
        assert.equal(isSocialPattern({ type: "mention" }), false);
    });

    it("returns false for unknown", () => {
        assert.equal(isSocialPattern({ type: "unknown" }), false);
    });
});
