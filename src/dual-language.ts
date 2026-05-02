/**
 * Dual-language deduplication — origin tracking and federation filtering.
 *
 * When the Nostr Link Language operates alongside another sync language
 * (e.g. Holochain), we need to:
 * - Track which links originated from Nostr vs native
 * - Prevent echo loops (don't re-publish Nostr-origin links to Nostr)
 * - Deduplicate links arriving via multiple paths
 *
 * Spec §11.
 *
 * Pure functions — no ad4m:host imports.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkOrigin = "nostr" | "native" | "dual";

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Compute a canonical content key for dedup comparison.
 * Uses only the triple (source, predicate, target) — author/timestamp excluded.
 */
function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Check if a link is a duplicate of one already in the store.
 */
export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

// ---------------------------------------------------------------------------
// Origin tracking
// ---------------------------------------------------------------------------

/**
 * Build the storage key for tracking a link's origin.
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

// ---------------------------------------------------------------------------
// Federation filtering
// ---------------------------------------------------------------------------

/**
 * Determine if an outbound link should be federated to Nostr.
 *
 * Links that originated from Nostr should NOT be re-federated to avoid
 * echo loops. Only "native" or "dual" origin links should be federated.
 */
export function shouldFederate(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true; // New local commit — federate
    return origin !== "nostr"; // Skip if it came from Nostr
}

/**
 * Check if a predicate should be excluded from federation.
 */
export function isPredicateExcluded(
    predicate: string,
    excludePredicates: string[],
): boolean {
    return excludePredicates.includes(predicate);
}
