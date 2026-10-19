# cerberus-e2e

Fixture based end to end tests for the five Cerberus chambers, driven in order with no
network: identity, trust score, intent, SOUL handshake, session token.

42 cases on `node:test` and `tsx`. Every chamber has at least one refusing case, and the
session token is checked for expiry, tampering, a forged secret and an over-long window.

```bash
npm install
npm test
```

## What the suite drives

`runChambers(bundle, clock, secret)` walks the five chambers in order and stops at the
first refusal, reporting which chambers were reached:

```ts
const result = runChambers(bundle, clock, secret);
// { reached: ["identity","trust","intent","soul","session"], failedAt: null, reason: null }
```

A refusal returns `{ ok: false, chamber, reason }` where `chamber` names the chamber that
said no. Nothing throws on a bad bundle: a refusal is a value, so a caller can log it.

## The five chambers

| Chamber | Refuses when |
| --- | --- |
| identity | no listing, revoked listing, challenge for another agent, signer is not the owner, signature is not 64 bytes, challenge expired, challenge expires before issue |
| trust | no record, negative or non-numeric field, more disputes lost than jobs completed |
| intent | undeclared skill, price above the declared maximum, price at or below zero, rail not offered |
| soul | no SOUL, hash mismatch, missing law, nonce not echoed, nonce shorter than 16 characters |
| session | no token, expired, tampered claim, forged secret, window longer than the ttl, issued in the future |

## Trust ceiling is applied last

An agent with zero tested deliveries is capped at 39 and lands in `bronze`, whatever its age
or job count. The cap is applied after the blend, so no combination of fields lifts it. The
suite asserts the exact score for the fixture record (27) and asserts a strong record clears
the ceiling.

## Fixtures are JSON

`fixtures/happy.json` holds one complete bundle: a listing, a challenge, a trust record, a
capability declaration, an intent, a SOUL document, a handshake and a session token whose
MAC was computed for the fixed clock. Refusal cases are built by patching that bundle, so
the JSON stays the single source of truth.

## Interface note

The job spec says the chamber functions are provided as interfaces in the spec bundle. They
are not in this repository, so `src/chambers.ts` is a reference implementation of those
interfaces. Pointing the suite at the real bundle means swapping that one module: the tests
import only from `../src/chambers.js` and never reach into the reference internals.

## Mutation check

Replacing the session MAC comparison with `false` fails 2 cases (tampered claim and forged
secret). Restoring it returns 42 passing.

## House rules

Latin digits, no long dashes, no secrets, no network, deterministic clock injected.

## License

MIT
