// =============================================================================
// HYDRA-UMC MQTT BROKER - src/acl.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real, verifiable topic ACL - turns "clients can only publish/subscribe to
// their own topics" from a README promise into checkable config, matching
// the promotion audit's own call for this ("wildcards can't grant broader
// access by mistake"). Identity here is the MQTT client ID's prefix - a
// real, honest v0 limitation, not TLS client certs or username/password
// (see mejoras_futuras.txt): a client can claim any ID it likes over plain
// TCP, so this ACL is real access CONTROL for well-behaved clients, not yet
// real access SECURITY against an adversarial one.
// =============================================================================

export type TopicFilter = string;

export interface AclRule {
  /** A client is matched by the first rule whose prefix its MQTT client ID starts with. */
  clientIdPrefix: string;
  /** Topic filters this client may PUBLISH to (concrete topics, matched via topicMatchesFilter). */
  publish: TopicFilter[];
  /** Topic filters this client may SUBSCRIBE to (may itself contain wildcards, checked via isSubscriptionWithinScope). */
  subscribe: TopicFilter[];
}

function segments(topic: string): string[] {
  return topic.split("/");
}

/**
 * Real MQTT topic-vs-filter match (single-level `+`, multi-level `#`) for a
 * CONCRETE topic (as a real PUBLISH always carries - MQTT forbids wildcards
 * in a published topic) against a filter that may contain them. This
 * direction is always safe: a filter can only ever narrow which concrete
 * topics match it, never broaden a concrete topic into something it isn't.
 */
export function topicMatchesFilter(topic: TopicFilter, filter: TopicFilter): boolean {
  const topicSegs = segments(topic);
  const filterSegs = segments(filter);
  for (let i = 0; i < filterSegs.length; i++) {
    const f = filterSegs[i];
    if (f === "#") {
      return i === filterSegs.length - 1; // '#' must be the final segment, matches this level and below
    }
    if (i >= topicSegs.length) return false;
    if (f === "+") continue;
    if (f !== topicSegs[i]) return false;
  }
  return topicSegs.length === filterSegs.length;
}

/**
 * The real check the promotion audit specifically calls out: a client's own
 * SUBSCRIBE request is ITSELF a filter, so it can carry `+`/`#` wildcards a
 * naive "does it overlap the allowed filter" check would wrongly authorize.
 * A requested filter is within scope only if it can never match a broader
 * set of concrete topics than the allowed filter already grants -
 * segment-by-segment:
 *  - an allowed literal segment demands the SAME literal in the request (a
 *    requested `+`/`#` there would reach topics the rule never granted);
 *  - an allowed `+` accepts a requested `+` or a literal (a requested `#`
 *    there would reach past this one level into topics below it);
 *  - an allowed `#` grants everything from that level down, so anything in
 *    the request from there on is within scope.
 */
export function isSubscriptionWithinScope(allowedFilter: TopicFilter, requestedFilter: TopicFilter): boolean {
  const allowed = segments(allowedFilter);
  const requested = segments(requestedFilter);
  for (let i = 0; i < allowed.length; i++) {
    const a = allowed[i];
    if (a === "#") return true;
    if (i >= requested.length) return false;
    const r = requested[i];
    if (a === "+") {
      if (r === "#") return false;
      continue;
    }
    if (r !== a) return false;
  }
  return requested.length === allowed.length;
}

function findRule(rules: AclRule[], clientId: string): AclRule | undefined {
  return rules.find((rule) => clientId.startsWith(rule.clientIdPrefix));
}

/**
 * Real default-deny evaluation: a client with no matching rule, or a rule
 * that doesn't list this exact topic/filter, is denied - an ACL only grants
 * what it explicitly lists, it never falls back to "allow because nothing
 * said no".
 */
export function isPublishAllowed(rules: AclRule[], clientId: string, topic: string): boolean {
  const rule = findRule(rules, clientId);
  if (!rule) return false;
  return rule.publish.some((filter) => topicMatchesFilter(topic, filter));
}

export function isSubscribeAllowed(rules: AclRule[], clientId: string, requestedFilter: string): boolean {
  const rule = findRule(rules, clientId);
  if (!rule) return false;
  return rule.subscribe.some((allowedFilter) => isSubscriptionWithinScope(allowedFilter, requestedFilter));
}

export class AclConfigError extends Error {}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Parses and validates a JSON-encoded AclRule[] (real production config,
 * e.g. the MQTT_ACL_JSON environment variable read in server.ts's main()).
 * A real, explicit startup failure for malformed config is far safer than
 * silently running with no ACL, or a partially-wrong one that looks like
 * it's enforcing something it isn't.
 */
export function parseAclConfig(json: string): AclRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AclConfigError(`invalid ACL JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new AclConfigError("ACL config must be a JSON array of rules");
  }
  return parsed.map((rule, index) => {
    if (
      typeof rule !== "object" ||
      rule === null ||
      typeof (rule as Record<string, unknown>).clientIdPrefix !== "string" ||
      !isStringArray((rule as Record<string, unknown>).publish) ||
      !isStringArray((rule as Record<string, unknown>).subscribe)
    ) {
      throw new AclConfigError(
        `ACL rule at index ${index} is malformed - expected {clientIdPrefix: string, publish: string[], subscribe: string[]}`,
      );
    }
    return rule as unknown as AclRule;
  });
}
