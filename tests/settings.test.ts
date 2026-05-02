/**
 * Tests for the settings parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import type { NostrSettings } from "../src/settings.js";

// ---------------------------------------------------------------------------
// parseSettings
// ---------------------------------------------------------------------------

describe("parseSettings", () => {
    it("returns defaults for null input", () => {
        const result = parseSettings(null);
        assert.deepEqual(result.syncMode, DEFAULT_SETTINGS.syncMode);
        assert.deepEqual(result.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
    });

    it("returns defaults for undefined input", () => {
        const result = parseSettings(undefined);
        assert.deepEqual(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("returns defaults for empty string", () => {
        const result = parseSettings("");
        assert.deepEqual(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("returns defaults for invalid JSON", () => {
        const result = parseSettings("not json");
        assert.deepEqual(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("parses valid complete settings", () => {
        const input: NostrSettings = {
            syncMode: "publish-only",
            rendering: {
                strategy: "native",
                chatPredicates: ["custom://chat"],
                resolveContent: false,
            },
            relays: {
                read: ["wss://relay1.com"],
                write: ["wss://relay2.com"],
                reconnectBaseMs: 2000,
                reconnectMaxMs: 60000,
                maxConnections: 4,
            },
            filter: {
                kinds: [30078, 1],
                acceptExternalEvents: false,
            },
            membership: "pubkey-list",
            dualLanguage: {
                enabled: true,
                excludePredicates: ["system://internal"],
            },
        };

        const result = parseSettings(JSON.stringify(input));
        assert.equal(result.syncMode, "publish-only");
        assert.equal(result.rendering.strategy, "native");
        assert.deepEqual(result.rendering.chatPredicates, ["custom://chat"]);
        assert.equal(result.rendering.resolveContent, false);
        assert.deepEqual(result.relays.read, ["wss://relay1.com"]);
        assert.deepEqual(result.relays.write, ["wss://relay2.com"]);
        assert.equal(result.relays.reconnectBaseMs, 2000);
        assert.equal(result.relays.reconnectMaxMs, 60000);
        assert.equal(result.relays.maxConnections, 4);
        assert.deepEqual(result.filter.kinds, [30078, 1]);
        assert.equal(result.filter.acceptExternalEvents, false);
        assert.equal(result.membership, "pubkey-list");
        assert.equal(result.dualLanguage.enabled, true);
        assert.deepEqual(result.dualLanguage.excludePredicates, ["system://internal"]);
    });

    it("uses defaults for missing fields", () => {
        const result = parseSettings(JSON.stringify({ syncMode: "subscribe-only" }));
        assert.equal(result.syncMode, "subscribe-only");
        assert.equal(result.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
        assert.deepEqual(result.relays.read, DEFAULT_SETTINGS.relays.read);
    });

    it("ignores invalid syncMode", () => {
        const result = parseSettings(JSON.stringify({ syncMode: "invalid" }));
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("ignores invalid rendering strategy", () => {
        const result = parseSettings(JSON.stringify({
            rendering: { strategy: "invalid" },
        }));
        assert.equal(result.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
    });

    it("ignores invalid membership", () => {
        const result = parseSettings(JSON.stringify({ membership: "invalid" }));
        assert.equal(result.membership, DEFAULT_SETTINGS.membership);
    });

    it("handles non-array chatPredicates", () => {
        const result = parseSettings(JSON.stringify({
            rendering: { chatPredicates: "not-an-array" },
        }));
        assert.deepEqual(result.rendering.chatPredicates, DEFAULT_SETTINGS.rendering.chatPredicates);
    });

    it("handles negative reconnect values", () => {
        const result = parseSettings(JSON.stringify({
            relays: { reconnectBaseMs: -100, reconnectMaxMs: 0 },
        }));
        assert.equal(result.relays.reconnectBaseMs, DEFAULT_SETTINGS.relays.reconnectBaseMs);
        assert.equal(result.relays.reconnectMaxMs, DEFAULT_SETTINGS.relays.reconnectMaxMs);
    });

    it("handles non-boolean resolveContent", () => {
        const result = parseSettings(JSON.stringify({
            rendering: { resolveContent: "yes" },
        }));
        assert.equal(result.rendering.resolveContent, DEFAULT_SETTINGS.rendering.resolveContent);
    });

    it("handles non-boolean dualLanguage.enabled", () => {
        const result = parseSettings(JSON.stringify({
            dualLanguage: { enabled: "yes" },
        }));
        assert.equal(result.dualLanguage.enabled, DEFAULT_SETTINGS.dualLanguage.enabled);
    });

    it("handles empty object", () => {
        const result = parseSettings("{}");
        assert.equal(result.syncMode, DEFAULT_SETTINGS.syncMode);
        assert.equal(result.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
        assert.equal(result.membership, DEFAULT_SETTINGS.membership);
    });
});

// ---------------------------------------------------------------------------
// DEFAULT_SETTINGS
// ---------------------------------------------------------------------------

describe("DEFAULT_SETTINGS", () => {
    it("has bidirectional sync mode", () => {
        assert.equal(DEFAULT_SETTINGS.syncMode, "bidirectional");
    });

    it("has dual rendering strategy", () => {
        assert.equal(DEFAULT_SETTINGS.rendering.strategy, "dual");
    });

    it("has expected chat predicates", () => {
        assert.ok(DEFAULT_SETTINGS.rendering.chatPredicates.includes("flux://has_message"));
        assert.ok(DEFAULT_SETTINGS.rendering.chatPredicates.includes("sioc://content_of"));
    });

    it("has open membership", () => {
        assert.equal(DEFAULT_SETTINGS.membership, "open");
    });

    it("has expected default kinds", () => {
        assert.deepEqual(DEFAULT_SETTINGS.filter.kinds, [30078, 1, 5, 7]);
    });

    it("has disabled dual-language by default", () => {
        assert.equal(DEFAULT_SETTINGS.dualLanguage.enabled, false);
    });
});
