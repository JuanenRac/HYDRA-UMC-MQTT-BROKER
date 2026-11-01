// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/command-envelope.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The opt-in filter on the job command topics of the bridges: what is unsigned,
// expired, future-dated, too long-lived or retained never reaches a bridge, and
// with the option off nothing changes.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";
import { commandEnvelopeProblem, isCommandJobTopic } from "../src/commands.js";

const TEST_PORT = 41894;
const TOPIC = "hydra/bridges/cnc/cmd/job";
const NOW = 1_767_261_600_000;
const SIGNATURE = "a".repeat(64);

function command(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ job_id: "j", issued_at_ms: NOW, expires_in_ms: 10_000, signature: SIGNATURE, ...extra });
}

describe("commandEnvelopeProblem", () => {
  it("recognises only the job command topic of a bridge", () => {
    expect(isCommandJobTopic(TOPIC)).toBe(true);
    for (const other of ["hydra/bridges/cnc/cmd/status", "hydra/bridges/cnc/state", "hydra/bridges/cnc/cmd/job/result", "hydra/bridges/+/cmd/job", "x/hydra/bridges/cnc/cmd/job"]) {
      expect(isCommandJobTopic(other)).toBe(false);
      expect(commandEnvelopeProblem(other, true, "not json", NOW, {})).toBeNull();
    }
  });

  it("lets a current, signed, live command through", () => {
    expect(commandEnvelopeProblem(TOPIC, false, command(), NOW, {})).toBeNull();
    expect(commandEnvelopeProblem(TOPIC, false, command(), NOW + 10_000, {})).toBeNull();
    expect(commandEnvelopeProblem(TOPIC, false, Buffer.from(command()), NOW, {})).toBeNull();
  });

  it("refuses a retained command, whatever it says", () => {
    expect(commandEnvelopeProblem(TOPIC, true, command(), NOW, {})).toMatch(/retained/);
  });

  it("refuses what is not a command", () => {
    for (const payload of ["", "{nope", "[]", "5", "null"]) {
      expect(commandEnvelopeProblem(TOPIC, false, payload, NOW, {}), payload).not.toBeNull();
    }
  });

  it("refuses an unsigned or half-signed command", () => {
    const base = { job_id: "j", issued_at_ms: NOW, expires_in_ms: 10_000, signature: SIGNATURE };
    for (const field of ["issued_at_ms", "expires_in_ms", "signature"] as const) {
      const copy: Record<string, unknown> = { ...base };
      delete copy[field];
      expect(commandEnvelopeProblem(TOPIC, false, JSON.stringify(copy), NOW, {}), field).not.toBeNull();
    }
    for (const bad of [{ signature: "A".repeat(64) }, { signature: "a".repeat(63) }, { signature: 5 }, { issued_at_ms: "1" }, { issued_at_ms: 1.5 }, { expires_in_ms: 0 }, { expires_in_ms: -1 }, { expires_in_ms: true }]) {
      expect(commandEnvelopeProblem(TOPIC, false, command(bad), NOW, {}), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("refuses an expired command, a future one beyond the skew and one that lives too long", () => {
    expect(commandEnvelopeProblem(TOPIC, false, command(), NOW + 10_001, {})).toMatch(/expired/);
    expect(commandEnvelopeProblem(TOPIC, false, command({ issued_at_ms: NOW + 5_000 }), NOW, {})).toBeNull();
    expect(commandEnvelopeProblem(TOPIC, false, command({ issued_at_ms: NOW + 5_001 }), NOW, {})).toMatch(/future/);
    expect(commandEnvelopeProblem(TOPIC, false, command({ issued_at_ms: NOW + 101 }), NOW, { maxClockSkewMs: 100 })).toMatch(/future/);
    expect(commandEnvelopeProblem(TOPIC, false, command({ expires_in_ms: 300_001 }), NOW, {})).toMatch(/at most/);
    expect(commandEnvelopeProblem(TOPIC, false, command({ expires_in_ms: 5_001 }), NOW, { maxExpiresInMs: 5_000 })).toMatch(/at most/);
  });
});

let broker: Aedes;
let server: Server;
const clients: MqttClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (broker) await new Promise<void>((resolve) => broker.close(() => resolve()));
});

function connectClient(clientId: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${TEST_PORT}`, { clientId, connectTimeout: 5000, reconnectPeriod: 0 });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

function listen(client: MqttClient, topic: string): Promise<string[]> {
  const seen: string[] = [];
  client.on("message", (_topic, payload) => seen.push(payload.toString()));
  return new Promise((resolve) => client.subscribe(topic, () => resolve(seen)));
}

function publish(client: MqttClient, topic: string, payload: string, retain = false): Promise<void> {
  return new Promise((resolve) => {
    // a refused publish closes the connection: either way the promise settles
    const done = () => resolve();
    client.once("close", done);
    client.publish(topic, payload, { qos: 1, retain }, done);
  });
}

describe("the filter over a real broker", () => {
  it("a signed, current command reaches the subscriber; an unsigned one and a retained one do not", async () => {
    const built = await buildBroker(TEST_PORT, { commandEnvelope: {} });
    broker = built.broker;
    server = built.server;

    const bridge = await connectClient("bridge-cnc");
    const seen = await listen(bridge, TOPIC);

    const unsigned = await connectClient("sender-unsigned");
    await publish(unsigned, TOPIC, JSON.stringify({ job_id: "unsigned" }));
    const retained = await connectClient("sender-retained");
    await publish(retained, TOPIC, command({ job_id: "retained" }), true);
    const expired = await connectClient("sender-expired");
    await publish(expired, TOPIC, command({ job_id: "expired", issued_at_ms: Date.now() - 60_000, expires_in_ms: 1_000 }));
    const good = await connectClient("sender-good");
    await publish(good, TOPIC, command({ job_id: "good", issued_at_ms: Date.now(), expires_in_ms: 10_000 }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen.map((message) => JSON.parse(message).job_id)).toEqual(["good"]);
  });

  it("other topics are not judged", async () => {
    const built = await buildBroker(TEST_PORT, { commandEnvelope: {} });
    broker = built.broker;
    server = built.server;

    const reader = await connectClient("reader");
    const seen = await listen(reader, "hydra/bridges/cnc/state");
    const bridge = await connectClient("bridge-state");
    await publish(bridge, "hydra/bridges/cnc/state", "plain text, retained", true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toEqual(["plain text, retained"]);
  });

  it("is off unless asked: an unsigned command goes through as before", async () => {
    const built = await buildBroker(TEST_PORT, {});
    broker = built.broker;
    server = built.server;

    const bridge = await connectClient("bridge-off");
    const seen = await listen(bridge, TOPIC);
    const sender = await connectClient("sender-off");
    await publish(sender, TOPIC, JSON.stringify({ job_id: "plain" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen.map((message) => JSON.parse(message).job_id)).toEqual(["plain"]);
  });

  it("refuses limits that are not whole milliseconds", async () => {
    await expect(buildBroker(TEST_PORT, { commandEnvelope: { maxExpiresInMs: 0 } })).rejects.toBeInstanceOf(RangeError);
    await expect(buildBroker(TEST_PORT, { commandEnvelope: { maxClockSkewMs: -1 } })).rejects.toBeInstanceOf(RangeError);
    await expect(buildBroker(TEST_PORT, { commandEnvelope: { maxClockSkewMs: 1.5 } })).rejects.toBeInstanceOf(RangeError);
  });
});
