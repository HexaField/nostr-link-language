/**
 * Tests for relay message builders and parsers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildEventMessage,
    buildReqMessage,
    buildCloseMessage,
    parseRelayMessage,
    buildNeighbourhoodFilter,
    generateSubscriptionId,
} from "../src/relay.pure.js";

import type { SignedNostrEvent, NostrFilter } from "../src/nostr-event.pure.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(): SignedNostrEvent {
    return {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: 1714650000,
        kind: 1,
        tags: [["t", "ad4m"]],
        content: "Hello",
        sig: "c".repeat(128),
    };
}

// ---------------------------------------------------------------------------
// buildEventMessage
// ---------------------------------------------------------------------------

describe("buildEventMessage", () => {
    it("produces valid EVENT message", () => {
        const event = makeEvent();
        const msg = buildEventMessage(event);
        const parsed = JSON.parse(msg);

        assert.equal(parsed[0], "EVENT");
        assert.equal(parsed[1].id, event.id);
        assert.equal(parsed[1].kind, 1);
    });

    it("is valid JSON", () => {
        const msg = buildEventMessage(makeEvent());
        assert.doesNotThrow(() => JSON.parse(msg));
    });
});

// ---------------------------------------------------------------------------
// buildReqMessage
// ---------------------------------------------------------------------------

describe("buildReqMessage", () => {
    it("produces valid REQ message with single filter", () => {
        const filter: NostrFilter = { kinds: [30078], "#ad4m:neighbourhood": ["Qm123"] };
        const msg = buildReqMessage("sub-1", filter);
        const parsed = JSON.parse(msg);

        assert.equal(parsed[0], "REQ");
        assert.equal(parsed[1], "sub-1");
        assert.deepEqual(parsed[2].kinds, [30078]);
    });

    it("supports multiple filters", () => {
        const f1: NostrFilter = { kinds: [30078] };
        const f2: NostrFilter = { kinds: [1, 7] };
        const msg = buildReqMessage("sub-2", f1, f2);
        const parsed = JSON.parse(msg);

        assert.equal(parsed.length, 4); // REQ, sub-id, filter1, filter2
        assert.deepEqual(parsed[2].kinds, [30078]);
        assert.deepEqual(parsed[3].kinds, [1, 7]);
    });

    it("includes since when specified", () => {
        const filter: NostrFilter = { kinds: [1], since: 1000 };
        const msg = buildReqMessage("sub-3", filter);
        const parsed = JSON.parse(msg);
        assert.equal(parsed[2].since, 1000);
    });
});

// ---------------------------------------------------------------------------
// buildCloseMessage
// ---------------------------------------------------------------------------

describe("buildCloseMessage", () => {
    it("produces valid CLOSE message", () => {
        const msg = buildCloseMessage("sub-1");
        const parsed = JSON.parse(msg);

        assert.equal(parsed[0], "CLOSE");
        assert.equal(parsed[1], "sub-1");
    });
});

// ---------------------------------------------------------------------------
// parseRelayMessage
// ---------------------------------------------------------------------------

describe("parseRelayMessage", () => {
    it("parses EVENT message", () => {
        const event = makeEvent();
        const raw = JSON.stringify(["EVENT", "sub-1", event]);
        const msg = parseRelayMessage(raw);

        assert.ok(msg);
        assert.equal(msg!.type, "EVENT");
        if (msg!.type === "EVENT") {
            assert.equal(msg.subscriptionId, "sub-1");
            assert.equal(msg.event.id, event.id);
        }
    });

    it("parses OK message (accepted)", () => {
        const raw = JSON.stringify(["OK", "event-id-123", true, ""]);
        const msg = parseRelayMessage(raw);

        assert.ok(msg);
        assert.equal(msg!.type, "OK");
        if (msg!.type === "OK") {
            assert.equal(msg.eventId, "event-id-123");
            assert.equal(msg.accepted, true);
            assert.equal(msg.message, "");
        }
    });

    it("parses OK message (rejected)", () => {
        const raw = JSON.stringify(["OK", "eid", false, "duplicate: already have this event"]);
        const msg = parseRelayMessage(raw);

        assert.ok(msg);
        if (msg!.type === "OK") {
            assert.equal(msg.accepted, false);
            assert.ok(msg.message.includes("duplicate"));
        }
    });

    it("parses EOSE message", () => {
        const raw = JSON.stringify(["EOSE", "sub-1"]);
        const msg = parseRelayMessage(raw);

        assert.ok(msg);
        assert.equal(msg!.type, "EOSE");
        if (msg!.type === "EOSE") {
            assert.equal(msg.subscriptionId, "sub-1");
        }
    });

    it("parses NOTICE message", () => {
        const raw = JSON.stringify(["NOTICE", "rate limited"]);
        const msg = parseRelayMessage(raw);

        assert.ok(msg);
        assert.equal(msg!.type, "NOTICE");
        if (msg!.type === "NOTICE") {
            assert.equal(msg.message, "rate limited");
        }
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseRelayMessage("not json"), null);
    });

    it("returns null for non-array JSON", () => {
        assert.equal(parseRelayMessage('{"type": "EVENT"}'), null);
    });

    it("returns null for too-short array", () => {
        assert.equal(parseRelayMessage('["EVENT"]'), null);
    });

    it("parses unknown message types", () => {
        const raw = JSON.stringify(["AUTH", "challenge-string"]);
        const msg = parseRelayMessage(raw);

        assert.ok(msg);
        assert.equal(msg!.type, "UNKNOWN");
    });
});

// ---------------------------------------------------------------------------
// buildNeighbourhoodFilter
// ---------------------------------------------------------------------------

describe("buildNeighbourhoodFilter", () => {
    it("builds filter with kinds and neighbourhood tag", () => {
        const filter = buildNeighbourhoodFilter("Qm123abc", [30078, 1, 5, 7]);

        assert.deepEqual(filter.kinds, [30078, 1, 5, 7]);
        assert.deepEqual(filter["#ad4m:neighbourhood"], ["Qm123abc"]);
    });

    it("includes since when provided", () => {
        const filter = buildNeighbourhoodFilter("Qm123", [30078], 1000);
        assert.equal(filter.since, 1000);
    });

    it("omits since when undefined", () => {
        const filter = buildNeighbourhoodFilter("Qm123", [30078]);
        assert.equal(filter.since, undefined);
    });
});

// ---------------------------------------------------------------------------
// generateSubscriptionId
// ---------------------------------------------------------------------------

describe("generateSubscriptionId", () => {
    it("generates a unique ID", () => {
        const id1 = generateSubscriptionId();
        const id2 = generateSubscriptionId();
        assert.notEqual(id1, id2);
    });

    it("uses the prefix", () => {
        const id = generateSubscriptionId("test");
        assert.ok(id.startsWith("test:"));
    });

    it("defaults to ad4m prefix", () => {
        const id = generateSubscriptionId();
        assert.ok(id.startsWith("ad4m:"));
    });
});
