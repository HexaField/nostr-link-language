/**
 * Tests for SHA-256, hex encoding, and crypto helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    bytesToHex,
    hexToBytes,
    isValidHex,
    sha256Hex,
    sha256,
    simpleHash,
} from "../src/crypto.pure.js";

// ---------------------------------------------------------------------------
// bytesToHex
// ---------------------------------------------------------------------------

describe("bytesToHex", () => {
    it("converts empty array", () => {
        assert.equal(bytesToHex(new Uint8Array([])), "");
    });

    it("converts single byte", () => {
        assert.equal(bytesToHex(new Uint8Array([0])), "00");
        assert.equal(bytesToHex(new Uint8Array([255])), "ff");
        assert.equal(bytesToHex(new Uint8Array([16])), "10");
    });

    it("converts multiple bytes", () => {
        assert.equal(bytesToHex(new Uint8Array([1, 2, 3])), "010203");
        assert.equal(bytesToHex(new Uint8Array([0xab, 0xcd, 0xef])), "abcdef");
    });

    it("produces lowercase hex", () => {
        const result = bytesToHex(new Uint8Array([0xAB, 0xCD]));
        assert.equal(result, "abcd");
    });
});

// ---------------------------------------------------------------------------
// hexToBytes
// ---------------------------------------------------------------------------

describe("hexToBytes", () => {
    it("converts empty string", () => {
        assert.deepEqual(hexToBytes(""), new Uint8Array([]));
    });

    it("converts single byte", () => {
        assert.deepEqual(hexToBytes("00"), new Uint8Array([0]));
        assert.deepEqual(hexToBytes("ff"), new Uint8Array([255]));
    });

    it("converts multiple bytes", () => {
        assert.deepEqual(hexToBytes("010203"), new Uint8Array([1, 2, 3]));
    });

    it("round-trips with bytesToHex", () => {
        const original = new Uint8Array([0, 128, 255, 1, 42]);
        assert.deepEqual(hexToBytes(bytesToHex(original)), original);
    });
});

// ---------------------------------------------------------------------------
// isValidHex
// ---------------------------------------------------------------------------

describe("isValidHex", () => {
    it("validates lowercase hex strings", () => {
        assert.equal(isValidHex("abcdef0123456789"), true);
    });

    it("rejects uppercase hex", () => {
        assert.equal(isValidHex("ABCDEF"), false);
    });

    it("rejects non-hex characters", () => {
        assert.equal(isValidHex("ghijkl"), false);
        assert.equal(isValidHex("xyz"), false);
    });

    it("validates with expected byte length", () => {
        assert.equal(isValidHex("aa".repeat(32), 32), true);
        assert.equal(isValidHex("aa".repeat(32), 64), false);
    });

    it("rejects non-strings", () => {
        assert.equal(isValidHex(123 as any), false);
        assert.equal(isValidHex(null as any), false);
    });

    it("handles empty string", () => {
        assert.equal(isValidHex(""), true);
        assert.equal(isValidHex("", 0), true);
        assert.equal(isValidHex("", 1), false);
    });
});

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
    it("computes correct SHA-256 for empty string", async () => {
        const hash = await sha256Hex("");
        assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("computes correct SHA-256 for 'hello'", async () => {
        const hash = await sha256Hex("hello");
        assert.equal(hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    it("is deterministic", async () => {
        const h1 = await sha256Hex("test input");
        const h2 = await sha256Hex("test input");
        assert.equal(h1, h2);
    });

    it("produces 64-char lowercase hex", async () => {
        const hash = await sha256Hex("anything");
        assert.equal(hash.length, 64);
        assert.ok(/^[0-9a-f]{64}$/.test(hash));
    });

    it("produces different hashes for different inputs", async () => {
        const h1 = await sha256Hex("input1");
        const h2 = await sha256Hex("input2");
        assert.notEqual(h1, h2);
    });
});

// ---------------------------------------------------------------------------
// sha256 (Uint8Array)
// ---------------------------------------------------------------------------

describe("sha256", () => {
    it("computes SHA-256 of Uint8Array", async () => {
        const input = new TextEncoder().encode("hello");
        const hash = await sha256(input);
        assert.equal(hash.length, 32);
        assert.ok(hash instanceof Uint8Array);
    });

    it("matches sha256Hex for same input", async () => {
        const input = "test";
        const hexHash = await sha256Hex(input);
        const bytesHash = await sha256(new TextEncoder().encode(input));
        assert.equal(bytesToHex(bytesHash), hexHash);
    });
});

// ---------------------------------------------------------------------------
// simpleHash
// ---------------------------------------------------------------------------

describe("simpleHash", () => {
    it("produces deterministic output", () => {
        assert.equal(simpleHash("test"), simpleHash("test"));
    });

    it("produces different output for different inputs", () => {
        assert.notEqual(simpleHash("a"), simpleHash("b"));
    });

    it("produces 8-char hex string", () => {
        const hash = simpleHash("anything");
        assert.equal(hash.length, 8);
        assert.ok(/^[0-9a-f]{8}$/.test(hash));
    });

    it("handles empty string", () => {
        const hash = simpleHash("");
        assert.equal(hash.length, 8);
    });

    it("handles unicode", () => {
        const hash = simpleHash("日本語");
        assert.equal(hash.length, 8);
        assert.ok(/^[0-9a-f]{8}$/.test(hash));
    });
});
