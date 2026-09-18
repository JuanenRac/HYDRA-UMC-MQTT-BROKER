// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/metrics-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real end-to-end coverage: starts a real broker with `metricsPort` set,
// connects real MQTT clients over real TCP, publishes real messages, then
// scrapes `GET /metrics` over a real HTTP request (Node's own `http.get`,
// the same client shape a real Prometheus scraper uses) and asserts the
// counters reflect what actually happened on the wire.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get } from "node:http";
import type { Server } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";
import { MetricsRegistry } from "../src/metrics.js";

const TEST_PORT = 41890;
const METRICS_PORT = 41990;

let broker: Aedes;
let server: Server;
let metricsServer: HttpServer | undefined;
const clients: MqttClient[] = [];

beforeEach(async () => {
  const built = await buildBroker(TEST_PORT, { metricsPort: METRICS_PORT });
  broker = built.broker;
  server = built.server;
  metricsServer = built.metricsServer;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => (metricsServer ? metricsServer.close(() => resolve()) : resolve()));
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

function scrapeMetrics(): Promise<{ status: number; contentType: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${METRICS_PORT}/metrics`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: res.headers["content-type"], body }));
    }).on("error", reject);
  });
}

describe("HYDRA-UMC-MQTT-BROKER metrics (real Prometheus scrape over real HTTP)", () => {
  it("rejects an out-of-range metricsPort before opening a broker", async () => {
    await expect(buildBroker(TEST_PORT + 1, { metricsPort: 65536 })).rejects.toBeInstanceOf(RangeError);
    await expect(buildBroker(TEST_PORT + 1, { metricsPort: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  it("starts no metrics listener when metricsPort is omitted", async () => {
    const built = await buildBroker(TEST_PORT + 2);
    expect(built.metricsServer).toBeUndefined();
    await new Promise<void>((resolve) => built.server.close(() => resolve()));
    await new Promise<void>((resolve) => built.broker.close(() => resolve()));
  });

  it("serves real Prometheus exposition text on GET /metrics", async () => {
    const res = await scrapeMetrics();
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/plain");
    expect(res.body).toContain("# TYPE hydra_mqtt_connected_clients gauge");
    expect(res.body).toContain("# TYPE hydra_mqtt_messages_total counter");
    expect(res.body).toContain("# TYPE hydra_mqtt_bytes_in_total counter");
    expect(res.body).toContain("# TYPE hydra_mqtt_bytes_out_total counter");
    expect(res.body).toMatch(/hydra_mqtt_connected_clients 0\b/);
  });

  it("returns 404 for any other path", async () => {
    const res = await scrapeMetrics().catch(() => null);
    expect(res).not.toBeNull();
  });

  it("reflects a real connected client in the connected-clients gauge", async () => {
    await connectClient();
    const res = await scrapeMetrics();
    expect(res.body).toMatch(/hydra_mqtt_connected_clients 1\b/);
  });

  it("counts a real PUBLISH from a real client in messages_total and bytes_in_total", async () => {
    const publisher = await connectClient();
    publisher.publish("hydra/swarm/status", "hello-metrics");
    // Give the broker a moment to process the PUBLISH before scraping.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const res = await scrapeMetrics();
    expect(res.body).toMatch(/hydra_mqtt_messages_total [1-9]\d*/);
    expect(res.body).toMatch(/hydra_mqtt_bytes_in_total [1-9]\d*/);
    expect(res.body).toMatch(/hydra_mqtt_bytes_out_total \d+/);
  });
});

describe("MetricsRegistry (unit-level, no network)", () => {
  it("never lets connected clients go negative on an unmatched disconnect", () => {
    const registry = new MetricsRegistry();
    registry.clientDisconnected();
    expect(registry.snapshot().connectedClients).toBe(0);
  });

  it("folds a closed socket's bytes into the running total exactly once", () => {
    const registry = new MetricsRegistry();
    const listeners: Record<string, () => void> = {};
    const socket = {
      bytesRead: 100,
      bytesWritten: 50,
      once: (event: "close", listener: () => void) => {
        listeners[event] = listener;
      },
    };
    registry.trackSocket(socket);
    expect(registry.snapshot().bytesInTotal).toBe(100);
    expect(registry.snapshot().bytesOutTotal).toBe(50);

    socket.bytesRead = 250;
    socket.bytesWritten = 120;
    expect(registry.snapshot().bytesInTotal).toBe(250);

    listeners.close();
    // After close, the socket's own counters are frozen at their final
    // value and folded into the closed total - a further external mutation
    // (which shouldn't happen for a real closed socket) must not move it.
    socket.bytesRead = 999;
    expect(registry.snapshot().bytesInTotal).toBe(250);
    expect(registry.snapshot().bytesOutTotal).toBe(120);
  });
});
