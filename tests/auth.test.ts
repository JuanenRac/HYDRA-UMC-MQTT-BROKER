// =============================================================================
// HYDRA-UMC-MQTT-BROKER - Authentication configuration unit tests
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================

import { describe, expect, it } from "vitest";
import { AuthConfigError, credentialsAuthenticate, parseCredentialsConfig } from "../src/auth.js";

const CREDENTIALS = [{ username: "robot-1", password: "test-secret", clientIdPrefix: "robot-" }];

describe("MQTT credential configuration", () => {
  it("parses a non-empty list of credentials", () => {
    expect(parseCredentialsConfig(JSON.stringify(CREDENTIALS))).toEqual(CREDENTIALS);
  });

  it.each([
    "not-json",
    "[]",
    "[{}]",
    '[{"username":"robot","password":"","clientIdPrefix":"robot-"}]',
    '[{"username":"robot","password":"secret"}]',
    '[{"username":"robot","password":"secret","clientIdPrefix":""}]',
    '[{"username":"a","password":"1","clientIdPrefix":"a-"},{"username":"a","password":"2","clientIdPrefix":"a-"}]',
  ])("rejects invalid or ambiguous credential config: %s", (config) => {
    expect(() => parseCredentialsConfig(config)).toThrow(AuthConfigError);
  });

  it("accepts only the matching username, password AND client ID prefix", () => {
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", Buffer.from("test-secret"), "robot-1")).toBe(true);
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", Buffer.from("wrong-secret"), "robot-1")).toBe(false);
    expect(credentialsAuthenticate(CREDENTIALS, "unknown", Buffer.from("test-secret"), "robot-1")).toBe(false);
    expect(credentialsAuthenticate(CREDENTIALS, undefined, Buffer.from("test-secret"), "robot-1")).toBe(false);
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", undefined, "robot-1")).toBe(false);
  });

  it("MQTT-01: rejects the right username/password with a client ID outside its own authorized prefix", () => {
    // The exact scenario from the finding: a valid, lower-privilege
    // credential trying to authenticate under a different (here,
    // higher-privileged-looking) client ID that its own username/password
    // was never authorized for.
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", Buffer.from("test-secret"), "dashboard-admin")).toBe(false);
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", Buffer.from("test-secret"), undefined)).toBe(false);
  });

  it("two credentials for two different identity prefixes cannot authenticate into each other's prefix", () => {
    const twoUsers = [
      { username: "robot-1", password: "robot-secret", clientIdPrefix: "robot-" },
      { username: "dashboard-admin", password: "dashboard-secret", clientIdPrefix: "dashboard-" },
    ];
    // Each real credential still works under its OWN prefix.
    expect(credentialsAuthenticate(twoUsers, "robot-1", Buffer.from("robot-secret"), "robot-1")).toBe(true);
    expect(credentialsAuthenticate(twoUsers, "dashboard-admin", Buffer.from("dashboard-secret"), "dashboard-1")).toBe(true);
    // The lower-privilege robot credential, correct password included,
    // must not pass under the dashboard's own privileged prefix.
    expect(credentialsAuthenticate(twoUsers, "robot-1", Buffer.from("robot-secret"), "dashboard-1")).toBe(false);
  });
});
