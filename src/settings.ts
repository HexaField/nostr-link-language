/**
 * Settings for the Nostr Link Language.
 *
 * Parsed from the JSON string returned by `languageSettings()` at
 * runtime. Provides sensible defaults.
 *
 * Spec §10.
 */

export interface RenderingSettings {
    /** Which event kinds to create alongside triple events:
     *  "native" = only kind 30078,
     *  "social" = only kind 1/7/6,
     *  "dual" = both triple + social events. */
    strategy: "native" | "social" | "dual";
    /** Predicates treated as chat messages for Kind 1 rendering. */
    chatPredicates: string[];
    /** Whether to resolve expression URIs for content. */
    resolveContent: boolean;
}

export interface RelaySettings {
    /** Additional read relays (merged with template var). */
    read: string[];
    /** Additional write relays (merged with template var). */
    write: string[];
    /** Reconnect backoff base (ms). */
    reconnectBaseMs: number;
    /** Max reconnect backoff (ms). */
    reconnectMaxMs: number;
    /** Max concurrent relay connections. */
    maxConnections: number;
}

export interface FilterSettings {
    /** Event kinds to subscribe to. */
    kinds: number[];
    /** Whether to accept events from non-AD4M Nostr users. */
    acceptExternalEvents: boolean;
}

export interface DualLanguageSettings {
    /** Enable dual-language origin tracking. */
    enabled: boolean;
    /** Predicates to exclude from federation. */
    excludePredicates: string[];
}

export type SyncMode = "bidirectional" | "publish-only" | "subscribe-only";
export type MembershipMode = "open" | "pubkey-list";

export interface NostrSettings {
    syncMode: SyncMode;
    rendering: RenderingSettings;
    relays: RelaySettings;
    filter: FilterSettings;
    membership: MembershipMode;
    dualLanguage: DualLanguageSettings;
}

/** Default settings — sensible defaults for bidirectional Nostr sync. */
export const DEFAULT_SETTINGS: NostrSettings = {
    syncMode: "bidirectional",
    rendering: {
        strategy: "dual",
        chatPredicates: ["flux://has_message", "sioc://content_of"],
        resolveContent: true,
    },
    relays: {
        read: [],
        write: [],
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30000,
        maxConnections: 8,
    },
    filter: {
        kinds: [30078, 1, 5, 7],
        acceptExternalEvents: true,
    },
    membership: "open",
    dualLanguage: {
        enabled: false,
        excludePredicates: [],
    },
};

/**
 * Parse settings from a raw JSON string, falling back to defaults
 * for any missing or invalid fields.
 */
export function parseSettings(raw: string | null | undefined): NostrSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(raw);
        return {
            syncMode: ["bidirectional", "publish-only", "subscribe-only"].includes(parsed?.syncMode)
                ? parsed.syncMode
                : DEFAULT_SETTINGS.syncMode,
            rendering: {
                strategy: ["native", "social", "dual"].includes(parsed?.rendering?.strategy)
                    ? parsed.rendering.strategy
                    : DEFAULT_SETTINGS.rendering.strategy,
                chatPredicates: Array.isArray(parsed?.rendering?.chatPredicates)
                    ? parsed.rendering.chatPredicates
                    : DEFAULT_SETTINGS.rendering.chatPredicates,
                resolveContent: typeof parsed?.rendering?.resolveContent === "boolean"
                    ? parsed.rendering.resolveContent
                    : DEFAULT_SETTINGS.rendering.resolveContent,
            },
            relays: {
                read: Array.isArray(parsed?.relays?.read)
                    ? parsed.relays.read
                    : DEFAULT_SETTINGS.relays.read,
                write: Array.isArray(parsed?.relays?.write)
                    ? parsed.relays.write
                    : DEFAULT_SETTINGS.relays.write,
                reconnectBaseMs: typeof parsed?.relays?.reconnectBaseMs === "number" && parsed.relays.reconnectBaseMs > 0
                    ? parsed.relays.reconnectBaseMs
                    : DEFAULT_SETTINGS.relays.reconnectBaseMs,
                reconnectMaxMs: typeof parsed?.relays?.reconnectMaxMs === "number" && parsed.relays.reconnectMaxMs > 0
                    ? parsed.relays.reconnectMaxMs
                    : DEFAULT_SETTINGS.relays.reconnectMaxMs,
                maxConnections: typeof parsed?.relays?.maxConnections === "number" && parsed.relays.maxConnections > 0
                    ? parsed.relays.maxConnections
                    : DEFAULT_SETTINGS.relays.maxConnections,
            },
            filter: {
                kinds: Array.isArray(parsed?.filter?.kinds)
                    ? parsed.filter.kinds
                    : DEFAULT_SETTINGS.filter.kinds,
                acceptExternalEvents: typeof parsed?.filter?.acceptExternalEvents === "boolean"
                    ? parsed.filter.acceptExternalEvents
                    : DEFAULT_SETTINGS.filter.acceptExternalEvents,
            },
            membership: ["open", "pubkey-list"].includes(parsed?.membership)
                ? parsed.membership
                : DEFAULT_SETTINGS.membership,
            dualLanguage: {
                enabled: typeof parsed?.dualLanguage?.enabled === "boolean"
                    ? parsed.dualLanguage.enabled
                    : DEFAULT_SETTINGS.dualLanguage.enabled,
                excludePredicates: Array.isArray(parsed?.dualLanguage?.excludePredicates)
                    ? parsed.dualLanguage.excludePredicates
                    : DEFAULT_SETTINGS.dualLanguage.excludePredicates,
            },
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}
