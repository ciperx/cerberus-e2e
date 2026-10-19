import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  chamberIdentity,
  chamberIntent,
  chamberSession,
  chamberSoul,
  chamberTrust,
  issueSession,
  runChambers,
  sessionMac,
  SESSION_TTL_SECONDS,
  UNPROVEN_CEILING,
  type CapabilityDeclaration,
  type ChamberBundle,
  type Clock,
  type IdentityChallenge,
  type IntentRequest,
  type ListingRecord,
  type SessionToken,
  type SoulDocument,
  type SoulHandshake,
  type TrustRecord,
} from "../src/chambers.js";

interface Fixture {
  clock_iso: string;
  clock_epoch: number;
  secret: string;
  listing: ListingRecord;
  challenge: IdentityChallenge;
  trust_record: TrustRecord;
  declarations: CapabilityDeclaration[];
  intent: IntentRequest;
  soul: SoulDocument;
  handshake: SoulHandshake;
  session: SessionToken;
}

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/happy.json", import.meta.url), "utf8"),
) as Fixture;

const clock: Clock = { now: () => fixture.clock_epoch * 1000 };
const secret = fixture.secret;

function bundle(patch: Partial<ChamberBundle> = {}): ChamberBundle {
  return {
    listing: fixture.listing,
    challenge: fixture.challenge,
    trustRecord: fixture.trust_record,
    declarations: fixture.declarations,
    intent: fixture.intent,
    soul: fixture.soul,
    handshake: fixture.handshake,
    session: fixture.session,
    ...patch,
  };
}

const at = (epochSeconds: number): Clock => ({ now: () => epochSeconds * 1000 });

/* ------------------------------------------------------------ chamber 1: identity */

test("identity passes for a live challenge signed by the listing owner", () => {
  const verdict = chamberIdentity(fixture.listing, fixture.challenge, clock);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.value.offer_id, fixture.listing.offer_id);
});

test("identity refuses when there is no listing", () => {
  const verdict = chamberIdentity(undefined, fixture.challenge, clock);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.chamber, "identity");
    assert.match(verdict.reason, /no listing/);
  }
});

test("identity refuses a revoked listing", () => {
  const listing = { ...fixture.listing, revoked_at: "2026-10-19T12:00:00Z" };
  const verdict = chamberIdentity(listing, fixture.challenge, clock);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /revoked/);
});

test("identity refuses a challenge for a different agent", () => {
  const challenge = { ...fixture.challenge, agent_did: "did:key:z6Mkother" };
  const verdict = chamberIdentity(fixture.listing, challenge, clock);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /different agent/);
});

test("identity refuses a signer that is not the owner", () => {
  const challenge = { ...fixture.challenge, signer: "0x1111111111111111111111111111111111111111" };
  const verdict = chamberIdentity(fixture.listing, challenge, clock);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /not the listing owner/);
});

test("identity refuses a short signature", () => {
  const challenge = { ...fixture.challenge, signature: "0xabcd" };
  const verdict = chamberIdentity(fixture.listing, challenge, clock);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /64 bytes/);
});

test("identity refuses an expired challenge", () => {
  const verdict = chamberIdentity(fixture.listing, fixture.challenge, at(fixture.clock_epoch + 3600));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /expired/);
});

test("identity refuses a challenge that expires before it was issued", () => {
  const challenge = { ...fixture.challenge, expires_at: "2026-10-19T14:00:00Z" };
  const verdict = chamberIdentity(fixture.listing, challenge, clock);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /before it was issued/);
});

/* --------------------------------------------------------------- chamber 2: trust */

test("trust scores the fixture record by the documented formula", () => {
  const verdict = chamberTrust(fixture.trust_record);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    // age 200 * 0.05 = 10, jobs 12 * 1.0 = 12, tested 6 * 0.8 = 4.8, no penalty
    assert.equal(verdict.value.score, 27);
    assert.equal(verdict.value.tier, "bronze");
    assert.equal(verdict.value.reasons.length, 4);
  }
});

