// =============================================================================
// HYDRA-UMC-MQTT-BROKER - Optional MQTT username/password authentication
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Authentication is deliberately opt-in: existing local development brokers
// stay open unless credentials are supplied.  When it is enabled, this module
// gives the ACL an authenticated client session instead of trusting only a
// caller-provided MQTT client ID.
// =============================================================================

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * A password in MQTT_AUTH_JSON may be stored hashed instead of in the clear:
 * `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`. A plain password still works
 * (nothing changes for an existing configuration); `npm run hash-password` writes the hashed form.
 */
export const HASH_PREFIX = "scrypt$";
const DEFAULT_COST = { N: 16384, r: 8, p: 1 };
const MAX_N = 1 << 17;
const KEY_LENGTH = 32;

export function isHashedPassword(stored: string): boolean {
  return stored.startsWith(HASH_PREFIX);
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** The pieces of a stored hashed password, or null when it is malformed (or asks for an unreasonable cost). */
export function parseHashedPassword(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length < 8 || hash.length < 16) return null;
  return { N, r, p, salt, hash };
}

/** Hashes a password for MQTT_AUTH_JSON (slow on purpose: it is run once, by the operator). */
export function hashPassword(password: string, cost: { N: number; r: number; p: number } = DEFAULT_COST): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { ...cost, maxmem: 256 * cost.N * cost.r });
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function scryptAsync(password: Buffer, parsed: ParsedHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, parsed.salt, parsed.hash.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 256 * parsed.N * parsed.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Whether the supplied password matches a stored one (plain or hashed). The hashed form is derived off the event loop. */
export async function passwordMatches(stored: string, supplied: Buffer): Promise<boolean> {
  if (!isHashedPassword(stored)) {
    const expected = Buffer.from(stored, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
  const parsed = parseHashedPassword(stored);
  if (!parsed) return false;
  try {
    return timingSafeEqual(parsed.hash, await scryptAsync(supplied, parsed));
  } catch {
    return false;
  }
}

export interface BrokerCredential {
  username: string;
  password: string;
  /**
   * (P1):
   * a client ID is client-chosen and unrelated to which username/password
   * it presented - src/acl.ts's own rules key entirely off client ID
   * prefix. Without this field, a low-privilege but VALID user could
   * authenticate with their own real credentials, then simply declare a
   * privileged client ID in CONNECT and pass an ACL their own identity was
   * never granted. Every authenticated client's ID must now start with
   * this exact prefix - binding the verified principal to the identity
   * space the ACL actually authorizes it for, independent of whatever ID
   * string the client asks for.
   */
  clientIdPrefix: string;
}

export class AuthConfigError extends Error {}

function isCredential(value: unknown): value is BrokerCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.username === "string" &&
    record.username.length > 0 &&
    typeof record.password === "string" &&
    record.password.length > 0 &&
    typeof record.clientIdPrefix === "string" &&
    record.clientIdPrefix.length > 0
  );
}

/** Parse the JSON array accepted by MQTT_AUTH_JSON and reject ambiguous IDs. */
export function parseCredentialsConfig(json: string): BrokerCredential[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AuthConfigError(`invalid authentication JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AuthConfigError("authentication config must be a non-empty JSON array of credentials");
  }
  if (!parsed.every(isCredential)) {
    throw new AuthConfigError("each credential must contain non-empty string username and password fields");
  }
  const usernames = new Set<string>();
  for (const credential of parsed) {
    if (isHashedPassword(credential.password) && !parseHashedPassword(credential.password)) {
      throw new AuthConfigError(`the hashed password of '${credential.username}' is malformed (expected scrypt$N$r$p$salt$hash, as written by npm run hash-password)`);
    }
    if (usernames.has(credential.username)) {
      throw new AuthConfigError(`duplicate authentication username: ${credential.username}`);
    }
    usernames.add(credential.username);
  }
  return parsed;
}

/**
 * Verify one MQTT CONNECT credential without ever logging the secret.  The
 * equal-length comparison uses Node's constant-time primitive; unequal
 * lengths are rejected before comparison because timingSafeEqual requires
 * equal-sized buffers.
 *
 * also requires `clientId` to start with the matched credential's
 * own `clientIdPrefix` - a valid username/password for a DIFFERENT
 * identity's prefix must never authenticate a client claiming this one.
 * `clientId` is checked only after a real username/password match, so a
 * wrong password is still reported as a credential failure, not conflated
 * with an identity-prefix mismatch.
 */
export function credentialsAuthenticate(
  credentials: readonly BrokerCredential[],
  username: string | undefined,
  password: Buffer | undefined,
  clientId: string | undefined,
): boolean {
  return authenticatedPrefix(credentials, username, password, clientId) !== null;
}

/**
 * The identity prefix of the credential a CONNECT proved, or null when it did not authenticate. The ACL is evaluated against THIS (the verified principal's own prefix), not
 * against the client ID the client chose: a credential whose prefix is `bridge-` can connect as `bridge-cnc-x`, but its rights are those of the rule that covers `bridge-`,
 * never those of a more specific (and more privileged) `bridge-cnc-` rule that happens to come first.
 */
export function authenticatedPrefix(
  credentials: readonly BrokerCredential[],
  username: string | undefined,
  password: Buffer | undefined,
  clientId: string | undefined,
): string | null {
  if (username === undefined || password === undefined) return null;
  const configured = credentials.find((credential) => credential.username === username);
  if (!configured) return null;
  // a hashed password needs the asynchronous check below; here it never matches
  if (isHashedPassword(configured.password)) return null;
  const expected = Buffer.from(configured.password, "utf8");
  if (expected.length !== password.length || !timingSafeEqual(expected, password)) return null;
  return typeof clientId === "string" && clientId.startsWith(configured.clientIdPrefix) ? configured.clientIdPrefix : null;
}

/** authenticatedPrefix for credentials whose passwords may be stored hashed (what the broker uses). */
export async function authenticatedPrefixAsync(
  credentials: readonly BrokerCredential[],
  username: string | undefined,
  password: Buffer | undefined,
  clientId: string | undefined,
): Promise<string | null> {
  if (username === undefined || password === undefined) return null;
  const configured = credentials.find((credential) => credential.username === username);
  if (!configured) return null;
  if (!(await passwordMatches(configured.password, password))) return null;
  return typeof clientId === "string" && clientId.startsWith(configured.clientIdPrefix) ? configured.clientIdPrefix : null;
}
