// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/discovery-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Against a real broker and real clients: Home Assistant discovery of the bridges is off by default, and when it is on a bridge that publishes its health
// is announced once and retained for a Home Assistant that connects later. The second block is the topic family of the HYDRA-UMC-SERVER bridge
// (hydra/swarm/...) under the ACL that the documentation proposes: the server publishes state, an operator account may command, a dashboard only reads.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";
import type { AclRule } from "../src/acl.js";

const TEST_PORT = 41893;

let broker: Aedes | undefined;
let server: Server | undefined;
const clients: MqttClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (broker) await new Promise<void>((resolve) => broker!.close(() => resolve()));
  server = undefined;
  broker = undefined;
});

function connectClient(clientId: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${TEST_PORT}`, { clientId, connectTimeout: 5000, reconnectPeriod: 0 });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

const publish = (client: MqttClient, topic: string, payload: string, retain = false) =>
  new Promise<void>((resolve, reject) => client.publish(topic, payload, { qos: 1, retain }, (err) => (err ? reject(err) : resolve())));

function collect(client: MqttClient, filter: string, waitMs = 400): Promise<{ topic: string; text: string; retain: boolean }[]> {
  return new Promise((resolve) => {
    const seen: { topic: string; text: string; retain: boolean }[] = [];
    client.on("message", (topic, payload, packet) => seen.push({ topic, text: payload.toString(), retain: packet.retain }));
    client.subscribe(filter, { qos: 1 }, () => setTimeout(() => resolve(seen), waitMs));
  });
}

function waitForClose(client: MqttClient, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    client.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const HEALTH = JSON.stringify({ schema_version: "1.0", state: "READY", timestamp_utc: "2026-01-01T10:00:00Z", checks: { process: "ok" } });

describe("Home Assistant discovery of the bridges over a real broker", () => {
  it("publishes nothing of the kind when it is off (the default)", async () => {
    const built = await buildBroker(TEST_PORT, {});
    broker = built.broker;
    server = built.server;
    const bridge = await connectClient("bridge-cnc");
    await publish(bridge, "hydra/bridges/cnc-1/health", HEALTH, true);
    const ha = await connectClient("home-assistant");
    expect(await collect(ha, "homeassistant/#")).toEqual([]);
  });

  it("announces a bridge once, retained, so a Home Assistant that connects later still finds it", async () => {
    const built = await buildBroker(TEST_PORT, { homeAssistant: { discoveryPrefix: "homeassistant" } });
    broker = built.broker;
    server = built.server;
    const bridge = await connectClient("bridge-cnc");
    await publish(bridge, "hydra/bridges/cnc-1/health", HEALTH, true);
    await publish(bridge, "hydra/bridges/cnc-1/health", HEALTH, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ha = await connectClient("home-assistant");
    const seen = await collect(ha, "homeassistant/#");
    expect(seen.map((m) => m.topic).sort()).toEqual([
      "homeassistant/binary_sensor/hydra_umc_bridge_cnc_1/online/config",
      "homeassistant/sensor/hydra_umc_bridge_cnc_1/state/config",
    ]);
    expect(seen.every((m) => m.retain)).toBe(true);
    expect(JSON.parse(seen[0].text).state_topic).toBe("hydra/bridges/cnc-1/health");
  });

  it("does not announce what is not a bridge health topic", async () => {
    const built = await buildBroker(TEST_PORT, { homeAssistant: { discoveryPrefix: "homeassistant" } });
    broker = built.broker;
    server = built.server;
    const bridge = await connectClient("bridge-cnc");
    await publish(bridge, "hydra/bridges/cnc-1/state", "{}");
    await publish(bridge, "hydra/swarm/robot_1/state", "{}");
    const ha = await connectClient("home-assistant");
    expect(await collect(ha, "homeassistant/#")).toEqual([]);
  });
});

// The rules the documentation proposes for the topic family of HYDRA-UMC-SERVER.
const SWARM_ACL: AclRule[] = [
  { clientIdPrefix: "hydra-umc-server-", publish: ["hydra/swarm/status", "hydra/swarm/+/state", "hydra/swarm/+/joints", "hydra/swarm/+/tool", "hydra/swarm/safety/estop", "hydra/swarm/+/cmd/+/result", "homeassistant/#"], subscribe: ["hydra/swarm/+/cmd/+"] },
  { clientIdPrefix: "operator-", publish: ["hydra/swarm/+/cmd/+"], subscribe: ["hydra/swarm/#"] },
  { clientIdPrefix: "dashboard-", publish: [], subscribe: ["hydra/swarm/#"] },
];

describe("the hydra/swarm topics of the server bridge under the proposed ACL", () => {
  it("lets the server publish state, an operator command and a dashboard only read", async () => {
    const built = await buildBroker(TEST_PORT, { acl: SWARM_ACL });
    broker = built.broker;
    server = built.server;
    const bridgeOfServer = await connectClient("hydra-umc-server-ab12cd34");
    const operator = await connectClient("operator-1");
    const dashboard = await connectClient("dashboard-1");

    const commands: string[] = [];
    bridgeOfServer.on("message", (topic) => commands.push(topic));
    await new Promise<void>((resolve) => bridgeOfServer.subscribe("hydra/swarm/+/cmd/+", { qos: 1 }, () => resolve()));

    await publish(bridgeOfServer, "hydra/swarm/robot_1/state", '{"id":1,"online":true}', true);
    const seenByDashboard = await collect(dashboard, "hydra/swarm/#");
    expect(seenByDashboard.map((m) => m.topic)).toEqual(["hydra/swarm/robot_1/state"]);

    await publish(operator, "hydra/swarm/robot_1/cmd/stop", "{}");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(commands).toEqual(["hydra/swarm/robot_1/cmd/stop"]);

    // The dashboard may not command, and a stranger may neither publish nor read: the broker closes the connection of a denied publish and refuses a denied subscription.
    dashboard.publish("hydra/swarm/robot_1/cmd/stop", "{}", { qos: 1 });
    expect(await waitForClose(dashboard)).toBe(true);
    expect(commands).toEqual(["hydra/swarm/robot_1/cmd/stop"]);
    const stranger = await connectClient("stranger-1");
    const refused = await new Promise<Error | undefined>((resolve) => stranger.subscribe("hydra/swarm/#", (e) => resolve(e ?? undefined)));
    expect(refused).toBeDefined();
    stranger.publish("hydra/swarm/robot_1/state", '{"online":false}', { qos: 1 });
    expect(await waitForClose(stranger)).toBe(true);
  });
});
