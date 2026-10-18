// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/hardening-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real-broker checks for retained expiry, WebSocket closing, orderly shutdown,
// TLS, long client IDs and metric accuracy.
// =============================================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mqtt, { type MqttClient } from "mqtt";
import WebSocket from "ws";
import { buildBroker, closeBroker } from "../src/server.js";

type Built = Awaited<ReturnType<typeof buildBroker>>;

// Distinct ports: vitest runs the test files in parallel workers.
let nextPort = 41920;
const port = () => nextPort++;

const clients: MqttClient[] = [];
const built: Built[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  for (const b of built.splice(0)) await closeBroker(b, 2000);
});

async function start(brokerPort: number, options: Parameters<typeof buildBroker>[1] = {}): Promise<Built> {
  const b = await buildBroker(brokerPort, { host: "127.0.0.1", ...options });
  built.push(b);
  for (const l of [b.server, b.wsServer, b.tlsServer, b.wssServer]) {
    if (l && !l.listening) await new Promise<void>((resolve) => l.once("listening", () => resolve()));
  }
  return b;
}

function connect(url: string, opts: mqtt.IClientOptions = {}): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { connectTimeout: 5000, reconnectPeriod: 0, ...opts });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
    client.once("close", () => reject(new Error("closed before connecting")));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("retained expiry", () => {
  it("clears the retained message without handing a live copy to subscribers", async () => {
    const p = port();
    await start(p, { retainedTtlMs: 300 });
    const publisher = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "ttl-publisher" });
    await new Promise<void>((resolve, reject) =>
      publisher.publish("hydra/bridges/x/cmd/job", "go", { qos: 1, retain: true }, (e) => (e ? reject(e) : resolve())),
    );
    const subscriber = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "ttl-subscriber" });
    const received: { payload: string; retain: boolean }[] = [];
    subscriber.on("message", (_t, payload, packet) => received.push({ payload: payload.toString(), retain: packet.retain }));
    await new Promise<void>((resolve) => subscriber.subscribe("hydra/bridges/x/cmd/#", () => resolve()));
    await sleep(1200); // past the TTL and at least one sweep
    expect(received).toEqual([{ payload: "go", retain: true }]);

    const late = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "ttl-late" });
    let lateMessage = false;
    late.on("message", () => (lateMessage = true));
    await new Promise<void>((resolve) => late.subscribe("hydra/bridges/x/cmd/#", () => resolve()));
    await sleep(300);
    expect(lateMessage).toBe(false);
  });
});

describe("WebSocket transport", () => {
  it("closes the WebSocket when the broker rejects the client", async () => {
    const p = port();
    const wsPort = port();
    await start(p, { wsPort });
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`, "mqtt");
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.send(Buffer.from([0x00, 0x00])); // packet type 0 is a protocol error
    await Promise.race([closed, sleep(3000).then(() => Promise.reject(new Error("the WebSocket stayed open")))]);
  });

  it("refuses a browser origin that is not on the allow-list and accepts one that is", async () => {
    const p = port();
    const wsPort = port();
    await start(p, { wsPort, wsAllowedOrigins: ["https://studio.example"] });
    const attempt = (origin: string) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`, "mqtt", { origin });
        socket.once("open", () => { socket.close(); resolve(true); });
        socket.once("error", () => resolve(false));
        socket.once("unexpected-response", () => resolve(false));
      });
    expect(await attempt("https://evil.example")).toBe(false);
    expect(await attempt("https://studio.example")).toBe(true);
  });

  it("refuses a frame larger than the payload cap", async () => {
    const p = port();
    const wsPort = port();
    await start(p, { wsPort, maxPayloadBytes: 1024 });
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`, "mqtt");
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(Buffer.alloc(200_000, 1));
    // 1009 (message too big) or 1006 (the socket was dropped): either way it is closed.
    expect(await Promise.race([closed, sleep(3000).then(() => -1)])).toBeGreaterThan(0);
  });
});

describe("orderly shutdown", () => {
  it("closes the broker while a client is still connected", async () => {
    const p = port();
    const b = await start(p);
    await connect(`mqtt://127.0.0.1:${p}`, { clientId: "stays-connected" });
    const started = Date.now();
    await closeBroker(b, 5000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(b.server.listening).toBe(false);
  });
});

