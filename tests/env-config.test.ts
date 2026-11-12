// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/env-config.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The options read from the environment at start: every value that is malformed stops the start with one line and exit code 1 (never a silent default), every valid one
// reaches the options, and the edges of each number (0, 65535, 65536, a fraction, a negative, text) are the ones asked for. Nothing is started and nothing listens.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBrokerOptionsFromEnv } from "../src/server.js";

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const MANAGED = /^(MQTT_|MAX_PAYLOAD_BYTES$|NODE_ENV$)/;
let saved: Record<string, string | undefined>;
let errors: string[];

beforeEach(() => {
  saved = {};
  for (const key of Object.keys(process.env)) {
    if (MANAGED.test(key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  errors = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (MANAGED.test(key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
});

function load(env: Record<string, string>) {
  Object.assign(process.env, env);
  return loadBrokerOptionsFromEnv();
}

/** Runs the loader and returns the exit code it asked for (it must ask for one). */
function exitCodeOf(env: Record<string, string>): number | undefined {
  try {
    load(env);
  } catch (error) {
    if (error instanceof ExitSignal) return error.code;
    throw error;
  }
  throw new Error("the start was not refused");
}

describe("an empty environment", () => {
  it("gives the plain, open options and asks for nothing to be refused", () => {
    const options = load({});
    expect(options.acl).toBeUndefined();
    expect(options.credentials).toBeUndefined();
    expect(options.maxPayloadBytes).toBeUndefined();
    expect(options.tls).toBeUndefined();
    expect(options.retainedTtlMs).toBeUndefined();
    expect(options.commandEnvelope).toBeUndefined();
  });
});

describe("the size limit of a payload", () => {
  it.each(["abc", "0", "-5", "Infinity", "NaN"])("refuses %s", (value) => {
    expect(exitCodeOf({ MAX_PAYLOAD_BYTES: value })).toBe(1);
    expect(errors.join("\n")).toContain("MAX_PAYLOAD_BYTES must be a positive number");
  });

  it("takes a positive number", () => {
    expect(load({ MAX_PAYLOAD_BYTES: "1024" }).maxPayloadBytes).toBe(1024);
  });
});

describe.each(["MQTT_WS_PORT", "MQTT_METRICS_PORT"])("the port in %s", (name) => {
  it.each(["-1", "65536", "1.5", "http", "1e3x"])("refuses %s", (value) => {
    expect(exitCodeOf({ [name]: value })).toBe(1);
    expect(errors.join("\n")).toContain(`${name} must be an integer from 0 to 65535`);
  });

  it.each([["0", 0], ["1", 1], ["65535", 65535]])("takes %s", (value, expected) => {
    const options = load({ [name]: value });
    expect(name === "MQTT_WS_PORT" ? options.wsPort : options.metricsPort).toBe(expected);
  });
});

describe("the TLS files", () => {
  it("refuse a certificate without its key and the other way round", () => {
    expect(exitCodeOf({ MQTT_TLS_CERT: "/nowhere/cert.pem" })).toBe(1);
    expect(errors.join("\n")).toContain("MQTT_TLS_CERT and MQTT_TLS_KEY must be set together");
  });

  it("refuse files that cannot be read, naming the reason once", () => {
    expect(exitCodeOf({ MQTT_TLS_CERT: "/nowhere/cert.pem", MQTT_TLS_KEY: "/nowhere/key.pem" })).toBe(1);
    expect(errors.join("\n")).toContain("cannot read the TLS files");
  });
});

describe("the allowed origins of the WebSocket", () => {
  it("are split at the commas, trimmed, and the empty ones are dropped", () => {
    expect(load({ MQTT_WS_ALLOWED_ORIGINS: " https://a.example , ,https://b.example,, " }).wsAllowedOrigins).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe.each([
  ["MQTT_CONNECT_TIMEOUT_MS", "connectTimeoutMs"],
  ["MQTT_KEEPALIVE_LIMIT_SECONDS", "keepaliveLimitSeconds"],
  ["MQTT_QUEUE_LIMIT", "queueLimit"],
] as const)("the limit in %s", (name, key) => {
  it.each(["0", "-1", "1.5", "abc", "9007199254740993"])("refuses %s", (value) => {
    expect(exitCodeOf({ [name]: value })).toBe(1);
    expect(errors.join("\n")).toContain(`${name} must be a positive integer`);
  });

  it("takes a positive integer", () => {
    expect(load({ [name]: "250" })[key]).toBe(250);
  });
});

describe("the command envelope", () => {
  it("is off when the variable is not set or says no", () => {
    expect(load({}).commandEnvelope).toBeUndefined();
    for (const value of ["0", "false", "no", "off"]) {
      delete process.env.MQTT_REQUIRE_COMMAND_ENVELOPE;
      expect(load({ MQTT_REQUIRE_COMMAND_ENVELOPE: value }).commandEnvelope).toBeUndefined();
    }
  });

  it("refuses a value that is neither yes nor no", () => {
    expect(exitCodeOf({ MQTT_REQUIRE_COMMAND_ENVELOPE: "maybe" })).toBe(1);
    expect(errors.join("\n")).toContain("MQTT_REQUIRE_COMMAND_ENVELOPE must be yes or no");
  });

  it("is on with defaults for yes in any case, and takes the clock skew and the expiry", () => {
    expect(load({ MQTT_REQUIRE_COMMAND_ENVELOPE: " YES " }).commandEnvelope).toEqual({});
    delete process.env.MQTT_REQUIRE_COMMAND_ENVELOPE;
    const options = load({ MQTT_REQUIRE_COMMAND_ENVELOPE: "1", MQTT_COMMAND_MAX_SKEW_MS: "0", MQTT_COMMAND_MAX_EXPIRES_MS: "60000" });
    expect(options.commandEnvelope).toEqual({ maxClockSkewMs: 0, maxExpiresInMs: 60000 });
  });

  it.each([
    ["MQTT_COMMAND_MAX_SKEW_MS", "-1"],
    ["MQTT_COMMAND_MAX_SKEW_MS", "1.5"],
    ["MQTT_COMMAND_MAX_EXPIRES_MS", "0"],
    ["MQTT_COMMAND_MAX_EXPIRES_MS", "abc"],
  ])("refuses %s=%s", (name, value) => {
    expect(exitCodeOf({ MQTT_REQUIRE_COMMAND_ENVELOPE: "yes", [name]: value })).toBe(1);
    expect(errors.join("\n")).toContain(`${name} must be a whole number of milliseconds`);
  });

  it("ignores the limits while the envelope is off", () => {
    expect(load({ MQTT_COMMAND_MAX_SKEW_MS: "not-a-number" }).commandEnvelope).toBeUndefined();
  });
});

describe("the retained messages", () => {
  it.each(["0", "-1", "1.5", "soon"])("refuse a time to live of %s", (value) => {
    expect(exitCodeOf({ MQTT_RETAINED_TTL_MS: value })).toBe(1);
    expect(errors.join("\n")).toContain("MQTT_RETAINED_TTL_MS must be a positive integer");
  });

  it("take a positive time to live", () => {
    expect(load({ MQTT_RETAINED_TTL_MS: "60000" }).retainedTtlMs).toBe(60000);
  });
});

describe("the addresses", () => {
  it("are trimmed", () => {
    const options = load({ MQTT_BIND_HOST: " 127.0.0.1 ", MQTT_METRICS_HOST: "\t127.0.0.1\n" });
    expect(options.host).toBe("127.0.0.1");
    expect(options.metricsHost).toBe("127.0.0.1");
  });
});

describe("the access rules", () => {
  it("refuse an ACL that is not valid JSON", () => {
    expect(exitCodeOf({ MQTT_ACL_JSON: "{not json" })).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("refuse credentials that are not valid JSON", () => {
    expect(exitCodeOf({ MQTT_AUTH_JSON: "[[" })).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("a production start", () => {
  it("is refused when nothing protects the broker, with the way out written once", () => {
    expect(exitCodeOf({ NODE_ENV: "production" })).toBe(1);
    const text = errors.join("\n");
    expect(text).toContain("refusing to start in production");
    expect(text).toContain("MQTT_AUTH_JSON");
  });
});
