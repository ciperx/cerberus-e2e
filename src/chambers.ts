/**
 * Reference implementations of the five Cerberus chambers.
 *
 * The job spec says the chamber functions are provided as interfaces in the spec bundle.
 * They are not in this repository, so this file is a reference implementation of the same
 * interfaces: the test suite drives these five in order, and pointing the suite at the
 * real bundle means swapping this module for the provided one. Every chamber is pure,
 * takes an injected clock, and never touches the network.
 */

export interface Clock {
  now(): number;
}

export interface Refusal {
  ok: false;
  chamber: ChamberName;
  reason: string;
}

export type ChamberName = "identity" | "trust" | "intent" | "soul" | "session";

export type Verdict<T> = { ok: true; value: T } | Refusal;

function refuse<T>(chamber: ChamberName, reason: string): Verdict<T> {
  return { ok: false, chamber, reason };
}

/* ------------------------------------------------------------------ chamber 1: identity */

export interface ListingRecord {
  agent_did: string;
  owner: string;
  offer_id: string;
  revoked_at?: string | null;
}

export interface IdentityChallenge {
  agent_did: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  signature: string;
  signer: string;
}

const HEX64 = /^0x[0-9a-fA-F]{128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function chamberIdentity(
  listing: ListingRecord | undefined,
  challenge: IdentityChallenge,
  clock: Clock,
): Verdict<{ agent_did: string; offer_id: string }> {
  if (!listing) return refuse("identity", "no listing for that agent");
  if (listing.revoked_at) return refuse("identity", "listing is revoked");
  if (challenge.agent_did !== listing.agent_did) {
    return refuse("identity", "challenge names a different agent");
  }
  if (challenge.signer.toLowerCase() !== listing.owner.toLowerCase()) {
    return refuse("identity", "signer is not the listing owner");
  }
  if (!HEX64.test(challenge.signature)) return refuse("identity", "signature is not 64 bytes of hex");
  if (!ADDRESS.test(challenge.signer)) return refuse("identity", "signer is not an address");
  const now = clock.now();
  const expires = Date.parse(challenge.expires_at);
  const issued = Date.parse(challenge.issued_at);
  if (Number.isNaN(expires) || Number.isNaN(issued)) {
    return refuse("identity", "challenge timestamps are not dates");
  }
  if (expires <= issued) return refuse("identity", "challenge expires before it was issued");
  if (now >= expires) return refuse("identity", "challenge has expired");
  if (now < issued - 60_000) return refuse("identity", "challenge is issued in the future");
  return { ok: true, value: { agent_did: listing.agent_did, offer_id: listing.offer_id } };
}

/* ----------------------------------------------------------------- chamber 2: trust */

export interface TrustRecord {
  age_days: number;
  completed_jobs: number;
  disputes_lost: number;
  tested_deliveries: number;
}

export interface TrustScore {
  score: number;
  tier: "unproven" | "bronze" | "silver" | "gold";
  reasons: string[];
}

export const UNPROVEN_CEILING = 39;

export function chamberTrust(record: TrustRecord | undefined): Verdict<TrustScore> {
  if (!record) return refuse("trust", "no record for that agent");
  const fields: Array<[string, number]> = [
    ["age_days", record.age_days],
    ["completed_jobs", record.completed_jobs],
    ["disputes_lost", record.disputes_lost],
    ["tested_deliveries", record.tested_deliveries],
  ];
  for (const [name, value] of fields) {
    if (!Number.isFinite(value) || value < 0) return refuse("trust", `${name} is not a number of at least zero`);
  }
  if (record.disputes_lost > record.completed_jobs) {
    return refuse("trust", "more disputes lost than jobs completed");
  }
  const age = Math.min(record.age_days, 365) * 0.05;
  const jobs = Math.min(record.completed_jobs, 50) * 1.0;
  const tested = Math.min(record.tested_deliveries, 50) * 0.8;
  const penalty = Math.min(record.disputes_lost, 20) * 3;
  let score = Math.round(age + jobs + tested - penalty);
  score = Math.max(0, Math.min(100, score));
  const reasons = [
    `age contributes ${age.toFixed(2)}`,
    `completed jobs contribute ${jobs.toFixed(2)}`,
    `tested deliveries contribute ${tested.toFixed(2)}`,
    `disputes lost subtract ${penalty.toFixed(2)}`,
  ];
  // The unproven ceiling is applied last, after the blend, so no combination of fields
  // can lift an agent with no tested delivery above it.
  if (record.tested_deliveries === 0 && score > UNPROVEN_CEILING) {
    score = UNPROVEN_CEILING;
    reasons.push(`capped at ${UNPROVEN_CEILING}: no tested delivery on record`);
  }
  const tier = score >= 75 ? "gold" : score >= 50 ? "silver" : score >= 20 ? "bronze" : "unproven";
  return { ok: true, value: { score, tier, reasons } };
}

/* ---------------------------------------------------------------- chamber 3: intent */

export interface CapabilityDeclaration {
  skill_id: string;
  max_price_usdc: number;
  rail: "x402";
}

export interface IntentRequest {
  skill_id: string;
  price_usdc: number;
  rail: string;
}

export function chamberIntent(
  declarations: readonly CapabilityDeclaration[],
  request: IntentRequest,
): Verdict<{ skill_id: string; price_usdc: number }> {
  const match = declarations.find((d) => d.skill_id === request.skill_id);
  if (!match) return refuse("intent", `no declared capability for ${request.skill_id}`);
  if (request.rail !== match.rail) return refuse("intent", `rail ${request.rail} is not offered`);
  if (!Number.isFinite(request.price_usdc) || request.price_usdc <= 0) {
    return refuse("intent", "price must be greater than zero");
  }
  if (request.price_usdc > match.max_price_usdc) {
    return refuse("intent", "price is above the declared maximum");
  }
  return { ok: true, value: { skill_id: match.skill_id, price_usdc: request.price_usdc } };
}

/* ------------------------------------------------------------------- chamber 4: soul */

export interface SoulDocument {
  agent_did: string;
  sha256: string;
  laws: string[];
}

export interface SoulHandshake {
  agent_did: string;
  soul_sha256: string;
  nonce: string;
  echoed_nonce: string;
}

export const REQUIRED_LAWS = [
  "Solidarity Oath",
  "Renewal Mandate",
  "Treasury Equilibrium",
  "Harm Shield",
  "Transparency Covenant",
] as const;

export function chamberSoul(
  soul: SoulDocument | undefined,
  handshake: SoulHandshake,
): Verdict<{ agent_did: string; soul_sha256: string }> {
  if (!soul) return refuse("soul", "no SOUL on record for that agent");
  if (soul.agent_did !== handshake.agent_did) return refuse("soul", "handshake names a different agent");
  if (!/^[0-9a-f]{64}$/.test(soul.sha256)) return refuse("soul", "SOUL hash is not 64 hex characters");
  if (soul.sha256 !== handshake.soul_sha256) return refuse("soul", "SOUL hash does not match the handshake");
  for (const law of REQUIRED_LAWS) {
    if (!soul.laws.includes(law)) return refuse("soul", `SOUL is missing ${law}`);
  }
  if (handshake.nonce.length < 16) return refuse("soul", "nonce is shorter than 16 characters");
  if (handshake.echoed_nonce !== handshake.nonce) return refuse("soul", "nonce was not echoed back");
  return { ok: true, value: { agent_did: soul.agent_did, soul_sha256: soul.sha256 } };
}

/* ---------------------------------------------------------------- chamber 5: session */

export interface SessionClaims {
  agent_did: string;
  offer_id: string;
  issued_at: number;
  expires_at: number;
}

export interface SessionToken {
  claims: SessionClaims;
  mac: string;
}

export const SESSION_TTL_SECONDS = 900;

export function sessionMac(claims: SessionClaims, secret: string): string {
  // Deterministic, dependency free stand in for HMAC. The suite only needs a value that
  // changes when any claim changes, so a simple FNV-1a over the canonical JSON is enough.
  const canonical = `${claims.agent_did}|${claims.offer_id}|${claims.issued_at}|${claims.expires_at}|${secret}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function issueSession(
  claims: Omit<SessionClaims, "issued_at" | "expires_at">,
  clock: Clock,
  secret: string,
  ttl = SESSION_TTL_SECONDS,
): SessionToken {
  const issued_at = Math.floor(clock.now() / 1000);
  const full: SessionClaims = { ...claims, issued_at, expires_at: issued_at + ttl };
  return { claims: full, mac: sessionMac(full, secret) };
}

export function chamberSession(
  token: SessionToken | undefined,
  clock: Clock,
  secret: string,
): Verdict<SessionClaims> {
  if (!token) return refuse("session", "no session token");
  const { claims, mac } = token;
  if (!claims || typeof claims !== "object") return refuse("session", "token has no claims");
  if (typeof claims.agent_did !== "string" || !claims.agent_did.startsWith("did:")) {
    return refuse("session", "claims carry no DID");
  }
  if (!Number.isFinite(claims.issued_at) || !Number.isFinite(claims.expires_at)) {
    return refuse("session", "claims carry no numeric window");
  }
  if (claims.expires_at <= claims.issued_at) return refuse("session", "session expires before it was issued");
  if (claims.expires_at - claims.issued_at > SESSION_TTL_SECONDS) {
    return refuse("session", "session window is longer than the allowed ttl");
  }
  const now = Math.floor(clock.now() / 1000);
  if (now >= claims.expires_at) return refuse("session", "session has expired");
  if (now < claims.issued_at - 60) return refuse("session", "session is issued in the future");
  if (mac !== sessionMac(claims, secret)) return refuse("session", "session token was tampered with");
  return { ok: true, value: claims };
}

/* ------------------------------------------------------------------- the full chain */

export interface ChamberBundle {
  listing?: ListingRecord;
  challenge: IdentityChallenge;
  trustRecord?: TrustRecord;
  declarations: readonly CapabilityDeclaration[];
  intent: IntentRequest;
  soul?: SoulDocument;
  handshake: SoulHandshake;
  session?: SessionToken;
}

export interface ChainResult {
  reached: ChamberName[];
  failedAt: ChamberName | null;
  reason: string | null;
}

/** Drive all five chambers in order and stop at the first refusal. */
export function runChambers(bundle: ChamberBundle, clock: Clock, secret: string): ChainResult {
  const reached: ChamberName[] = [];

  const identity = chamberIdentity(bundle.listing, bundle.challenge, clock);
  reached.push("identity");
  if (!identity.ok) return { reached, failedAt: "identity", reason: identity.reason };

  const trust = chamberTrust(bundle.trustRecord);
  reached.push("trust");
  if (!trust.ok) return { reached, failedAt: "trust", reason: trust.reason };

  const intent = chamberIntent(bundle.declarations, bundle.intent);
  reached.push("intent");
  if (!intent.ok) return { reached, failedAt: "intent", reason: intent.reason };

  const soul = chamberSoul(bundle.soul, bundle.handshake);
  reached.push("soul");
  if (!soul.ok) return { reached, failedAt: "soul", reason: soul.reason };

  const session = chamberSession(bundle.session, clock, secret);
  reached.push("session");
  if (!session.ok) return { reached, failedAt: "session", reason: session.reason };

  return { reached, failedAt: null, reason: null };
}
