# Nostr Link Language for AD4M

AD4M link language that syncs Perspective triples to Nostr relays via kind:30078 parameterized replaceable events.

## What It Does

- **Commits:** links → NIP-01 events signed with BIP-340 Schnorr, published to relays
- **Sync:** subscribes to relay feeds for new events → local links
- **Query:** indexed local store (source, target, predicate)
- **Native WebSocket:** direct Deno WebSocket connections to relays (no httpFetch)
- **Cryptographic signing:** BIP-340 Schnorr signatures via `@noble/curves`
- **Telepresence:** real-time presence via ephemeral events (kind 20042-20044, NIP-16), peer signalling and broadcast over WebSocket subscriptions

## Template Variables

| Variable | Description |
|----------|-------------|
| `NOSTR_RELAY_URLS` | Comma-separated relay WebSocket URLs |
| `NOSTR_NEIGHBOURHOOD_ID` | Neighbourhood identifier (event `d` tag) |
| `NOSTR_PUBKEY` | Hex-encoded public key |
| `NOSTR_PRIVKEY` | Hex-encoded private key |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

268 tests across 11 suites.

## Architecture

Same [pure/impure pattern](https://github.com/HexaField/ad4m-link-language-template) as all AD4M link languages. Protocol-specific modules:

- `src/crypto.ts` / `crypto.pure.ts` — BIP-340 Schnorr signing via `@noble/curves`
- `src/nostr-event.ts` / `nostr-event.pure.ts` — NIP-01 event construction + verification
- `src/relay.ts` / `relay.pure.ts` — WebSocket relay connection management
- `src/rendering.ts` / `rendering.pure.ts` — link rendering
- `src/translate.ts` / `translate.pure.ts` — link ↔ Nostr event translation
- `src/dual-language.ts` — dual-language support
- `src/sdna.ts` — social DNA definitions
- `src/settings.ts` — language settings
- `src/sync.ts` — sync orchestration

`ad4m:host` imports confined to 4 adapter files + `index.ts`.

## License

CAL-1.0