test("trust scores a strong record above the unproven ceiling", () => {
  const record = { age_days: 365, completed_jobs: 50, disputes_lost: 0, tested_deliveries: 30 };
  const verdict = chamberTrust(record);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.ok(verdict.value.score > UNPROVEN_CEILING, `score ${verdict.value.score}`);
    assert.equal(verdict.value.tier, "gold");
  }
});

test("trust caps an agent with no tested delivery at the unproven ceiling", () => {
  const record = { age_days: 365, completed_jobs: 50, disputes_lost: 0, tested_deliveries: 0 };
  const verdict = chamberTrust(record);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.value.score, UNPROVEN_CEILING);
    assert.equal(verdict.value.tier, "bronze");
    assert.match(verdict.value.reasons.join(" "), /capped at 39/);
  }
});

test("trust applies the ceiling after the blend, not before", () => {
  // A record that would score far above the ceiling without the cap.
  const record = { age_days: 400, completed_jobs: 60, disputes_lost: 0, tested_deliveries: 1 };
  const verdict = chamberTrust(record);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.ok(verdict.value.score <= 100);
});

test("trust refuses a missing record", () => {
  const verdict = chamberTrust(undefined);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.chamber, "trust");
    assert.match(verdict.reason, /no record/);
  }
});

test("trust refuses a negative field", () => {
  const record = { ...fixture.trust_record, completed_jobs: -1 };
  const verdict = chamberTrust(record);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /at least zero/);
});

test("trust refuses more disputes lost than jobs completed", () => {
  const record = { ...fixture.trust_record, disputes_lost: 99 };
  const verdict = chamberTrust(record);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /more disputes lost/);
});

test("trust refuses a non numeric field", () => {
  const record = { ...fixture.trust_record, age_days: Number.NaN };
  const verdict = chamberTrust(record);
  assert.equal(verdict.ok, false);
});

/* -------------------------------------------------------------- chamber 3: intent */

test("intent matches a declared capability inside the price ceiling", () => {
  const verdict = chamberIntent(fixture.declarations, fixture.intent);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.value.price_usdc, 3.5);
});

test("intent refuses an undeclared skill", () => {
  const verdict = chamberIntent(fixture.declarations, { ...fixture.intent, skill_id: "nope" });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.chamber, "intent");
    assert.match(verdict.reason, /no declared capability/);
  }
});

test("intent refuses a price above the declared maximum", () => {
  const verdict = chamberIntent(fixture.declarations, { ...fixture.intent, price_usdc: 6 });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /above the declared maximum/);
});

test("intent refuses a zero price", () => {
  const verdict = chamberIntent(fixture.declarations, { ...fixture.intent, price_usdc: 0 });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /greater than zero/);
});

test("intent refuses a rail the agent does not offer", () => {
  const verdict = chamberIntent(fixture.declarations, { ...fixture.intent, rail: "stripe" });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /rail stripe/);
});

/* ---------------------------------------------------------------- chamber 4: soul */

test("soul passes when the hash and all five laws match", () => {
  const verdict = chamberSoul(fixture.soul, fixture.handshake);
  assert.equal(verdict.ok, true);
});

test("soul refuses a missing SOUL", () => {
  const verdict = chamberSoul(undefined, fixture.handshake);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.chamber, "soul");
    assert.match(verdict.reason, /no SOUL/);
  }
});

test("soul refuses a hash mismatch", () => {
  const handshake = { ...fixture.handshake, soul_sha256: "0".repeat(64) };
  const verdict = chamberSoul(fixture.soul, handshake);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /does not match/);
});

test("soul refuses a SOUL missing a law", () => {
  const soul = { ...fixture.soul, laws: ["Solidarity Oath", "Harm Shield"] };
  const verdict = chamberSoul(soul, fixture.handshake);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /missing/);
});

test("soul refuses a nonce that was not echoed", () => {
  const handshake = { ...fixture.handshake, echoed_nonce: "nonce-ffffffffffffffff" };
  const verdict = chamberSoul(fixture.soul, handshake);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /not echoed/);
});

test("soul refuses a nonce shorter than 16 characters", () => {
  const handshake = { ...fixture.handshake, nonce: "short", echoed_nonce: "short" };
  const verdict = chamberSoul(fixture.soul, handshake);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /shorter than 16/);
});

/* ------------------------------------------------------------- chamber 5: session */

