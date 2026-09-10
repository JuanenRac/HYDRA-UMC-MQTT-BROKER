// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/ws-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real protocol-level tests for the opt-in MQTT-over-WebSocket listener
// (previously untested) - starts a real Aedes broker with `wsPort` set and connects a
// real MQTT client (the "mqtt" npm package, over a real `ws://` URL) -
// proving CONNECT/PUBLISH/SUBSCRIBE actually work over WebSocket, not just
// that `buildBroker()` returns a truthy `wsServer` handle. Same "real
// client over a real socket" convention as tests/server.test.ts, just
// over WS instead of plain TCP.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";

// 41883/41884/41885 are already taken by server.test.ts/acl-broker.test.ts/
// auth-broker.test.ts respectively, which vitest runs concurrently in
// separate workers - picking distinct ports here avoids a real EADDRINUSE
// race against those sibling test files.
const TEST_PORT = 41886;
const TEST_WS_PORT = 41887;

let broker: Aedes;
let server: Server;
let wsServer: HttpServer | undefined;
const clients: MqttClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (wsServer) {
    await new Promise<void>((resolve) => wsServer!.close(() => resolve()));
  }
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

function connectWsClient(port: number): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`ws://127.0.0.1:${port}`, { connectTimeout: 5000 });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

describe("HYDRA-UMC-MQTT-BROKER (real MQTT protocol over real WebSocket)", () => {
  it("starts no WS listener at all when wsPort is omitted (unchanged default behavior)", async () => {
    const built = await buildBroker(TEST_PORT);
    broker = built.broker;
    server = built.server;
    wsServer = built.wsServer;
    expect(wsServer).toBeUndefined();
  });

  it("rejects an invalid wsPort before opening a broker", async () => {
    await expect(buildBroker(TEST_PORT, { wsPort: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(buildBroker(TEST_PORT, { wsPort: 65536 })).rejects.toBeInstanceOf(RangeError);
    await expect(buildBroker(TEST_PORT, { wsPort: 1.5 })).rejects.toBeInstanceOf(RangeError);
  });

  it("accepts a real client CONNECT over WebSocket when wsPort is set", async () => {
    const built = await buildBroker(TEST_PORT, { wsPort: TEST_WS_PORT });
    broker = built.broker;
    server = built.server;
    wsServer = built.wsServer;
    expect(wsServer).toBeDefined();

    const client = await connectWsClient(TEST_WS_PORT);
    expect(client.connected).toBe(true);
  });

  it("delivers a real PUBLISH from a WS client to a TCP-connected subscriber", async () => {
    // Proves the WS listener reaches the SAME broker instance as the
    // plain-TCP one, not a separate, disconnected Aedes - a client on
    // either transport must see the other's traffic.
    const built = await buildBroker(TEST_PORT, { wsPort: TEST_WS_PORT });
    broker = built.broker;
    server = built.server;
    wsServer = built.wsServer;

    const tcpClient = mqtt.connect(`mqtt://127.0.0.1:${TEST_PORT}`, { connectTimeout: 5000 });
    clients.push(tcpClient);
    await new Promise<void>((resolve, reject) => {
      tcpClient.once("connect", () => resolve());
      tcpClient.once("error", reject);
    });

    const received = new Promise<string>((resolve) => {
      tcpClient.on("message", (_topic, payload) => resolve(payload.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      tcpClient.subscribe("hydra/swarm/status", (err) => (err ? reject(err) : resolve()));
    });

    const wsClient = await connectWsClient(TEST_WS_PORT);
    wsClient.publish("hydra/swarm/status", "online");

    await expect(received).resolves.toBe("online");
  });
});
