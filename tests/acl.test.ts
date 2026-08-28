// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/acl.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Pure unit tests of the real topic-matching/scope logic in src/acl.ts -
// no broker or socket needed, this is real string/segment math that either
// is or isn't correct on its own.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  type AclRule,
  AclConfigError,
  isPublishAllowed,
  isSubscribeAllowed,
  isSubscriptionWithinScope,
  parseAclConfig,
  topicMatchesFilter,
} from "../src/acl.js";

describe("topicMatchesFilter (concrete topic vs. a filter)", () => {
  it("matches an exact literal filter", () => {
    expect(topicMatchesFilter("hydra/swarm/status", "hydra/swarm/status")).toBe(true);
  });

  it("rejects a different literal topic", () => {
    expect(topicMatchesFilter("hydra/swarm/other", "hydra/swarm/status")).toBe(false);
  });

  it("matches a single-level + wildcard", () => {
    expect(topicMatchesFilter("hydra/robots/1/status", "hydra/robots/+/status")).toBe(true);
    expect(topicMatchesFilter("hydra/robots/42/status", "hydra/robots/+/status")).toBe(true);
  });

  it("does not let + cross a level boundary", () => {
    expect(topicMatchesFilter("hydra/robots/1/2/status", "hydra/robots/+/status")).toBe(false);
  });

  it("matches a multi-level # wildcard at any depth from its position", () => {
    expect(topicMatchesFilter("hydra/robots/1/status", "hydra/robots/#")).toBe(true);
    expect(topicMatchesFilter("hydra/robots/1/status/extra", "hydra/robots/#")).toBe(true);
    // Real MQTT spec special case: "hydra/robots/#" also matches the parent
    // level "hydra/robots" itself, not just topics strictly below it -
    // verified against this behavior, not assumed.
    expect(topicMatchesFilter("hydra/robots", "hydra/robots/#")).toBe(true);
  });

  it("rejects a topic shorter than a literal-only filter", () => {
    expect(topicMatchesFilter("hydra/robots", "hydra/robots/status")).toBe(false);
  });
});

describe("isSubscriptionWithinScope (the real 'wildcards cannot broaden access' check)", () => {
  it("allows a requested filter identical to the allowed one", () => {
    expect(isSubscriptionWithinScope("hydra/robots/+/status", "hydra/robots/+/status")).toBe(true);
  });

  it("allows a concrete, narrower request under a wildcard allow-rule", () => {
    expect(isSubscriptionWithinScope("hydra/robots/+/status", "hydra/robots/1/status")).toBe(true);
  });

  it("rejects a bare # request against a narrow allow-rule", () => {
    expect(isSubscriptionWithinScope("hydra/robots/+/status", "#")).toBe(false);
  });

  it("rejects hydra/# against a rule that only allows one specific subtree", () => {
    expect(isSubscriptionWithinScope("hydra/robots/+/status", "hydra/#")).toBe(false);
  });

  it("rejects hydra/robots/# when the allow-rule stops at a concrete leaf", () => {
    // The allow-rule grants exactly ".../status", not everything below
    // "robots" - a requested '#' there would reach commands, telemetry,
    // config, anything else under a robot's namespace.
    expect(isSubscriptionWithinScope("hydra/robots/+/status", "hydra/robots/#")).toBe(false);
  });

  it("rejects broadening a concrete leaf segment into a +", () => {
    expect(isSubscriptionWithinScope("hydra/robots/+/status", "hydra/robots/+/+")).toBe(false);
  });

  it("allows anything once the allow-rule itself grants a #", () => {
    expect(isSubscriptionWithinScope("hydra/robots/#", "hydra/robots/1/status/deep/nested")).toBe(true);
    expect(isSubscriptionWithinScope("hydra/robots/#", "hydra/robots/#")).toBe(true);
    expect(isSubscriptionWithinScope("hydra/robots/#", "#")).toBe(false); // '#' alone still reaches topics outside "hydra/robots" (e.g. "other/thing")
  });

  it("rejects a request for a sibling subtree", () => {
    expect(isSubscriptionWithinScope("hydra/robots/+/status", "hydra/dashboards/+/status")).toBe(false);
  });
});

describe("isPublishAllowed / isSubscribeAllowed (rule lookup + default-deny)", () => {
  const rules: AclRule[] = [
    { clientIdPrefix: "robot-", publish: ["hydra/robots/+/status", "hydra/robots/+/telemetry"], subscribe: ["hydra/robots/+/command"] },
    { clientIdPrefix: "dashboard-", publish: [], subscribe: ["hydra/#"] },
  ];

  it("allows a robot to publish its own status topic", () => {
    expect(isPublishAllowed(rules, "robot-1", "hydra/robots/1/status")).toBe(true);
  });

  it("denies a robot publishing to a topic its rule never listed", () => {
    expect(isPublishAllowed(rules, "robot-1", "hydra/robots/1/command")).toBe(false);
  });

  it("denies a robot subscribing to another robot's command topic broadened via #", () => {
    expect(isSubscribeAllowed(rules, "robot-1", "hydra/robots/#")).toBe(false);
  });

  it("allows a dashboard client its broad, explicitly-granted # subscription", () => {
    expect(isSubscribeAllowed(rules, "dashboard-1", "hydra/#")).toBe(true);
  });

  it("denies a dashboard client from publishing at all (empty publish list)", () => {
    expect(isPublishAllowed(rules, "dashboard-1", "hydra/robots/1/status")).toBe(false);
  });

  it("denies a client whose ID matches no rule prefix at all", () => {
    expect(isPublishAllowed(rules, "mqttjs_anonymous123", "hydra/robots/1/status")).toBe(false);
    expect(isSubscribeAllowed(rules, "mqttjs_anonymous123", "hydra/robots/1/status")).toBe(false);
  });
});

describe("parseAclConfig (real production config, e.g. MQTT_ACL_JSON)", () => {
  it("parses a real, well-formed rule list", () => {
    const json = JSON.stringify([{ clientIdPrefix: "robot-", publish: ["hydra/robots/+/status"], subscribe: ["hydra/robots/+/command"] }]);
    const rules = parseAclConfig(json);
    expect(rules).toHaveLength(1);
    expect(rules[0].clientIdPrefix).toBe("robot-");
  });

  it("parses a real empty rule list", () => {
    expect(parseAclConfig("[]")).toEqual([]);
  });

  it("throws AclConfigError for invalid JSON rather than silently ignoring it", () => {
    expect(() => parseAclConfig("{not valid json")).toThrow(AclConfigError);
  });

  it("throws AclConfigError when the top level isn't an array", () => {
    expect(() => parseAclConfig(JSON.stringify({ clientIdPrefix: "robot-", publish: [], subscribe: [] }))).toThrow(AclConfigError);
  });

  it("throws AclConfigError for a rule missing a required field", () => {
    expect(() => parseAclConfig(JSON.stringify([{ clientIdPrefix: "robot-", publish: [] }]))).toThrow(AclConfigError);
  });

  it("throws AclConfigError when publish/subscribe contain non-string entries", () => {
    expect(() => parseAclConfig(JSON.stringify([{ clientIdPrefix: "robot-", publish: [123], subscribe: [] }]))).toThrow(AclConfigError);
  });
});