test("session accepts a freshly issued token", () => {
  const verdict = chamberSession(fixture.session, clock, secret);
  assert.equal(verdict.ok, true);
});

test("session refuses an expired token", () => {
  const verdict = chamberSession(fixture.session, at(fixture.clock_epoch + SESSION_TTL_SECONDS + 1), secret);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.chamber, "session");
    assert.match(verdict.reason, /expired/);
  }
});

test("session refuses a tampered claim", () => {
  const tampered = {
    claims: { ...fixture.session.claims, offer_id: "lax-ext-attacker" },
    mac: fixture.session.mac,
  };
  const verdict = chamberSession(tampered, clock, secret);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /tampered/);
});

test("session refuses a tampered expiry", () => {
  const tampered = {
    claims: { ...fixture.session.claims, expires_at: fixture.session.claims.expires_at + 3600 },
    mac: fixture.session.mac,
  };
  const verdict = chamberSession(tampered, clock, secret);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /longer than the allowed ttl|tampered/);
});

test("session refuses a token signed with another secret", () => {
  const forged = issueSession(
    { agent_did: fixture.session.claims.agent_did, offer_id: fixture.session.claims.offer_id },
    clock,
    "wrong-secret",
  );
  const verdict = chamberSession(forged, clock, secret);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /tampered/);
});

test("session refuses a missing token", () => {
  const verdict = chamberSession(undefined, clock, secret);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /no session token/);
});

test("session refuses a window longer than the allowed ttl", () => {
  const claims = { ...fixture.session.claims, expires_at: fixture.session.claims.issued_at + 7200 };
  const verdict = chamberSession({ claims, mac: sessionMac(claims, secret) }, clock, secret);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /longer than the allowed ttl/);
});

test("session refuses a token issued in the future", () => {
  const verdict = chamberSession(fixture.session, at(fixture.clock_epoch - 600), secret);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /future/);
});

/* --------------------------------------------------------------- the full chain */

test("the chain reaches all five chambers for a good bundle", () => {
  const result = runChambers(bundle(), clock, secret);
  assert.deepEqual(result.reached, ["identity", "trust", "intent", "soul", "session"]);
  assert.equal(result.failedAt, null);
});

test("the chain stops at identity and never touches later chambers", () => {
  const result = runChambers(bundle({ listing: undefined }), clock, secret);
  assert.deepEqual(result.reached, ["identity"]);
  assert.equal(result.failedAt, "identity");
});

test("the chain stops at trust", () => {
  const result = runChambers(bundle({ trustRecord: undefined }), clock, secret);
  assert.deepEqual(result.reached, ["identity", "trust"]);
  assert.equal(result.failedAt, "trust");
});

test("the chain stops at intent", () => {
  const result = runChambers(bundle({ intent: { ...fixture.intent, price_usdc: 99 } }), clock, secret);
  assert.equal(result.failedAt, "intent");
});

test("the chain stops at soul", () => {
  const result = runChambers(bundle({ soul: undefined }), clock, secret);
  assert.equal(result.failedAt, "soul");
});

test("the chain stops at session on an expired token", () => {
  const stale = issueSession(
    { agent_did: fixture.session.claims.agent_did, offer_id: fixture.session.claims.offer_id },
    at(fixture.clock_epoch - 1000),
    secret,
  );
  const result = runChambers(bundle({ session: stale }), clock, secret);
  assert.deepEqual(result.reached, ["identity", "trust", "intent", "soul", "session"]);
  assert.equal(result.failedAt, "session");
  assert.match(result.reason ?? "", /expired/);
});

test("every chamber can refuse, so the suite has five refusing cases at minimum", () => {
  const refusals = [
    runChambers(bundle({ listing: undefined }), clock, secret),
    runChambers(bundle({ trustRecord: undefined }), clock, secret),
    runChambers(bundle({ intent: { ...fixture.intent, skill_id: "missing" } }), clock, secret),
    runChambers(bundle({ soul: undefined }), clock, secret),
    runChambers(bundle({ session: undefined }), clock, secret),
  ];
  assert.deepEqual(
    refusals.map((r) => r.failedAt),
    ["identity", "trust", "intent", "soul", "session"],
  );
});
