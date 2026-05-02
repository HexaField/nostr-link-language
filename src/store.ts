/**
 * Local link store — wraps the storage adapter KV API to maintain
 * a link store with indexes.
 *
 * Key scheme:
 *   links/{link-hash}                → serialized LinkExpression
 *   links-by-source/{source}/{hash}  → link-hash
 *   links-by-target/{target}/{hash}  → link-hash
 *   links-by-pred/{predicate}/{hash} → link-hash
 *   event-id/{link-hash}             → Nostr event ID
 *   event-link/{event-id}            → link-hash
 *   revision                         → last sync timestamp
 *   peers/{pubkey}                   → peer metadata JSON
 */

import type { StorageAdapter } from "./storage-interface.js";
import { getStorage } from "./storage-interface.js";
import { getRuntime } from "./runtime-interface.js";
import type { LinkExpression, PerspectiveDiff, Perspective } from "./types.js";

let _hashFn: ((data: string) => string) | null = null;

/**
 * Initialize the store module.
 */
export function initStore(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
}

function getHashFn(): (data: string) => string {
    if (_hashFn) return _hashFn;
    return getRuntime().hash;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function linkKey(linkHash: string): string {
    return `links/${linkHash}`;
}

function sourceIndexKey(source: string, linkHash: string): string {
    return `links-by-source/${source}/${linkHash}`;
}

function targetIndexKey(target: string, linkHash: string): string {
    return `links-by-target/${target}/${linkHash}`;
}

function predIndexKey(predicate: string, linkHash: string): string {
    return `links-by-pred/${predicate}/${linkHash}`;
}

function peerKey(pubkey: string): string {
    return `peers/${pubkey}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash for a LinkExpression.
 */
export function hashLink(link: LinkExpression): string {
    const content = JSON.stringify({
        source: link.data.source,
        predicate: link.data.predicate,
        target: link.data.target,
        author: link.author,
        timestamp: link.timestamp,
    });
    return getHashFn()(content);
}

/**
 * Store a single LinkExpression and update all indexes.
 */
export function putLink(link: LinkExpression): string {
    const h = hashLink(link);
    const storage = getStorage();
    storage.put(linkKey(h), JSON.stringify(link));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.put(sourceIndexKey(source, h), h);
    if (target) storage.put(targetIndexKey(target, h), h);
    if (predicate) storage.put(predIndexKey(predicate, h), h);

    return h;
}

/**
 * Remove a LinkExpression and its index entries.
 */
export function removeLink(link: LinkExpression): void {
    const h = hashLink(link);
    const storage = getStorage();
    storage.delete(linkKey(h));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.delete(sourceIndexKey(source, h));
    if (target) storage.delete(targetIndexKey(target, h));
    if (predicate) storage.delete(predIndexKey(predicate, h));
}

/**
 * Retrieve a link by its hash.
 */
export function getLink(linkHash: string): LinkExpression | null {
    const raw = getStorage().get(linkKey(linkHash));
    if (!raw) return null;
    return JSON.parse(raw) as LinkExpression;
}

/**
 * Apply a full PerspectiveDiff to the store.
 */
export function applyDiff(diff: PerspectiveDiff): void {
    for (const addition of diff.additions) {
        putLink(addition);
    }
    for (const removal of diff.removals) {
        removeLink(removal);
    }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface LinkQuery {
    source?: string;
    target?: string;
    predicate?: string;
}

/**
 * Query links by pattern.
 */
export function queryLinks(query: LinkQuery): LinkExpression[] {
    const { source, target, predicate } = query;
    const storage = getStorage();

    let candidateHashes: string[];

    if (source) {
        const keys = storage.listKeys(`links-by-source/${source}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (target) {
        const keys = storage.listKeys(`links-by-target/${target}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (predicate) {
        const keys = storage.listKeys(`links-by-pred/${predicate}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else {
        const keys = storage.listKeys("links/");
        candidateHashes = keys.map((k: string) => k.replace("links/", ""));
    }

    const results: LinkExpression[] = [];
    const seen = new Set<string>();

    for (const h of candidateHashes) {
        if (seen.has(h)) continue;
        seen.add(h);

        const link = getLink(h);
        if (!link) continue;

        if (source && link.data.source !== source) continue;
        if (target && link.data.target !== target) continue;
        if (predicate && link.data.predicate !== predicate) continue;

        results.push(link);
    }

    return results;
}

/**
 * Return all links in the store.
 */
export function allLinks(): Perspective {
    const keys = getStorage().listKeys("links/");
    const links: LinkExpression[] = [];

    for (const key of keys) {
        const raw = getStorage().get(key);
        if (raw) {
            links.push(JSON.parse(raw) as LinkExpression);
        }
    }

    return { links };
}

// ---------------------------------------------------------------------------
// Event ID ↔ Link Hash mapping
// ---------------------------------------------------------------------------

/**
 * Store the mapping between a link hash and its Nostr event ID.
 */
export function setEventId(linkHash: string, eventId: string): void {
    getStorage().put(`event-id/${linkHash}`, eventId);
    getStorage().put(`event-link/${eventId}`, linkHash);
}

/**
 * Get the Nostr event ID for a link hash.
 */
export function getEventId(linkHash: string): string | null {
    return getStorage().get(`event-id/${linkHash}`);
}

/**
 * Get the link hash for a Nostr event ID.
 */
export function getLinkHashByEventId(eventId: string): string | null {
    return getStorage().get(`event-link/${eventId}`);
}

// ---------------------------------------------------------------------------
// Revision tracking
// ---------------------------------------------------------------------------

const REVISION_KEY = "revision";

export function getRevision(): string | null {
    return getStorage().get(REVISION_KEY);
}

export function setRevision(rev: string): void {
    getStorage().put(REVISION_KEY, rev);
}

// ---------------------------------------------------------------------------
// Seen events (deduplication)
// ---------------------------------------------------------------------------

/**
 * Check if an event has been seen before.
 */
export function hasSeenEvent(eventId: string): boolean {
    return getStorage().get(`event:seen:${eventId}`) !== null;
}

/**
 * Mark an event as seen.
 */
export function markEventSeen(eventId: string): void {
    getStorage().put(`event:seen:${eventId}`, "1");
}

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

export function setPeer(pubkey: string, metadata: Record<string, unknown> = {}): void {
    getStorage().put(peerKey(pubkey), JSON.stringify(metadata));
}

export function removePeer(pubkey: string): void {
    getStorage().delete(peerKey(pubkey));
}

export function listPeers(prefix: string = "peers/"): string[] {
    const keys = getStorage().listKeys(prefix);
    return keys.map((k: string) => k.replace(prefix, ""));
}

export function getPeerMetadata(pubkey: string): Record<string, unknown> | null {
    const raw = getStorage().get(peerKey(pubkey));
    if (!raw) return null;
    return JSON.parse(raw);
}