describe("client identifiers", () => {
  it("accepts a 26-character client ID at MQTT 3.1", async () => {
    const p = port();
    await start(p);
    const id = "hydra-umc-bridge-printer3d";
    expect(id.length).toBe(26);
    const client = await connect(`mqtt://127.0.0.1:${p}`, { clientId: id, protocolId: "MQIsdp", protocolVersion: 3 });
    expect(client.connected).toBe(true);
  });
});

describe("metrics accuracy", () => {
  it("does not count a rejected login as a connected client, nor a denied publish as a message", async () => {
    const p = port();
    const b = await start(p, {
      credentials: [{ username: "u", password: "correct-password-1234", clientIdPrefix: "ok-" }],
      acl: [{ clientIdPrefix: "ok-", publish: ["allowed/#"], subscribe: ["allowed/#"] }],
    });
    await expect(
      connect(`mqtt://127.0.0.1:${p}`, { clientId: "ok-bad", username: "u", password: "wrong" }),
    ).rejects.toBeTruthy();
    await sleep(200);
    expect(b.metrics.snapshot().connectedClients).toBe(0);

    const good = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "ok-good", username: "u", password: "correct-password-1234" });
    expect(b.metrics.snapshot().connectedClients).toBe(1);
    good.publish("allowed/a", "x", { qos: 0 });
    await sleep(200);
    expect(b.metrics.snapshot().messagesTotal).toBe(1);
    good.publish("denied/a", "x", { qos: 0 });
    await sleep(300);
    const snapshot = b.metrics.snapshot();
    expect(snapshot.messagesTotal).toBe(1);
    expect(snapshot.aclDeniedTotal).toBe(1);
    expect(b.metrics.renderPrometheus()).toContain("hydra_mqtt_acl_denied_total 1");
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)("TLS", () => {
  let dir = "";
  const read = (name: string) => readFileSync(path.join(dir, name));
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hydra-umc-mqtt-tls-"));
    // A minimal config of its own: the machine-wide one may be missing or point nowhere.
    writeFileSync(path.join(dir, "openssl.cnf"), ["[req]", "distinguished_name = dn", "[dn]", ""].join("\n"));
    const run = (args: string[]) =>
      execFileSync("openssl", args, { cwd: dir, stdio: "ignore", env: { ...process.env, OPENSSL_CONF: path.join(dir, "openssl.cnf") } });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=test-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE"]);
    for (const name of ["server", "client"]) {
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name === "server" ? "localhost" : "client-1"}`]);
      run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2"]);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("serves MQTT over TLS and over secure WebSocket", async () => {
    const p = port();
    const tlsPort = port();
    const wssPort = port();
    await start(p, { tls: { cert: read("server.pem"), key: read("server.key") }, tlsPort, wssPort });
    const secure = await connect(`mqtts://127.0.0.1:${tlsPort}`, { ca: read("ca.pem"), servername: "localhost", rejectUnauthorized: false });
    expect(secure.connected).toBe(true);
    const secureWs = await connect(`wss://127.0.0.1:${wssPort}`, { ca: read("ca.pem"), rejectUnauthorized: false });
    expect(secureWs.connected).toBe(true);
  });

  it("requires a client certificate when mutual TLS is on", async () => {
    const p = port();
    const tlsPort = port();
    await start(p, { tls: { cert: read("server.pem"), key: read("server.key"), ca: read("ca.pem"), requireClientCert: true }, tlsPort });
    await expect(connect(`mqtts://127.0.0.1:${tlsPort}`, { rejectUnauthorized: false })).rejects.toBeTruthy();
    const withCert = await connect(`mqtts://127.0.0.1:${tlsPort}`, { cert: read("client.pem"), key: read("client.key"), rejectUnauthorized: false });
    expect(withCert.connected).toBe(true);
  });
});
