// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/bridge-acl.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The ACL element for the server that .env.example documents: it lets the gateway of the server read what the bridges say and send the
// default verbs, the signed settings and its own status, and nothing more.
// =============================================================================

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AclRule, isPublishAllowed, isSubscribeAllowed, parseAclConfig } from "../src/acl.js";

function gatewayRule(): AclRule {
  const text = readFileSync(new URL("../.env.example", import.meta.url), "utf-8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith('# {"clientIdPrefix":"hydra-umc-gateway-"'));
  expect(line).toBeDefined();
  return parseAclConfig(`[${line!.slice(2)}]`)[0];
}

describe("the ACL element of the server in .env.example", () => {
  const rules = (): AclRule[] => [gatewayRule()];
  const id = "hydra-umc-gateway-1a2b3c4d";

  it("reads the state, the availability, the health and the results of every bridge", () => {
    for (const filter of ["hydra/bridges/+/state", "hydra/bridges/+/availability", "hydra/bridges/+/health", "hydra/bridges/+/cmd/+/result"]) {
      expect(isSubscribeAllowed(rules(), id, filter)).toBe(true);
    }
    expect(isSubscribeAllowed(rules(), id, "hydra/bridges/cnc/health")).toBe(true);
  });

  it("does not read what is not for it", () => {
    for (const filter of ["#", "hydra/bridges/#", "hydra/bridges/+/cmd/#", "hydra/bridges/+/settings", "hydra/robots/+/command"]) {
      expect(isSubscribeAllowed(rules(), id, filter)).toBe(false);
    }
  });

  it("publishes the default verbs, the signed settings and the status of the gateway", () => {
    for (const topic of ["hydra/bridges/cnc/cmd/status", "hydra/bridges/laser/cmd/stop", "hydra/bridges/ros2/cmd/pause", "hydra/bridges/uav/cmd/resume",
      "hydra/bridges/cnc/settings", "hydra/bridges/_gateway/status"]) {
      expect(isPublishAllowed(rules(), id, topic)).toBe(true);
    }
  });

  it("cannot publish the job topic, what a bridge says about itself, or any other verb", () => {
    for (const topic of ["hydra/bridges/cnc/cmd/job", "hydra/bridges/cnc/state", "hydra/bridges/cnc/health", "hydra/bridges/cnc/availability",
      "hydra/bridges/cnc/cmd/home", "hydra/swarm/safety/estop"]) {
      expect(isPublishAllowed(rules(), id, topic)).toBe(false);
    }
  });

  it("is not granted to another client", () => {
    expect(isPublishAllowed(rules(), "hydra-umc-bridge-cnc", "hydra/bridges/cnc/cmd/stop")).toBe(false);
  });
});
