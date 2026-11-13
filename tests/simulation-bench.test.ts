// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/simulation-bench.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Simulation bench: the real broker with a simulated fleet of robots, bridges and dashboards (real MQTT clients, a fixed seed) that behave badly on
// command: they are killed without a goodbye, they publish where they may not, they send too much, they speak garbage on the wire, they try the wrong
// password and they send commands nobody signed. No hardware is involved. What the bench proves is that the broker keeps serving everybody else.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker, closeBroker } from "../src/server.js";
import type { AclRule } from "../src/acl.js";

type Built = Awaited<ReturnType<typeof buildBroker>>;

// Ports below the range the operating system hands out to outgoing connections; each test of this file uses its own.
let nextPort = 18500;
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

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function subscribe(client: MqttClient, filter: string): Promise<void> {
  return new Promise((resolve, reject) => client.subscribe(filter, { qos: 1 }, (error, granted) => (error ? reject(error) : granted && granted[0] && granted[0].qos === 128 ? reject(new Error("refused")) : resolve())));
}

function publish(client: MqttClient, topic: string, payload: string | Buffer, opts: mqtt.IClientPublishOptions = { qos: 1 }): Promise<void> {
  return new Promise((resolve, reject) => client.publish(topic, payload, opts, (error) => (error ? reject(error) : resolve())));
}

