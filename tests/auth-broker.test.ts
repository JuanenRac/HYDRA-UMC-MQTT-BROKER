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
import type { AclRule } from "../src/acl.js";

const TEST_PORT = 41885;
const CREDENTIALS = [{ username: "robot-1", password: "test-secret", clientIdPrefix: "robot-" }];

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

  it("MQTT-01: rejects a real client presenting valid credentials under a client ID outside its own authorized prefix", async () => {
    // The exact combination the finding describes: a REAL, valid
    // credential (correct username/password) trying to CONNECT under a
    // client ID it was never authorized for.
    await expect(
      connectionIsRejected({ username: "robot-1", password: "test-secret", clientId: "dashboard-admin" }),
    ).resolves.toBeUndefined();
  });
});

describe("MQTT-01: authentication identity is bound through to real ACL enforcement", () => {
  // A distinct port: this describe block's own beforeEach runs IN ADDITION
  // to (not instead of) the file-level beforeEach above, which would
  // otherwise try to bind the shared TEST_PORT a second time before the
  // first broker is closed.
  const COMBINED_PORT = 41888;
  const RULES: AclRule[] = [
    { clientIdPrefix: "robot-", publish: ["hydra/robots/+/status"], subscribe: [] },
    { clientIdPrefix: "dashboard-", publish: [], subscribe: ["hydra/#"] },
  ];
  const TWO_USERS = [
    { username: "robot-1", password: "robot-secret", clientIdPrefix: "robot-" },
    { username: "dashboard-admin", password: "dashboard-secret", clientIdPrefix: "dashboard-" },
  ];
  let combinedBroker: Aedes;
  let combinedServer: Server;

  beforeEach(async () => {
    const built = await buildBroker(COMBINED_PORT, { credentials: TWO_USERS, acl: RULES });
    combinedBroker = built.broker;
    combinedServer = built.server;
  });

  afterEach(async () => {
    // Drain this describe block's own clients FIRST - a still-open
    // connection would otherwise block server.close()'s callback forever,
    // since it waits for every existing connection to end. The outer
    // file-level afterEach (which runs after this one) safely no-ops on
    // the now-empty `clients` array.
    await Promise.all(clients.splice(0).map((client) => new Promise<void>((resolve) => client.end(true, {}, () => resolve()))));
    await new Promise<void>((resolve) => combinedServer.close(() => resolve()));
    await new Promise<void>((resolve) => combinedBroker.close(() => resolve()));
  });

  function connectCombined(options: IClientOptions): Promise<MqttClient> {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(`mqtt://127.0.0.1:${COMBINED_PORT}`, { connectTimeout: 1500, reconnectPeriod: 0, ...options });
      clients.push(client);
      client.once("connect", () => resolve(client));
      client.once("error", reject);
    });
  }

  function combinedConnectionIsRejected(options: IClientOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(`mqtt://127.0.0.1:${COMBINED_PORT}`, { connectTimeout: 1500, reconnectPeriod: 0, ...options });
      clients.push(client);
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

  it("a real, lower-privilege robot credential cannot authenticate under the dashboard's privileged prefix to reach ACL-gated topics", async () => {
    // Before the fix: this real CONNECT would have succeeded (username/
    // password alone were checked), then the ACL would have granted this
    // client "dashboard-"-scoped subscribe access the robot-1 identity was
    // never meant to have.
    await expect(
      combinedConnectionIsRejected({ username: "robot-1", password: "robot-secret", clientId: "dashboard-admin" }),
    ).resolves.toBeUndefined();
  });

  it("the same real credential still works normally under its own authorized prefix", async () => {
    const client = await connectCombined({ username: "robot-1", password: "robot-secret", clientId: "robot-42" });
    expect(client.connected).toBe(true);
  });
});
