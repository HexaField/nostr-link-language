/**
 * Signing adapter interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 *
 * Note: AD4M uses Ed25519. Nostr uses secp256k1 Schnorr.
 * The signing adapter here wraps the AD4M signing for general use;
 * Nostr-specific secp256k1 signing is handled by the crypto module.
 */

export interface SigningAdapter {
    /** Sign a string payload and return the hex-encoded signature. */
    signStringHex(payload: string): string;
    /** Return the signing key ID. */
    signingKeyId(): string;
}

let _signing: SigningAdapter | null = null;

export function initSigning(adapter: SigningAdapter): void {
    _signing = adapter;
}

export function getSigning(): SigningAdapter {
    if (!_signing) {
        throw new Error(
            "SigningAdapter not initialized. Call initSigning() during language init().",
        );
    }
    return _signing;
}
