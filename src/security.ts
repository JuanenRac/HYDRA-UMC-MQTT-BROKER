// =============================================================================
// HYDRA-UMC-MQTT-BROKER - What a production start requires: src/security.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Authentication and the topic ACL are opt-in so a local development broker stays easy to start, but an opt-in protection that a deployment forgets to switch on leaves the
// broker open to everybody on the network (anyone could publish jobs to the bridges). A production start (NODE_ENV=production, which the Dockerfile sets) therefore refuses to
// run without credentials, a matching ACL and passwords that are not examples, unless MQTT_ALLOW_ANONYMOUS=1 says, on purpose and in the logs, that this is an open lab broker.
// =============================================================================

import type { AclRule } from "./acl.js";
import { type BrokerCredential, isHashedPassword } from "./auth.js";

export const MIN_PASSWORD_LENGTH = 16;
/** How long a retained message lives on a production broker when the installation sets no MQTT_RETAINED_TTL_MS of its own: a stale retained command is not replayed for ever. */
export const DEFAULT_PRODUCTION_RETAINED_TTL_MS = 24 * 60 * 60 * 1000;

const PLACEHOLDER = /(set[_ -]?locally|change[_ -]?me|replace[_ -]?me|your[_ -]?(secret|password)|example|placeholder|password123|hydra_umc|remove[_ -]?after)/i;

export function isProduction(env: Record<string, string | undefined>): boolean {
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

export function anonymousAllowed(env: Record<string, string | undefined>): boolean {
  return (env.MQTT_ALLOW_ANONYMOUS ?? "").trim() === "1";
}

/** The ACL rule that governs a verified principal: the first rule whose prefix the principal's own prefix starts with (the same rule the broker applies). */
export function ruleForPrefix(rules: readonly AclRule[], prefix: string): AclRule | undefined {
  return rules.find(rule => prefix.startsWith(rule.clientIdPrefix));
}

/** Everything that makes a production configuration unacceptable (empty when it is fine). */
export function productionProblems(options: { credentials?: readonly BrokerCredential[]; acl?: readonly AclRule[]; certIdentity?: boolean }, env: Record<string, string | undefined>): string[] {
  if (!isProduction(env) || anonymousAllowed(env)) return [];
  const problems: string[] = [];
  // with MQTT_TLS_CERT_IDENTITY=1 the verified client certificate is the identity, so credentials are optional
  if ((!options.credentials || options.credentials.length === 0) && !options.certIdentity) problems.push("MQTT_AUTH_JSON is not set: without credentials anybody on the network can publish and subscribe");
  if (!options.acl || options.acl.length === 0) problems.push("MQTT_ACL_JSON is not set: without an ACL every client can use every topic");
  for (const credential of options.credentials ?? []) {
    if (isHashedPassword(credential.password)) {
      // a hash says nothing about the password it hides: its length and wording cannot be judged
    } else if (PLACEHOLDER.test(credential.password)) problems.push(`the password of '${credential.username}' is an example value`);
    else if (credential.password.length < MIN_PASSWORD_LENGTH) problems.push(`the password of '${credential.username}' has fewer than ${MIN_PASSWORD_LENGTH} characters`);
    if (options.acl && options.acl.length > 0 && !ruleForPrefix(options.acl, credential.clientIdPrefix)) {
      problems.push(`no ACL rule covers the client ID prefix '${credential.clientIdPrefix}' of '${credential.username}' (a rule's prefix must be a prefix of the credential's own)`);
    }
  }
  for (const rule of options.acl ?? []) {
    if (rule.clientIdPrefix === "") problems.push("an ACL rule with an empty clientIdPrefix matches every client");
  }
  return problems;
}

/** What an open (development) start should say loudly. */
export function openStartWarnings(options: { credentials?: readonly BrokerCredential[]; acl?: readonly AclRule[]; certIdentity?: boolean }): string[] {
  const warnings: string[] = [];
  if ((!options.credentials || options.credentials.length === 0) && !options.certIdentity) warnings.push("no MQTT_AUTH_JSON: any client can connect, and its ACL identity is a client ID it chose itself");
  if (!options.acl || options.acl.length === 0) warnings.push("no MQTT_ACL_JSON: every client can publish and subscribe to every topic");
  return warnings;
}

/** True when a bind address only accepts connections from the machine itself. An omitted address means every interface. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "::1" || name === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(name);
}

export function plaintextAllowed(env: Record<string, string | undefined>): boolean {
  return (env.MQTT_ALLOW_PLAINTEXT ?? "").trim() === "1";
}

/**
 * The plain MQTT and WebSocket listeners carry credentials and commands in the clear. Away from loopback they need TLS: a production start refuses to run
 * without it unless MQTT_ALLOW_PLAINTEXT=1 says, on purpose, that the network is trusted. Empty when the start is fine.
 */
export function transportProblems(options: { host?: string; tls?: unknown }, env: Record<string, string | undefined>): string[] {
  if (!isProduction(env) || plaintextAllowed(env) || isLoopbackHost(options.host)) return [];
  if (options.tls) return [];
  return ["TLS is not configured and the plain MQTT listener is open beyond this machine: set MQTT_TLS_CERT and MQTT_TLS_KEY, or bind to loopback with MQTT_BIND_HOST=127.0.0.1 (MQTT_ALLOW_PLAINTEXT=1 accepts a trusted network on purpose)"];
}

/** What every start (production or not) should say loudly about the transport. */
export function transportWarnings(options: { host?: string; tls?: unknown }, env: Record<string, string | undefined>): string[] {
  if (isLoopbackHost(options.host)) return [];
  const where = options.host === undefined ? "every network interface" : `'${options.host}'`;
  if (!options.tls) return [`the plain MQTT listener is bound to ${where} without TLS: credentials and commands travel in the clear${plaintextAllowed(env) ? " (MQTT_ALLOW_PLAINTEXT=1)" : ""}`];
  return [`TLS is on, but the plain MQTT listener is still bound to ${where}: do not publish its port, or bind to 127.0.0.1 and let the TLS port be the only door`];
}
