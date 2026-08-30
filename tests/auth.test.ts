// =============================================================================
// HYDRA-UMC-MQTT-BROKER - Authentication configuration unit tests
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================

import { describe, expect, it } from "vitest";
import { AuthConfigError, credentialsAuthenticate, parseCredentialsConfig } from "../src/auth.js";

const CREDENTIALS = [{ username: "robot-1", password: "test-secret" }];

describe("MQTT credential configuration", () => {
  it("parses a non-empty list of credentials", () => {
    expect(parseCredentialsConfig(JSON.stringify(CREDENTIALS))).toEqual(CREDENTIALS);
  });

  it.each(["not-json", "[]", "[{}]", '[{"username":"robot","password":""}]', '[{"username":"a","password":"1"},{"username":"a","password":"2"}]'])(
    "rejects invalid or ambiguous credential config: %s",
    (config) => {
      expect(() => parseCredentialsConfig(config)).toThrow(AuthConfigError);
    },
  );

  it("accepts only the matching username and password", () => {
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", Buffer.from("test-secret"))).toBe(true);
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", Buffer.from("wrong-secret"))).toBe(false);
    expect(credentialsAuthenticate(CREDENTIALS, "unknown", Buffer.from("test-secret"))).toBe(false);
    expect(credentialsAuthenticate(CREDENTIALS, undefined, Buffer.from("test-secret"))).toBe(false);
    expect(credentialsAuthenticate(CREDENTIALS, "robot-1", undefined)).toBe(false);
  });
});
