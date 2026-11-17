// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/retained-limit-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The opt-in cap on the topics that hold a retained message, and the two
// metrics that count them, proven over a real broker and real clients.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";
import type { MetricsRegistry } from "../src/metrics.js";

const TEST_PORT = 21895;

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

/** Publishes retained and resolves once the broker answered or dropped the connection. */
function publishRetained(client: MqttClient, topic: string, payload: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 400);
    client.publish(topic, payload, { qos: 1, retain: true }, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The retained messages a new subscriber to everything is handed, as topic -> payload. */
async function retainedNow(clientId: string): Promise<Record<string, string>> {
  const subscriber = await connectClient(clientId);
  const seen: Record<string, string> = {};
  subscriber.on("message", (topic, payload) => {
    seen[topic] = payload.toString();
  });
  await new Promise<void>((resolve) => subscriber.subscribe("#", () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 300));
  return seen;
}

async function start(options: Parameters<typeof buildBroker>[1]): Promise<MetricsRegistry> {
  const built = await buildBroker(TEST_PORT, options);
  broker = built.broker;
  server = built.server;
  return built.metrics;
}

describe("retainedMaxTopics validation", () => {
  it("rejects a cap that is not a positive safe integer", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(buildBroker(TEST_PORT, { retainedMaxTopics: bad })).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe("the cap on the topics that hold a retained message", () => {
  it("refuses a retained message on one more topic once the cap is reached", async () => {
    const metrics = await start({ retainedMaxTopics: 2 });
    const publisher = await connectClient("publisher-a");
    await publishRetained(publisher, "lab/one", "1");
    await publishRetained(publisher, "lab/two", "2");
    expect(metrics.snapshot().retainedTopics).toBe(2);

    const other = await connectClient("publisher-b");
    await publishRetained(other, "lab/three", "3");
    expect(metrics.snapshot().retainedTopics).toBe(2);

    expect(await retainedNow("reader-a")).toEqual({ "lab/one": "1", "lab/two": "2" });
  });

  it("still takes a new value for a topic that holds one, and a message that is not retained", async () => {
    const metrics = await start({ retainedMaxTopics: 1 });
    const publisher = await connectClient("publisher-c");
    await publishRetained(publisher, "lab/one", "first");
    await publishRetained(publisher, "lab/one", "second");
    expect(metrics.snapshot().retainedTopics).toBe(1);
    expect(await retainedNow("reader-b")).toEqual({ "lab/one": "second" });

    const live = await connectClient("publisher-d");
    await new Promise<void>((resolve) => live.publish("lab/live", "x", { qos: 1, retain: false }, () => resolve()));
    expect(metrics.snapshot().retainedTopics).toBe(1);
  });

  it("frees a place when a retained message is cleared with an empty payload", async () => {
    const metrics = await start({ retainedMaxTopics: 1 });
    const publisher = await connectClient("publisher-e");
    await publishRetained(publisher, "lab/one", "1");
    await publishRetained(publisher, "lab/one", "");
    expect(metrics.snapshot().retainedTopics).toBe(0);

    const next = await connectClient("publisher-f");
    await publishRetained(next, "lab/two", "2");
    expect(metrics.snapshot().retainedTopics).toBe(1);
    expect(await retainedNow("reader-c")).toEqual({ "lab/two": "2" });
  });

  it("has no cap by default", async () => {
    const metrics = await start({});
    const publisher = await connectClient("publisher-g");
    for (let i = 0; i < 25; i += 1) await publishRetained(publisher, `lab/t${i}`, "v");
    expect(metrics.snapshot().retainedTopics).toBe(25);
  });
});

describe("the retained metrics", () => {
  it("count the topics that hold one and the ones that expired, and render both", async () => {
    const metrics = await start({ retainedTtlMs: 150 });
    const publisher = await connectClient("publisher-h");
    await publishRetained(publisher, "lab/old", "1");
    expect(metrics.snapshot().retainedTopics).toBe(1);
    expect(metrics.renderPrometheus()).toContain("hydra_mqtt_retained_topics 1\n");

    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = metrics.snapshot();
    expect(after.retainedTopics).toBe(0);
    expect(after.retainedExpiredTotal).toBe(1);
    const text = metrics.renderPrometheus();
    expect(text).toContain("hydra_mqtt_retained_topics 0\n");
    expect(text).toContain("hydra_mqtt_retained_expired_total 1\n");
  });
});
