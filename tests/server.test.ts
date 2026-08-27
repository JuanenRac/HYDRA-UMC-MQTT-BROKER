// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/server.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real protocol-level tests: starts a real Aedes broker over a real TCP
// socket and connects real MQTT clients (the "mqtt" npm package, the same
// library a real IoT device/dashboard would use) against it - proving
// CONNECT/PUBLISH/SUBSCRIBE actually work over the wire, not just that
// Aedes's internal event emitters fire.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";

const TEST_PORT = 41883;

let broker: Aedes;
let server: Server;
const clients: MqttClient[] = [];

beforeEach(async () => {
  const built = await buildBroker(TEST_PORT);
  broker = built.broker;
  server = built.server;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

function connectClient(): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${TEST_PORT}`, { connectTimeout: 5000 });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

describe("HYDRA-UMC-MQTT-BROKER (real MQTT protocol over real TCP)", () => {
  it("accepts a real client CONNECT", async () => {
    const client = await connectClient();
    expect(client.connected).toBe(true);
  });

  it("delivers a real PUBLISH to a real SUBSCRIBEd client", async () => {
    const subscriber = await connectClient();
    const publisher = await connectClient();

    const received = new Promise<{ topic: string; payload: string }>((resolve) => {
      subscriber.on("message", (topic, payload) => {
        resolve({ topic, payload: payload.toString() });
      });
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.subscribe("hydra/swarm/status", (err) => (err ? reject(err) : resolve()));
    });

    publisher.publish("hydra/swarm/status", "online");

    const msg = await received;
    expect(msg.topic).toBe("hydra/swarm/status");
    expect(msg.payload).toBe("online");
  });

  it("does not deliver to a client subscribed to a different topic", async () => {
    const subscriber = await connectClient();
    const publisher = await connectClient();

    let receivedCount = 0;
    subscriber.on("message", () => {
      receivedCount += 1;
    });

    await new Promise<void>((resolve, reject) => {
      subscriber.subscribe("hydra/robots/1/status", (err) => (err ? reject(err) : resolve()));
    });

    publisher.publish("hydra/robots/2/status", "busy");

    // No reliable "did not arrive" signal in MQTT itself - a short real
    // wait is the honest way to assert an unsubscribed topic's message
    // never shows up, matching how this kind of negative case is tested
    // in this ecosystem's other pub/sub tests.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedCount).toBe(0);
  });

  it("honors a real retained message for a client that subscribes afterward", async () => {
    const publisher = await connectClient();
    publisher.publish("hydra/swarm/status", "retained-value", { retain: true });

    // Give the broker a moment to persist the retained message before the
    // next client subscribes.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lateSubscriber = await connectClient();
    const received = new Promise<string>((resolve) => {
      lateSubscriber.on("message", (_topic, payload) => resolve(payload.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      lateSubscriber.subscribe("hydra/swarm/status", (err) => (err ? reject(err) : resolve()));
    });

    expect(await received).toBe("retained-value");
  });
});
