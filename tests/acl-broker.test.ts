// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/acl-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real, protocol-level negative tests - a real "mqtt" client over a real
// TCP socket attempting a disallowed PUBLISH, a scope-broadening SUBSCRIBE,
// and an oversized payload, against a real Aedes broker with buildBroker's
// new opt-in ACL/maxPayloadBytes enabled. This is the "Evidencia" the
// promotion audit asks for - real rejection, not just unit math.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker, type BuildBrokerOptions } from "../src/server.js";
import type { AclRule } from "../src/acl.js";

const TEST_PORT = 41884;

const RULES: AclRule[] = [
  { clientIdPrefix: "robot-", publish: ["hydra/robots/+/status"], subscribe: ["hydra/robots/+/command"] },
  { clientIdPrefix: "dashboard-", publish: [], subscribe: ["hydra/#"] },
];

let broker: Aedes;
let server: Server;
const clients: MqttClient[] = [];

async function startBroker(options: BuildBrokerOptions) {
  const built = await buildBroker(TEST_PORT, options);
  broker = built.broker;
  server = built.server;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

function connectClient(clientId: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    // reconnectPeriod: 0 - a denied client must not keep silently retrying
    // in the background and confusing the next test's timing; it should
    // just observe that the connection was closed, like a real client
    // handling a real rejection would.
    const client = mqtt.connect(`mqtt://127.0.0.1:${TEST_PORT}`, { clientId, connectTimeout: 5000, reconnectPeriod: 0 });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

// Real, observed Aedes behavior (verified against its own node_modules
// source, lib/client.js's _onError): an authorizePublish rejection doesn't
// NACK the one message, it destroys the whole client connection - so a
// denied publish is proven by the connection actually closing, not by a
// per-message callback error (which for QoS 1 never arrives once the
// connection is gone).
function waitForClose(client: MqttClient, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    client.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("real ACL enforcement over a real broker/client", () => {
  beforeEach(async () => {
    await startBroker({ acl: RULES });
  });

  it("allows a robot to publish its own status topic (positive control)", async () => {
    const robot = await connectClient("robot-1");
    const err = await new Promise<Error | undefined>((resolve) => {
      robot.publish("hydra/robots/1/status", "online", { qos: 1 }, (e) => resolve(e ?? undefined));
    });
    expect(err).toBeUndefined();
  });

  it("rejects a robot publishing to a topic its ACL rule never granted (broker closes the connection)", async () => {
    const robot = await connectClient("robot-1");
    robot.publish("hydra/robots/1/command", "reboot", { qos: 1 });
    expect(await waitForClose(robot)).toBe(true);
  });

  it("rejects a robot subscribing with a wildcard that would broaden its granted scope", async () => {
    const robot = await connectClient("robot-1");
    const err = await new Promise<Error | undefined>((resolve) => {
      robot.subscribe("hydra/robots/#", (e) => resolve(e ?? undefined));
    });
    // Real, observed behavior: a denied filter is granted SUBACK reason
    // code 128 ("negate subscription", per Aedes's own test suite), which
    // this MQTT.js client version surfaces as a real subscribe() error.
    expect(err).toBeDefined();
  });

  it("allows a robot to subscribe to its own granted command topic (positive control)", async () => {
    const robot = await connectClient("robot-1");
    const granted = await new Promise<{ topic: string; qos: number }[]>((resolve, reject) => {
      robot.subscribe("hydra/robots/1/command", (err, g) => (err ? reject(err) : resolve(g ?? [])));
    });
    expect(granted[0]?.qos).not.toBe(128);
  });

  it("a denied publish never actually reaches a real subscriber", async () => {
    const dashboard = await connectClient("dashboard-1");
    const robot = await connectClient("robot-1");

    let receivedCount = 0;
    dashboard.on("message", () => {
      receivedCount += 1;
    });
    await new Promise<void>((resolve, reject) => {
      dashboard.subscribe("hydra/#", (err) => (err ? reject(err) : resolve()));
    });

    // robot-1 is not allowed to publish to hydra/robots/1/command - this
    // must never arrive at the dashboard even though it's subscribed to
    // everything.
    robot.publish("hydra/robots/1/command", "reboot", { qos: 1 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedCount).toBe(0);
  });

  it("denies a client whose ID matches no ACL rule at all", async () => {
    const anonymous = await connectClient("anonymous-abc");
    anonymous.publish("hydra/robots/1/status", "online", { qos: 1 });
    expect(await waitForClose(anonymous)).toBe(true);
  });
});

describe("buildBroker with no options (default, unchanged behavior)", () => {
  beforeEach(async () => {
    await startBroker({});
  });

  it("still allows any client to publish anywhere - ACL is opt-in, not default-on", async () => {
    const client = await connectClient("literally-anyone");
    const err = await new Promise<Error | undefined>((resolve) => {
      client.publish("any/topic/at/all", "hello", { qos: 1 }, (e) => resolve(e ?? undefined));
    });
    expect(err).toBeUndefined();
  });
});

describe("real payload size limit", () => {
  beforeEach(async () => {
    await startBroker({ maxPayloadBytes: 16 });
  });

  it("accepts a payload within the limit (positive control)", async () => {
    const client = await connectClient("small-payload-client");
    const err = await new Promise<Error | undefined>((resolve) => {
      client.publish("hydra/swarm/status", "ok", { qos: 1 }, (e) => resolve(e ?? undefined));
    });
    expect(err).toBeUndefined();
  });

  it("rejects a real oversized payload (broker closes the connection)", async () => {
    const client = await connectClient("large-payload-client");
    const oversized = "x".repeat(64);
    client.publish("hydra/swarm/status", oversized, { qos: 1 });
    expect(await waitForClose(client)).toBe(true);
  });
});
