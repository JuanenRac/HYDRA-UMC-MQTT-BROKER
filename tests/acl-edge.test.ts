// =============================================================================
// HYDRA-UMC-MQTT-BROKER - ACL, credential and production-policy edge cases
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================

import { describe, expect, it } from "vitest";
import { AclConfigError, isPublishAllowed, isSubscribeAllowed, isSubscriptionWithinScope, isValidTopicFilter, parseAclConfig, topicMatchesFilter } from "../src/acl.js";
import { authenticatedPrefix, parseCredentialsConfig } from "../src/auth.js";
import { anonymousAllowed, isProduction, openStartWarnings, productionProblems } from "../src/security.js";

describe("topicMatchesFilter edge cases", () => {
  it("treats a trailing slash as an extra empty level", () => {
    expect(topicMatchesFilter("a/b/", "a/b")).toBe(false);
    expect(topicMatchesFilter("a/b", "a/b/")).toBe(false);
    expect(topicMatchesFilter("a/b/", "a/b/+")).toBe(true);
  });

  it("lets + match an empty level but never a missing one", () => {
    expect(topicMatchesFilter("a//c", "a/+/c")).toBe(true);
    expect(topicMatchesFilter("a/c", "a/+/c")).toBe(false);
  });

  it("matches the parent topic with a trailing # (a/# covers a) but not a sibling prefix", () => {
    expect(topicMatchesFilter("a", "a/#")).toBe(true);
    expect(topicMatchesFilter("ab", "a/#")).toBe(false);
    expect(topicMatchesFilter("a/b/c/d", "a/#")).toBe(true);
  });

  it("never accepts a # that is not the last level of the filter as a wildcard", () => {
    expect(topicMatchesFilter("a/b/c", "a/#/c")).toBe(false);
  });

  it("is case sensitive and does not match a topic that merely starts with the filter", () => {
    expect(topicMatchesFilter("Hydra/x", "hydra/x")).toBe(false);
    expect(topicMatchesFilter("hydra/x/y", "hydra/x")).toBe(false);
    expect(topicMatchesFilter("hydra", "hydra/x")).toBe(false);
  });

  it("does not let a published topic that contains a wildcard character match a literal filter", () => {
    expect(topicMatchesFilter("hydra/+/status", "hydra/robot-1/status")).toBe(false);
    expect(topicMatchesFilter("hydra/#", "hydra/robot-1/status")).toBe(false);
  });
});

describe("isSubscriptionWithinScope edge cases", () => {
  it("refuses a + request that would widen a concrete level, and a # request under a + level", () => {
    expect(isSubscriptionWithinScope("a/b/c", "a/+/c")).toBe(false);
    expect(isSubscriptionWithinScope("a/+/c", "a/#")).toBe(false);
    expect(isSubscriptionWithinScope("a/+", "a/+/#")).toBe(false);
  });

  it("accepts a narrower request under + and under a trailing #", () => {
    expect(isSubscriptionWithinScope("a/+/c", "a/b/c")).toBe(true);
    expect(isSubscriptionWithinScope("a/#", "a/+/c/#")).toBe(true);
  });

  it("refuses a request shorter or longer than a literal rule", () => {
    expect(isSubscriptionWithinScope("a/b", "a")).toBe(false);
    expect(isSubscriptionWithinScope("a/b", "a/b/c")).toBe(false);
  });
});

describe("rule lookup", () => {
  const rules = [
    { clientIdPrefix: "bridge-cnc-", publish: ["cnc/#"], subscribe: [] },
    { clientIdPrefix: "bridge-", publish: ["generic/#"], subscribe: ["generic/cmd"] },
  ];

  it("applies the first rule whose prefix the client id starts with", () => {
    expect(isPublishAllowed(rules, "bridge-cnc-1", "cnc/status")).toBe(true);
    expect(isPublishAllowed(rules, "bridge-cnc-1", "generic/x")).toBe(false);
    expect(isPublishAllowed(rules, "bridge-uav-1", "generic/x")).toBe(true);
  });

  it("an empty rule list denies everything", () => {
    expect(isPublishAllowed([], "x", "a")).toBe(false);
    expect(isSubscribeAllowed([], "x", "a")).toBe(false);
  });

  it("a client id that merely contains the prefix does not match", () => {
    expect(isPublishAllowed(rules, "not-bridge-1", "generic/x")).toBe(false);
  });

  it("an empty client id matches no non-empty prefix", () => {
    expect(isPublishAllowed(rules, "", "generic/x")).toBe(false);
  });
});

