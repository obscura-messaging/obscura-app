# Conformance vectors

The vector files are normative for the cases they cover. Both kits load them in
their unit suites.

## `wire.json`

Checked against each kit's `WireCodec` (`WireConformanceTest.kt`,
`WireConformanceTests.swift`).

| Array | Checks |
|---|---|
| `messageTypes` | `ClientMessage.payload` arm ↔ app-facing kind |
| `typingStates` | `TypingSignal.state` ↔ app-facing state |
| `roundTrip` | `AppEntry` encode/decode preserves values (JSON compared by value, not bytes) |

## `link.json`

Device linking. Byte strings are lowercase hex; the file's `description` states
the derivation and key formats.

| Array | Checks |
|---|---|
| `envelopes` | Each side's private key gives its public key and `sharedSecret` with the other's public key; HKDF gives `key`; sealing `plaintext` with `key` and `nonce` gives `ciphertext` exactly, and opening it gives `plaintext`; `plaintext` decodes to `linkBundle`; `identityKeyPair` deserializes to `identityPrivateKey`/`identityPublicKey`, and that pair serializes back to it; `linkEnvelope` decodes to the primary public key, nonce and ciphertext |
| `linkCodes` | `code` decodes to the fields; encoding the fields and decoding the result gives them back |

## Validation

`validate.py` (`just protocol-vectors`) checks only well-formedness: strict
JSON, required keys, no unregistered files, and that each file is referenced
from `docs/KIT_API.md`. A new vector file must be registered in `validate.py`.

Rules:

- Change a cross-platform encoding → add or update a vector and both kit suites
  in the same change.
- Keep application model fixtures out; app routing and merge are tested in
  `obscura-app`.
