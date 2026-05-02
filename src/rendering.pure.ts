/**
 * Pure kind-1 note text and tag generation.
 *
 * Zero runtime deps. Handles NIP-10 reply threading and NIP-27 mentions.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Note content generation
// ---------------------------------------------------------------------------

/**
 * Generate plain text content for a kind-1 note from a link.
 *
 * For chat messages: use resolved content or raw target.
 * For replies: prefix with threading context.
 */
export function generateNoteContent(
    link: LinkExpression,
    resolvedContent?: string,
): string {
    const target = link.data.target || "";
    return resolvedContent || target;
}

/**
 * Generate NIP-10 tags for reply threading.
 *
 * NIP-10 markers:
 * - ["e", <root-event-id>, <relay>, "root"] — root of thread
 * - ["e", <reply-event-id>, <relay>, "reply"] — direct parent
 * - ["p", <pubkey>] — pubkey of parent author
 */
export function generateReplyTags(
    rootEventId?: string,
    replyToEventId?: string,
    replyToPubkey?: string,
    relayHint?: string,
): string[][] {
    const tags: string[][] = [];
    const relay = relayHint || "";

    if (rootEventId && replyToEventId && rootEventId !== replyToEventId) {
        // Thread with distinct root and reply-to
        tags.push(["e", rootEventId, relay, "root"]);
        tags.push(["e", replyToEventId, relay, "reply"]);
    } else if (replyToEventId) {
        // Direct reply (reply-to is root)
        tags.push(["e", replyToEventId, relay, "reply"]);
    }

    if (replyToPubkey) {
        tags.push(["p", replyToPubkey]);
    }

    return tags;
}

/**
 * Generate NIP-27 mention references in note content.
 *
 * Replaces DID references with nostr: URI mentions.
 */
export function applyMentions(
    content: string,
    mentions: Array<{ did: string; pubkey: string }>,
): string {
    let result = content;
    for (const mention of mentions) {
        // Replace did:key references with nostr:npub references
        result = result.replace(
            new RegExp(escapeRegex(mention.did), "g"),
            `nostr:${mention.pubkey}`,
        );
    }
    return result;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract hashtags from content text.
 */
export function extractHashtags(content: string): string[] {
    const matches = content.match(/#[a-zA-Z0-9_]+/g);
    if (!matches) return [];
    return [...new Set(matches.map(m => m.substring(1).toLowerCase()))];
}

/**
 * Generate hashtag tags for a note.
 */
export function generateHashtagTags(content: string): string[][] {
    return extractHashtags(content).map(tag => ["t", tag]);
}