describe("isValidTopicFilter and parseAclConfig", () => {
  it.each(["a/b#", "a/#/b", "a/b+/c", "", "a/\u0000b", "#a", "a/+b"])("rejects %j", (filter) => {
    expect(isValidTopicFilter(filter)).toBe(false);
  });

  it.each(["#", "+", "a/+/b", "a/#", "/", "a//b"])("accepts %j", (filter) => {
    expect(isValidTopicFilter(filter)).toBe(true);
  });

  it.each([
    "null",
    '{"clientIdPrefix":"a","publish":[],"subscribe":[]}',
    '[null]',
    '[{"clientIdPrefix":1,"publish":[],"subscribe":[]}]',
    '[{"clientIdPrefix":"a","publish":"x","subscribe":[]}]',
    '[{"clientIdPrefix":"a","publish":[],"subscribe":["a/#/b"]}]',
  ])("refuses the malformed ACL %s", (json) => {
    expect(() => parseAclConfig(json)).toThrow(AclConfigError);
  });
});

describe("credential edge cases", () => {
  const credentials = [{ username: "u", password: "pässword-1234567890", clientIdPrefix: "robot-" }];

  it("compares passwords by bytes, so a different length or a near miss is refused", () => {
    expect(authenticatedPrefix(credentials, "u", Buffer.from("pässword-1234567890", "utf8"), "robot-1")).toBe("robot-");
    expect(authenticatedPrefix(credentials, "u", Buffer.from("pässword-123456789"), "robot-1")).toBeNull();
    expect(authenticatedPrefix(credentials, "u", Buffer.from("pässword-1234567891"), "robot-1")).toBeNull();
    expect(authenticatedPrefix(credentials, "u", Buffer.alloc(0), "robot-1")).toBeNull();
  });

  it("refuses a missing username, password or client id", () => {
    expect(authenticatedPrefix(credentials, undefined, Buffer.from("x"), "robot-1")).toBeNull();
    expect(authenticatedPrefix(credentials, "u", undefined, "robot-1")).toBeNull();
    expect(authenticatedPrefix(credentials, "u", Buffer.from("pässword-1234567890"), undefined)).toBeNull();
  });

  it("refuses an unknown user and an empty credential list", () => {
    expect(authenticatedPrefix(credentials, "other", Buffer.from("pässword-1234567890"), "robot-1")).toBeNull();
    expect(authenticatedPrefix([], "u", Buffer.from("x"), "robot-1")).toBeNull();
  });

  it("refuses non-string and non-object credential entries", () => {
    for (const json of ['[1]', '[null]', '[{"username":1,"password":"p","clientIdPrefix":"a"}]', "{}", "7"]) {
      expect(() => parseCredentialsConfig(json), json).toThrow();
    }
  });
});

describe("production policy", () => {
  it("recognises production case-insensitively and with spaces", () => {
    expect(isProduction({ NODE_ENV: " Production " })).toBe(true);
    expect(isProduction({ NODE_ENV: "prod" })).toBe(false);
    expect(isProduction({})).toBe(false);
  });

  it("allows anonymous access only when the variable is exactly 1", () => {
    expect(anonymousAllowed({ MQTT_ALLOW_ANONYMOUS: "1" })).toBe(true);
    expect(anonymousAllowed({ MQTT_ALLOW_ANONYMOUS: "true" })).toBe(false);
    expect(anonymousAllowed({ MQTT_ALLOW_ANONYMOUS: "0" })).toBe(false);
  });

  it("an explicit anonymous opt-in switches the production check off", () => {
    expect(productionProblems({}, { NODE_ENV: "production", MQTT_ALLOW_ANONYMOUS: "1" })).toEqual([]);
  });

  it("reports an ACL rule with an empty prefix and a credential the ACL does not cover, together", () => {
    const problems = productionProblems(
      {
        credentials: [{ username: "u", password: "a-strong-password-123", clientIdPrefix: "x-" }],
        acl: [{ clientIdPrefix: "", publish: [], subscribe: [] }, { clientIdPrefix: "zzz-", publish: [], subscribe: [] }],
      },
      { NODE_ENV: "production" },
    );
    expect(problems.some((p) => p.includes("empty clientIdPrefix"))).toBe(true);
    expect(problems.length).toBe(1);
  });

  it("open start warns about each missing protection, and is quiet when both exist", () => {
    expect(openStartWarnings({}).length).toBe(2);
    expect(openStartWarnings({ credentials: [{ username: "u", password: "p", clientIdPrefix: "a" }], acl: [] }).length).toBe(1);
    expect(openStartWarnings({ credentials: [{ username: "u", password: "p", clientIdPrefix: "a" }], acl: [{ clientIdPrefix: "a", publish: [], subscribe: [] }] })).toEqual([]);
  });
});
