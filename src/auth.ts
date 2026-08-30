// =============================================================================
// HYDRA-UMC-MQTT-BROKER - Optional MQTT username/password authentication
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Authentication is deliberately opt-in: existing local development brokers
// stay open unless credentials are supplied.  When it is enabled, this module
// gives the ACL an authenticated client session instead of trusting only a
// caller-provided MQTT client ID.
// =============================================================================

import { timingSafeEqual } from "node:crypto";

export interface BrokerCredential {
  username: string;
  password: string;
}

export class AuthConfigError extends Error {}

function isCredential(value: unknown): value is BrokerCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.username === "string" &&
    record.username.length > 0 &&
    typeof record.password === "string" &&
    record.password.length > 0
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
 */
export function credentialsAuthenticate(
  credentials: readonly BrokerCredential[],
  username: string | undefined,
  password: Buffer | undefined,
): boolean {
  if (username === undefined || password === undefined) return false;
  const configured = credentials.find((credential) => credential.username === username);
  if (!configured) return false;
  const expected = Buffer.from(configured.password, "utf8");
  return expected.length === password.length && timingSafeEqual(expected, password);
}
