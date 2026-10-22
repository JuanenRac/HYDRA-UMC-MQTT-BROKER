// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/identity-and-limits-broker.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Hashed passwords, the client certificate as the ACL identity, and the Aedes limits
// (CONNECT timeout, keep-alive, queue) - all of them against a real broker and real clients.
// =============================================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker, closeBroker } from "../src/server.js";
import {
  AuthConfigError,
  authenticatedPrefix,
  authenticatedPrefixAsync,
  hashPassword,
  isHashedPassword,
  parseCredentialsConfig,
  passwordMatches,
} from "../src/auth.js";
import { productionProblems } from "../src/security.js";

type Built = Awaited<ReturnType<typeof buildBroker>>;

// Distinct ports: vitest runs the test files in parallel workers.
let nextPort = 42100;
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
// a cheap cost keeps the tests fast; the default cost is what `npm run hash-password` writes
const CHEAP = { N: 1024, r: 8, p: 1 };

describe("hashed passwords", () => {
  it("round-trips, never stores the password and salts every hash", async () => {
    const hash = hashPassword("a-long-enough-password", CHEAP);
    expect(isHashedPassword(hash)).toBe(true);
    expect(hash).not.toContain("a-long-enough-password");
    expect(hashPassword("a-long-enough-password", CHEAP)).not.toBe(hash);
    expect(await passwordMatches(hash, Buffer.from("a-long-enough-password"))).toBe(true);
    expect(await passwordMatches(hash, Buffer.from("a-long-enough-passworD"))).toBe(false);
    expect(await passwordMatches(hash, Buffer.alloc(0))).toBe(false);
  });

  it("still accepts a plain password, exactly as before", async () => {
    expect(await passwordMatches("plain-password-1234", Buffer.from("plain-password-1234"))).toBe(true);
    expect(await passwordMatches("plain-password-1234", Buffer.from("plain-password-123"))).toBe(false);
  });

  it("refuses a malformed or absurd hash when the configuration is read", () => {
    const user = (password: string) => JSON.stringify([{ username: "u", password, clientIdPrefix: "p-" }]);
    expect(() => parseCredentialsConfig(user("scrypt$16384$8$1$AAAA"))).toThrow(AuthConfigError);
    expect(() => parseCredentialsConfig(user("scrypt$3$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))).toThrow(AuthConfigError);
    expect(() => parseCredentialsConfig(user("scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))).toThrow(AuthConfigError);
    expect(() => parseCredentialsConfig(user(hashPassword("a-long-enough-password", CHEAP)))).not.toThrow();
  });

  it("the synchronous check never matches a hashed credential, the asynchronous one does", async () => {
    const credentials = [{ username: "u", password: hashPassword("a-long-enough-password", CHEAP), clientIdPrefix: "p-" }];
    const password = Buffer.from("a-long-enough-password");
    expect(authenticatedPrefix(credentials, "u", password, "p-1")).toBeNull();
    expect(await authenticatedPrefixAsync(credentials, "u", password, "p-1")).toBe("p-");
    expect(await authenticatedPrefixAsync(credentials, "u", password, "other-1")).toBeNull();
    expect(await authenticatedPrefixAsync(credentials, "nobody", password, "p-1")).toBeNull();
  });

  it("a production start does not judge the length of a hash", () => {
    const env = { NODE_ENV: "production" };
    const acl = [{ clientIdPrefix: "p-", publish: ["a/#"], subscribe: ["a/#"] }];
    const hashed = [{ username: "u", password: hashPassword("a-long-enough-password", CHEAP), clientIdPrefix: "p-" }];
    expect(productionProblems({ credentials: hashed, acl }, env)).toEqual([]);
    const plainShort = [{ username: "u", password: "short", clientIdPrefix: "p-" }];
    expect(productionProblems({ credentials: plainShort, acl }, env).join(" ")).toContain("fewer than");
  });

  it("a real client logs in with a hashed credential and is refused with a wrong password", async () => {
    const p = port();
    const b = await start(p, {
      credentials: [{ username: "robot", password: hashPassword("correct-password-1234", CHEAP), clientIdPrefix: "robot-" }],
      acl: [{ clientIdPrefix: "robot-", publish: ["ok/#"], subscribe: ["ok/#"] }],
    });
    await expect(connect(`mqtt://127.0.0.1:${p}`, { clientId: "robot-1", username: "robot", password: "wrong-password-1234" })).rejects.toBeTruthy();
    await expect(connect(`mqtt://127.0.0.1:${p}`, { clientId: "other-1", username: "robot", password: "correct-password-1234" })).rejects.toBeTruthy();
    const good = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "robot-1", username: "robot", password: "correct-password-1234" });
    expect(good.connected).toBe(true);
    expect(b.metrics.snapshot().connectedClients).toBe(1);
  });
});

describe("Aedes limits", () => {
  it("rejects a value that is not a positive integer", async () => {
    await expect(buildBroker(0, { connectTimeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(buildBroker(0, { keepaliveLimitSeconds: -1 })).rejects.toThrow(RangeError);
    await expect(buildBroker(0, { queueLimit: 1.5 })).rejects.toThrow(RangeError);
  });

  it("closes a connection that never sends CONNECT after the configured time", async () => {
    const p = port();
    await start(p, { connectTimeoutMs: 300 });
    const closedAfter = await new Promise<number>((resolve) => {
      const started = Date.now();
      const socket = createConnection({ host: "127.0.0.1", port: p });
      socket.on("close", () => resolve(Date.now() - started));
      socket.on("error", () => undefined);
    });
    expect(closedAfter).toBeGreaterThanOrEqual(250);
    expect(closedAfter).toBeLessThan(5000);
  });

  it("refuses a client whose keep-alive is longer than the limit, or missing", async () => {
    const p = port();
    await start(p, { keepaliveLimitSeconds: 30 });
    await expect(connect(`mqtt://127.0.0.1:${p}`, { clientId: "slow-1", keepalive: 600 })).rejects.toBeTruthy();
    await expect(connect(`mqtt://127.0.0.1:${p}`, { clientId: "slow-2", keepalive: 0 })).rejects.toBeTruthy();
    const fine = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "fine-1", keepalive: 20 });
    expect(fine.connected).toBe(true);
  });

  it("without the limits a long or absent keep-alive is accepted, as before", async () => {
    const p = port();
    await start(p);
    const long = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "long-1", keepalive: 600 });
    expect(long.connected).toBe(true);
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

describe.skipIf(!hasOpenssl)("client certificate as the identity", () => {
  let dir = "";
  const read = (name: string) => readFileSync(path.join(dir, name));
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hydra-umc-mqtt-identity-"));
    writeFileSync(path.join(dir, "openssl.cnf"), ["[req]", "distinguished_name = dn", "[dn]", ""].join("\n"));
    const run = (args: string[]) =>
      execFileSync("openssl", args, { cwd: dir, stdio: "ignore", env: { ...process.env, OPENSSL_CONF: path.join(dir, "openssl.cnf") } });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=test-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE"]);
    for (const [name, cn] of [["server", "localhost"], ["bridge", "bridge-cnc"], ["other", "bridge-laser"]] as const) {
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`]);
      run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2"]);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const acl = [
    { clientIdPrefix: "bridge-cnc", publish: ["hydra/bridges/cnc/#"], subscribe: ["hydra/bridges/cnc/#"] },
    { clientIdPrefix: "bridge-laser", publish: ["hydra/bridges/laser/#"], subscribe: ["hydra/bridges/laser/#"] },
  ];
  const tlsOptions = () => ({ cert: read("server.pem"), key: read("server.key"), ca: read("ca.pem"), requireClientCert: true, certIdentity: true });

  it("refuses to start with the option but without a CA and mutual TLS", async () => {
    await expect(buildBroker(0, { tls: { cert: read("server.pem"), key: read("server.key"), certIdentity: true } })).rejects.toThrow(RangeError);
  });

  it("identifies the client by its certificate, with no password, and applies the ACL of that name", async () => {
    const p = port();
    const tlsPort = port();
    const b = await start(p, { tls: tlsOptions(), tlsPort, acl });
    const url = `mqtts://127.0.0.1:${tlsPort}`;
    const tlsClient = { cert: read("bridge.pem"), key: read("bridge.key"), rejectUnauthorized: false };
    const cnc = await connect(url, { ...tlsClient, clientId: "bridge-cnc-1" });

    const allowed = new Promise<string>((resolve) => cnc.once("message", (_t, payload) => resolve(payload.toString())));
    await new Promise<void>((resolve) => cnc.subscribe("hydra/bridges/cnc/#", () => resolve()));
    cnc.publish("hydra/bridges/cnc/state", "ok", { qos: 0 });
    expect(await Promise.race([allowed, sleep(2000).then(() => "timeout")])).toBe("ok");

    cnc.publish("hydra/bridges/laser/state", "no", { qos: 0 });
    await sleep(300);
    expect(b.metrics.snapshot().aclDeniedTotal).toBe(1);
  });

  it("refuses a client ID that does not start with the certificate name", async () => {
    const p = port();
    const tlsPort = port();
    await start(p, { tls: tlsOptions(), tlsPort, acl });
    await expect(
      connect(`mqtts://127.0.0.1:${tlsPort}`, { cert: read("bridge.pem"), key: read("bridge.key"), rejectUnauthorized: false, clientId: "bridge-laser-1" }),
    ).rejects.toBeTruthy();
  });

  it("identifies a secure WebSocket client by its certificate too", async () => {
    const p = port();
    const tlsPort = port();
    const wssPort = port();
    await start(p, { tls: tlsOptions(), tlsPort, wssPort, acl });
    const wsOptions = { cert: read("bridge.pem"), key: read("bridge.key"), rejectUnauthorized: false };
    const viaWss = await connect(`wss://127.0.0.1:${wssPort}`, { wsOptions, clientId: "bridge-cnc-ws" });
    expect(viaWss.connected).toBe(true);
    await expect(connect(`wss://127.0.0.1:${wssPort}`, { wsOptions, clientId: "bridge-laser-ws" })).rejects.toBeTruthy();
  });

  it("a plain connection without a certificate is refused when there are no credentials", async () => {
    const p = port();
    const tlsPort = port();
    await start(p, { tls: tlsOptions(), tlsPort, acl });
    await expect(connect(`mqtt://127.0.0.1:${p}`, { clientId: "bridge-cnc-2" })).rejects.toBeTruthy();
  });

  it("a plain connection can still use credentials alongside the certificate identity", async () => {
    const p = port();
    const tlsPort = port();
    await start(p, {
      tls: tlsOptions(),
      tlsPort,
      acl,
      credentials: [{ username: "laser", password: hashPassword("laser-password-1234", CHEAP), clientIdPrefix: "bridge-laser" }],
    });
    const viaPassword = await connect(`mqtt://127.0.0.1:${p}`, { clientId: "bridge-laser-1", username: "laser", password: "laser-password-1234" });
    expect(viaPassword.connected).toBe(true);
    const viaCertificate = await connect(`mqtts://127.0.0.1:${tlsPort}`, { cert: read("other.pem"), key: read("other.key"), rejectUnauthorized: false, clientId: "bridge-laser-2" });
    expect(viaCertificate.connected).toBe(true);
  });

  it("without the option a certificate alone does not identify anybody", async () => {
    const p = port();
    const tlsPort = port();
    await start(p, {
      tls: { cert: read("server.pem"), key: read("server.key"), ca: read("ca.pem"), requireClientCert: true },
      tlsPort,
      credentials: [{ username: "u", password: "plain-password-1234", clientIdPrefix: "bridge-cnc" }],
    });
    await expect(
      connect(`mqtts://127.0.0.1:${tlsPort}`, { cert: read("bridge.pem"), key: read("bridge.key"), rejectUnauthorized: false, clientId: "bridge-cnc-1" }),
    ).rejects.toBeTruthy();
  });

  it("the production check does not ask for credentials when the certificate is the identity", () => {
    const env = { NODE_ENV: "production" };
    expect(productionProblems({ acl, certIdentity: true }, env)).toEqual([]);
    expect(productionProblems({ acl }, env).join(" ")).toContain("MQTT_AUTH_JSON");
  });
});