/** A small, repeatable pseudo-random generator (mulberry32): the fleet and the garbage are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260101;
const expected = new Map<string, number>();

describe("a simulated fleet that behaves", () => {
  it("delivers every telemetry message of twenty robots, in order per robot, to a dashboard", async () => {
    const p = port();
    await start(p);
    const dashboard = await connect(p, "dashboard-main");
    const seen = new Map<string, number[]>();
    dashboard.on("message", (topic, payload) => {
      const robot = topic.split("/")[2];
      const list = seen.get(robot) ?? [];
      list.push(Number(JSON.parse(payload.toString()).n));
      seen.set(robot, list);
    });
    await subscribe(dashboard, "hydra/robots/+/telemetry");
    const random = seeded(SEED);
    const robots = await Promise.all(Array.from({ length: 20 }, (_, index) => connect(p, `robot-${index}`)));
    await Promise.all(
      robots.map(async (robot, index) => {
        const count = 5 + Math.floor(random() * 6);
        expected.set(`robot-${index}`, count);
        for (let n = 0; n < count; n++) await publish(robot, `hydra/robots/robot-${index}/telemetry`, JSON.stringify({ n }));
      }),
    );
    await waitFor(() => [...expected].every(([robot, count]) => (seen.get(robot)?.length ?? 0) === count), "all telemetry");
    for (const [robot, count] of expected) {
      expect(seen.get(robot)).toEqual(Array.from({ length: count }, (_, n) => n));
    }
    expected.clear();
  });
});


describe("a robot that dies", () => {
  it("is announced as offline when it is killed and not when it says goodbye", async () => {
    const p = port();
    await start(p);
    const watcher = await connect(p, "dashboard-watch");
    const topics: string[] = [];
    watcher.on("message", (topic, payload) => topics.push(`${topic}=${payload.toString()}`));
    await subscribe(watcher, "hydra/bridges/+/health");
    const will = (name: string) => ({ will: { topic: `hydra/bridges/${name}/health`, payload: Buffer.from("offline"), qos: 1 as const, retain: false } });
    const killed = await connect(p, "bridge-killed", will("killed"));
    const polite = await connect(p, "bridge-polite", will("polite"));
    // the connection of the first bridge is cut without a DISCONNECT packet: what a crash or a pulled cable looks like
    (killed as unknown as { stream: net.Socket }).stream.destroy();
    await new Promise<void>((resolve) => polite.end(false, {}, () => resolve()));
    await waitFor(() => topics.includes("hydra/bridges/killed/health=offline"), "the will of the killed bridge");
    await sleep(300);
    expect(topics).toEqual(["hydra/bridges/killed/health=offline"]);
  });

  it("gets its retained state back when it returns, and a cleared state stays cleared", async () => {
    const p = port();
    await start(p);
    const first = await connect(p, "bridge-a");
    await publish(first, "hydra/bridges/a/state", "IDLE", { qos: 1, retain: true });
    await publish(first, "hydra/bridges/b/state", "RUNNING", { qos: 1, retain: true });
    await publish(first, "hydra/bridges/b/state", "", { qos: 1, retain: true }); // cleared
    const late = await connect(p, "dashboard-late");
    const got = new Map<string, string>();
    late.on("message", (topic, payload, packet) => {
      if (packet.retain) got.set(topic, payload.toString());
    });
    await subscribe(late, "hydra/bridges/+/state");
    await sleep(400);
    expect([...got]).toEqual([["hydra/bridges/a/state", "IDLE"]]);
  });
});

describe("clients that go where they may not", () => {
  const rules: AclRule[] = [
    { clientIdPrefix: "robot-", publish: ["hydra/robots/+/status"], subscribe: ["hydra/robots/+/command"] },
    { clientIdPrefix: "dashboard-", publish: [], subscribe: ["hydra/#"] },
  ];

  it("keeps the dashboard clean and the other robots working while one robot misbehaves", async () => {
    const p = port();
    await start(p, { acl: rules });
    const dashboard = await connect(p, "dashboard-1");
    const topics: string[] = [];
    dashboard.on("message", (topic) => topics.push(topic));
    await subscribe(dashboard, "hydra/#");
    const bad = await connect(p, "robot-bad");
    const closed = new Promise<void>((resolve) => bad.once("close", () => resolve()));
    bad.publish("hydra/robots/robot-bad/secret", "x", { qos: 0 }); // not a topic it may publish to
    const good = await connect(p, "robot-good");
    await publish(good, "hydra/robots/robot-good/status", "ok");
    await waitFor(() => topics.includes("hydra/robots/robot-good/status"), "the status of the good robot");
    await closed;
    expect(topics).not.toContain("hydra/robots/robot-bad/secret");
    // a robot that cannot subscribe outside its scope gets nothing granted
    const snoop = await connect(p, "robot-snoop");
    await expect(subscribe(snoop, "hydra/#")).rejects.toThrow();
  });

  it("refuses a dashboard that tries to publish", async () => {
    const p = port();
    await start(p, { acl: rules });
    const dashboard = await connect(p, "dashboard-2");
    const closed = new Promise<void>((resolve) => dashboard.once("close", () => resolve()));
    dashboard.publish("hydra/robots/robot-1/command", "stop", { qos: 0 });
    await closed;
    const robot = await connect(p, "robot-1");
    const heard: string[] = [];
    robot.on("message", (_topic, payload) => heard.push(payload.toString()));
    await subscribe(robot, "hydra/robots/+/command");
    await sleep(300);
    expect(heard).toEqual([]);
  });
});

describe("a client that sends too much", () => {
  it("drops the oversized message, closes that client and keeps serving the rest", async () => {
    const p = port();
    await start(p, { maxPayloadBytes: 1024 });
    const listener = await connect(p, "dashboard-big");
    const heard: number[] = [];
    listener.on("message", (_topic, payload) => heard.push(payload.length));
    await subscribe(listener, "sim/#");
    const greedy = await connect(p, "robot-greedy");
    const closed = new Promise<void>((resolve) => greedy.once("close", () => resolve()));
    greedy.publish("sim/blob", Buffer.alloc(4096, 1), { qos: 0 });
    await closed;
    const modest = await connect(p, "robot-modest");
    await publish(modest, "sim/small", Buffer.alloc(1024, 2));
    await waitFor(() => heard.length >= 1, "the message at the limit");
    expect(heard).toEqual([1024]);
  });
});

describe("garbage on the wire", () => {
  it("survives fifty connections of random bytes and still answers a real client", async () => {
    const p = port();
    await start(p, { connectTimeoutMs: 500 });
    const random = seeded(SEED + 1);
    for (let index = 0; index < 50; index++) {
      const socket = net.connect(p, "127.0.0.1");
      sockets.push(socket);
      socket.on("error", () => undefined);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      const length = 1 + Math.floor(random() * 200);
      const bytes = Buffer.alloc(length);
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
      socket.write(bytes);
      if (index % 3 === 0) socket.destroy(); // some of them hang up at once
    }
    await sleep(700);
    const healthy = await connect(p, "robot-after-garbage");
    const echo = await connect(p, "dashboard-after-garbage");
    const heard: string[] = [];
    echo.on("message", (_t, payload) => heard.push(payload.toString()));
    await subscribe(echo, "sim/echo");
    await publish(healthy, "sim/echo", "still here");
    await waitFor(() => heard.length === 1, "the echo");
    expect(heard).toEqual(["still here"]);
  });

  it("closes a connection that never sends CONNECT", async () => {
    const p = port();
    await start(p, { connectTimeoutMs: 300 });
    const socket = net.connect(p, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await closed;
  });
});

describe("a client that proves nothing", () => {
  it("is refused with the wrong password, the wrong user and no credentials, and accepted with the right one", async () => {
    const p = port();
    await start(p, { credentials: [{ username: "ops", password: "correct-horse", clientIdPrefix: "ops-" }] });
    await expect(connect(p, "ops-1", { username: "ops", password: "wrong" })).rejects.toBeTruthy();
    await expect(connect(p, "ops-2", { username: "nobody", password: "correct-horse" })).rejects.toBeTruthy();
    await expect(connect(p, "ops-3")).rejects.toBeTruthy();
    // a valid user may not borrow another identity space
    await expect(connect(p, "admin-1", { username: "ops", password: "correct-horse" })).rejects.toBeTruthy();
    const ok = await connect(p, "ops-4", { username: "ops", password: "correct-horse" });
    expect(ok.connected).toBe(true);
  });
});

describe("commands nobody signed", () => {
  const COMMAND = "hydra/bridges/arm/cmd/job";
  const signed = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ job_id: "J1", issued_at_ms: Date.now(), expires_in_ms: 10_000, signature: "a".repeat(64), ...extra });

  it("stops the unsigned, the expired, the far-future and the retained, and lets a current one through", async () => {
    const p = port();
    await start(p, { commandEnvelope: {} });
    const bridge = await connect(p, "bridge-arm");
    const heard: string[] = [];
    bridge.on("message", (_topic, payload) => heard.push(JSON.parse(payload.toString()).job_id));
    await subscribe(bridge, COMMAND);
    const attempts: [string, string, boolean][] = [
      ["unsigned", JSON.stringify({ job_id: "unsigned" }), false],
      ["expired", signed({ job_id: "expired", issued_at_ms: Date.now() - 60_000, expires_in_ms: 1_000 }), false],
      ["future", signed({ job_id: "future", issued_at_ms: Date.now() + 3_600_000 }), false],
      ["too long", signed({ job_id: "too-long", expires_in_ms: 99_999_999 }), false],
      ["retained", signed({ job_id: "retained" }), true],
      ["bad signature", signed({ job_id: "bad-signature", signature: "zz" }), false],
      ["not json", "this is not json", false],
    ];
    for (const [label, payload, retain] of attempts) {
      const sender = await connect(p, `dashboard-${label.replace(/ /g, "-")}`);
      const closed = new Promise<void>((resolve) => sender.once("close", () => resolve()));
      sender.publish(COMMAND, payload, { qos: 0, retain });
      await closed;
    }
    const good = await connect(p, "dashboard-good");
    await publish(good, COMMAND, signed({ job_id: "current" }));
    await waitFor(() => heard.length >= 1, "the current command");
    await sleep(200);
    expect(heard).toEqual(["current"]);
  });
});
