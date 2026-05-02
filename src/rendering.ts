/**
 * Kind-1 note rendering with NIP-10/27 markers.
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import type { LinkExpression } from "./types.js";
import type { UnsignedNostrEvent } from "./nostr-event.pure.js";
import { createTextNoteEvent } from "./nostr-event.pure.js";
import { detectPattern } from "./sdna.js";
import type { NostrSettings } from "./settings.js";
import {
    generateNoteContent,
    generateReplyTags,
    generateHashtagTags,
} from "./rendering.pure.js";
import { isoToUnix } from "./translate.pure.js";

/**
 * Render a LinkExpression as a kind-1 text note event, applying
 * SDNA pattern detection for proper NIP-10 threading.
 */
export function renderAsTextNote(
    link: LinkExpression,
    neighbourhoodId: string,
    settings: NostrSettings,
    resolvedContent?: string,
    replyToEventId?: string,
    replyToPubkey?: string,
): UnsignedNostrEvent | null {
    const chatPredicates = settings.rendering.chatPredicates;
    const pattern = detectPattern(link, chatPredicates);

    // Only render chat-message, reply, and content patterns as text notes
    if (
        pattern.type !== "chat-message" &&
        pattern.type !== "reply" &&
        pattern.type !== "content"
    ) {
        return null;
    }

    const content = generateNoteContent(link, resolvedContent);
    const createdAt = isoToUnix(link.timestamp);

    // Build the base event
    const event = createTextNoteEvent(
        content,
        neighbourhoodId,
        link.author,
        createdAt,
        replyToEventId,
        replyToPubkey,
    );

    // Add reply threading tags if this is a reply
    if (pattern.type === "reply" && replyToEventId) {
        const replyTags = generateReplyTags(
            undefined, // rootEventId — would need thread tracking
            replyToEventId,
            replyToPubkey,
        );
        event.tags.push(...replyTags);
    }

    // Add hashtag tags from content
    const hashtagTags = generateHashtagTags(content);
    event.tags.push(...hashtagTags);

    return event;
}

/**
 * Extract text content from a kind-1 note event for display.
 *
 * Returns the event content as-is (Nostr kind 1 content is plain text).
 */
export function extractNoteContent(content: string): string {
    return content;
}
