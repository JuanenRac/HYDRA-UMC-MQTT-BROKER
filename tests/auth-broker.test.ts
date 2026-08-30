// =============================================================================
// HYDRA-UMC-MQTT-BROKER - Real MQTT CONNECT authentication tests
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// These tests use real MQTT clients and a real Aedes TCP listener.  They prove
// that a client cannot merely choose an ACL-looking client ID: it must also
// complete CONNECT with a configured credential.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";

const TEST_PORT = 41885;
const CREDENTIALS = [{ username: "robot-1", password: "test-secret" }];

let broker: Aedes;
let server: Server;
const clients: MqttClient[] = [];

beforeEach(async () => {
  const built = await buildBroker(TEST_PORT, { credentials: CREDENTIALS });
  broker = built.broker;
  server = built.server;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => new Promise<void>((resolve) => client.end(true, {}, () => resolve()))));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

function createClient(options: IClientOptions): MqttClient {
  const client = mqtt.connect(`mqtt://127.0.0.1:${TEST_PORT}`, {
    clientId: "robot-client",
    connectTimeout: 1500,
    reconnectPeriod: 0,
    ...options,
  });
  clients.push(client);
  return client;
}

function connect(options: IClientOptions): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = createClient(options);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

function connectionIsRejected(options: IClientOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createClient(options);
    const timer = setTimeout(() => reject(new Error("authentication rejection timed out")), 2000);
    client.once("connect", () => {
      clearTimeout(timer);
      reject(new Error("unauthenticated client unexpectedly connected"));
    });
    client.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("real MQTT CONNECT authentication", () => {
  it("accepts a real client with a configured credential", async () => {
    const client = await connect({ username: "robot-1", password: "test-secret" });
    expect(client.connected).toBe(true);
  });

  it("rejects a real client with a wrong password", async () => {
    await expect(connectionIsRejected({ username: "robot-1", password: "wrong-secret" })).resolves.toBeUndefined();
  });

  it("rejects a real client that omits credentials", async () => {
    await expect(connectionIsRejected({})).resolves.toBeUndefined();
  });
});
