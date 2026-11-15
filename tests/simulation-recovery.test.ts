// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/simulation-recovery.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Simulation bench, failure and recovery: the real broker with real MQTT clients (a fixed seed) that come and go. A client that goes silent, a client that
// takes over the identity of another one, a robot that is away while its commands wait, and a broker that is restarted under a live fleet. No hardware.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker, closeBroker } from "../src/server.js";

type Built = Awaited<ReturnType<typeof buildBroker>>;

// A range of its own, apart from the other bench files.
let nextPort = 18700;
const port = () => nextPort++;

const clients: MqttClient[] = [];
const built: Built[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(clients.splice(0).map((c) => new Promise<void>((resolve) => c.end(true, {}, () => resolve()))));
  for (const b of built.splice(0)) await closeBroker(b, 2000);
});

async function start(brokerPort: number, options: Parameters<typeof buildBroker>[1] = {}): Promise<Built> {
  const b = await buildBroker(brokerPort, { host: "127.0.0.1", ...options });
  built.push(b);
  if (!b.server.listening) await new Promise<void>((resolve) => b.server.once("listening", () => resolve()));
  return b;
}

function connect(brokerPort: number, clientId: string, opts: mqtt.IClientOptions = {}): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`, { clientId, connectTimeout: 5000, reconnectPeriod: 0, ...opts });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
    client.once("close", () => reject(new Error(`closed before connecting: ${clientId}`)));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function subscribe(client: MqttClient, filter: string): Promise<void> {
  return new Promise((resolve, reject) => client.subscribe(filter, { qos: 1 }, (error) => (error ? reject(error) : resolve())));
}

function publish(client: MqttClient, topic: string, payload: string | Buffer, opts: mqtt.IClientPublishOptions = { qos: 1 }): Promise<void> {
  return new Promise((resolve, reject) => client.publish(topic, payload, opts, (error) => (error ? reject(error) : resolve())));
}

/** The bytes of an MQTT 3.1.1 CONNECT packet with a will, written by hand: a client that sends it and then says nothing more. */
function silentConnectPacket(clientId: string, keepaliveSeconds: number, willTopic: string, willPayload: string): Buffer {
  const text = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes]);
  };
  const flags = 0x02 | 0x04 | (1 << 3); // clean session, will flag, will QoS 1
  const variableHeader = Buffer.concat([text("MQTT"), Buffer.from([4, flags, keepaliveSeconds >> 8, keepaliveSeconds & 0xff])]);
  const payload = Buffer.concat([text(clientId), text(willTopic), text(willPayload)]);
  const remaining = variableHeader.length + payload.length;
  if (remaining > 127) throw new Error("the packet of the test must be short");
  return Buffer.concat([Buffer.from([0x10, remaining]), variableHeader, payload]);
}

describe("a client that goes silent", () => {
  it("is declared dead after one and a half keep-alive periods and its will reaches the dashboard", async () => {
    const p = port();
    await start(p);
    const watcher = await connect(p, "dashboard-silence");
    const topics: string[] = [];
    watcher.on("message", (topic, payload) => topics.push(`${topic}=${payload.toString()}`));
    await subscribe(watcher, "hydra/bridges/+/health");
    const socket = net.connect(p, "127.0.0.1");
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    // the socket stays open but nothing but the first packet is ever sent: no ping, no goodbye
    socket.write(silentConnectPacket("bridge-silent", 1, "hydra/bridges/silent/health", "offline"));
    let closed = false;
    socket.once("close", () => (closed = true));
    socket.resume(); // read what the broker sends, so that its end of the connection can be seen
    await waitFor(() => topics.includes("hydra/bridges/silent/health=offline"), "the will of the silent bridge", 15000);
    await waitFor(() => closed, "the connection of the silent bridge to be closed", 5000);
    expect(topics).toEqual(["hydra/bridges/silent/health=offline"]);
  });
});

describe("two clients with one identity", () => {
  it("lets the newer connection take over, drops the older one, and keeps delivering to the newer", async () => {
    const p = port();
    await start(p);
    const first = await connect(p, "robot-twin");
    let firstClosed = false;
    first.once("close", () => (firstClosed = true));
    const second = await connect(p, "robot-twin");
    await waitFor(() => firstClosed, "the first connection to be dropped");
    const sender = await connect(p, "dashboard-sender");
    const got: string[] = [];
    second.on("message", (_topic, payload) => got.push(payload.toString()));
    await subscribe(second, "hydra/robots/robot-twin/commands");
    await publish(sender, "hydra/robots/robot-twin/commands", "go");
    await waitFor(() => got.length === 1, "the command on the newer connection");
    expect(got).toEqual(["go"]);
    expect(second.connected).toBe(true);
  });
});

describe("a robot that is away while its commands wait", () => {
  it("receives, in order, what was published to its persistent session while it was gone", async () => {
    const p = port();
    await start(p);
    const robot = await connect(p, "robot-away", { clean: false });
    await subscribe(robot, "hydra/robots/robot-away/commands");
    await new Promise<void>((resolve) => robot.end(false, {}, () => resolve()));
    const sender = await connect(p, "dashboard-queue");
    for (let n = 0; n < 5; n++) await publish(sender, "hydra/robots/robot-away/commands", `step-${n}`);
    const back = await connect(p, "robot-away", { clean: false });
    const got: string[] = [];
    back.on("message", (_topic, payload) => got.push(payload.toString()));
    await waitFor(() => got.length === 5, "the queued commands");
    expect(got).toEqual(["step-0", "step-1", "step-2", "step-3", "step-4"]);
  });

  it("does not receive what was published while it was gone when it comes back with a clean session", async () => {
    const p = port();
    await start(p);
    const robot = await connect(p, "robot-clean", { clean: true });
    await subscribe(robot, "hydra/robots/robot-clean/commands");
    await new Promise<void>((resolve) => robot.end(false, {}, () => resolve()));
    const sender = await connect(p, "dashboard-clean");
    await publish(sender, "hydra/robots/robot-clean/commands", "lost");
    const back = await connect(p, "robot-clean", { clean: true });
    const got: string[] = [];
    back.on("message", (_topic, payload) => got.push(payload.toString()));
    await sleep(400);
    expect(got).toEqual([]);
  });
});

describe("a broker that is restarted under a live fleet", () => {
  it("is found again by clients that reconnect and resubscribe on their own, and the traffic resumes", async () => {
    const p = port();
    const first = await start(p);
    const dashboard = await connect(p, "dashboard-restart", { reconnectPeriod: 100 });
    const robot = await connect(p, "robot-restart", { reconnectPeriod: 100 });
    // refused connections while the broker is down are expected: they are not an error of the test
    dashboard.on("error", () => undefined);
    robot.on("error", () => undefined);
    const got: string[] = [];
    dashboard.on("message", (_topic, payload) => got.push(payload.toString()));
    await subscribe(dashboard, "hydra/robots/robot-restart/telemetry");
    await publish(robot, "hydra/robots/robot-restart/telemetry", "before");
    await waitFor(() => got.length === 1, "the message before the restart");

    let down = 0;
    dashboard.on("close", () => down++);
    await closeBroker(first, 2000);
    built.splice(built.indexOf(first), 1);
    await waitFor(() => down > 0 && !dashboard.connected && !robot.connected, "the clients to notice the loss");

    await start(p);
    await waitFor(() => dashboard.connected && robot.connected, "the clients to reconnect");
    await sleep(200);
    await publish(robot, "hydra/robots/robot-restart/telemetry", "after");
    await waitFor(() => got.includes("after"), "the message after the restart");
    expect(got).toEqual(["before", "after"]);
  });
});
