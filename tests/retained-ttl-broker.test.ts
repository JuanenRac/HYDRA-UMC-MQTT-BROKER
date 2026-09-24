// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/retained-ttl-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// real end-to-end proof that a retained message older than
// retainedTtlMs is actively cleared - a NEW subscriber connecting after the
// TTL elapses must never receive it, over a real broker/client (not just
// internal Map bookkeeping). (in the sibling bridge repos) already
// defends a CLIENT against blindly trusting a retained replay as a live
// command; this is the complementary broker-side policy that retained
// state itself now has a real expiry.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";

const TEST_PORT = 41889;

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

function publishRetained(client: MqttClient, topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1, retain: true }, (err) => (err ? reject(err) : resolve()));
  });
}

function subscribeAndWaitForMessage(client: MqttClient, topic: string, timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    client.on("message", (_topic, payload) => {
      clearTimeout(timer);
      resolve(payload.toString());
    });
    client.subscribe(topic);
  });
}

describe("buildBroker retainedTtlMs validation", () => {
  it("rejects a non-positive/non-finite TTL before accepting client traffic", async () => {
    await expect(buildBroker(TEST_PORT, { retainedTtlMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(buildBroker(TEST_PORT, { retainedTtlMs: -5 })).rejects.toBeInstanceOf(RangeError);
    await expect(buildBroker(TEST_PORT, { retainedTtlMs: Number.NaN })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("real retained-message expiry over a real broker/client", () => {
  it("a retained message survives a fresh subscriber before its TTL elapses (positive control)", async () => {
    const built = await buildBroker(TEST_PORT, { retainedTtlMs: 100_000 });
    broker = built.broker;
    server = built.server;

    const publisher = await connectClient("publisher-fresh");
    await publishRetained(publisher, "hydra/last-command", "reboot");

    const subscriber = await connectClient("subscriber-fresh");
    expect(await subscribeAndWaitForMessage(subscriber, "hydra/last-command")).toBe("reboot");
  });

  it("expires a retained message older than retainedTtlMs - a new subscriber never sees it", async () => {
    const TTL_MS = 150;
    const built = await buildBroker(TEST_PORT, { retainedTtlMs: TTL_MS });
    broker = built.broker;
    server = built.server;

    const publisher = await connectClient("publisher-stale");
    await publishRetained(publisher, "hydra/last-command", "reboot");

    // Real wait past the TTL AND at least one sweep cycle - the sweep
    // cadence is min(ttl, 30000)ms, so 150ms here.
    await new Promise((resolve) => setTimeout(resolve, TTL_MS * 3));

    const subscriber = await connectClient("subscriber-stale");
    expect(await subscribeAndWaitForMessage(subscriber, "hydra/last-command")).toBeNull();
  });

  it("a real re-publish before the TTL elapses restarts the clock instead of expiring on the original schedule", async () => {
    const TTL_MS = 200;
    const built = await buildBroker(TEST_PORT, { retainedTtlMs: TTL_MS });
    broker = built.broker;
    server = built.server;

    const publisher = await connectClient("publisher-refresh");
    await publishRetained(publisher, "hydra/last-command", "first");
    await new Promise((resolve) => setTimeout(resolve, TTL_MS * 0.6));
    // Refreshed before the original TTL would have fired.
    await publishRetained(publisher, "hydra/last-command", "second");
    await new Promise((resolve) => setTimeout(resolve, TTL_MS * 0.6));

    const subscriber = await connectClient("subscriber-refresh");
    expect(await subscribeAndWaitForMessage(subscriber, "hydra/last-command")).toBe("second");
  });

  it("retainedTtlMs is opt-in - a retained message never expires without it", async () => {
    const built = await buildBroker(TEST_PORT, {});
    broker = built.broker;
    server = built.server;

    const publisher = await connectClient("publisher-noopt");
    await publishRetained(publisher, "hydra/last-command", "reboot");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const subscriber = await connectClient("subscriber-noopt");
    expect(await subscribeAndWaitForMessage(subscriber, "hydra/last-command")).toBe("reboot");
  });
});
