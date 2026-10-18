// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/security.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// What a production start refuses, and the identity the ACL is evaluated against: a real client over a real TCP socket authenticates with a credential whose prefix is "bridge-" and
// connects as "bridge-cnc-1"; it must get the rights of the rule that covers "bridge-", not those of the more specific, more privileged "bridge-cnc-" rule that comes first.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import type { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { buildBroker } from "../src/server.js";
import type { AclRule } from "../src/acl.js";
import { authenticatedPrefix, type BrokerCredential } from "../src/auth.js";
import { anonymousAllowed, openStartWarnings, productionProblems, ruleForPrefix } from "../src/security.js";

const STRONG = "k3Rr-9vQp-LmN2-xZ7w-Tb4e";
const CREDENTIALS: BrokerCredential[] = [
  { username: "bridge", password: STRONG, clientIdPrefix: "bridge-" },
  { username: "ops", password: "another-long-secret-for-ops-1", clientIdPrefix: "ops-" },
];
const RULES: AclRule[] = [
  { clientIdPrefix: "bridge-cnc-", publish: ["hydra/bridges/cnc/cmd/#"], subscribe: [] },
  { clientIdPrefix: "bridge-", publish: ["hydra/bridges/status/+"], subscribe: [] },
  { clientIdPrefix: "ops-", publish: [], subscribe: ["hydra/#"] },
];
const PRODUCTION = { NODE_ENV: "production" };

describe("what a production start refuses", () => {
  it("accepts a complete configuration", () => {
    expect(productionProblems({ credentials: CREDENTIALS, acl: RULES }, PRODUCTION)).toEqual([]);
  });

  it("is silent outside production, and when the open lab broker is asked for on purpose", () => {
    expect(productionProblems({}, {})).toEqual([]);
    expect(productionProblems({}, { NODE_ENV: "development" })).toEqual([]);
    expect(productionProblems({}, { ...PRODUCTION, MQTT_ALLOW_ANONYMOUS: "1" })).toEqual([]);
    expect(anonymousAllowed({ MQTT_ALLOW_ANONYMOUS: "1" })).toBe(true);
    expect(anonymousAllowed({ MQTT_ALLOW_ANONYMOUS: "yes" })).toBe(false);
  });

  it("refuses no credentials and no ACL", () => {
    const problems = productionProblems({}, PRODUCTION).join("\n");
    expect(problems).toMatch(/MQTT_AUTH_JSON/);
    expect(problems).toMatch(/MQTT_ACL_JSON/);
  });

  it("refuses short and example passwords", () => {
    const weak = productionProblems({ credentials: [{ username: "a", password: "short", clientIdPrefix: "bridge-" }], acl: RULES }, PRODUCTION).join("\n");
    expect(weak).toMatch(/fewer than 16/);
    const example = productionProblems({ credentials: [{ username: "a", password: "CHANGE_ME_please_1234567", clientIdPrefix: "bridge-" }], acl: RULES }, PRODUCTION).join("\n");
    expect(example).toMatch(/example value/);
  });

  it("refuses a credential no ACL rule covers, and a rule that matches every client", () => {
    const uncovered = productionProblems({ credentials: [{ username: "x", password: STRONG, clientIdPrefix: "bridge-cnc-" }], acl: [{ clientIdPrefix: "bridge-cnc-x", publish: [], subscribe: [] }] }, PRODUCTION).join("\n");
    expect(uncovered).toMatch(/no ACL rule covers/);
    const everyone = productionProblems({ credentials: CREDENTIALS, acl: [{ clientIdPrefix: "", publish: ["#"], subscribe: ["#"] }, ...RULES] }, PRODUCTION).join("\n");
    expect(everyone).toMatch(/empty clientIdPrefix/);
  });

  it("says what an open start leaves unprotected", () => {
    expect(openStartWarnings({})).toHaveLength(2);
    expect(openStartWarnings({ credentials: CREDENTIALS, acl: RULES })).toEqual([]);
  });

  it("picks the rule of a principal by its own prefix", () => {
    expect(ruleForPrefix(RULES, "bridge-")?.clientIdPrefix).toBe("bridge-");
    expect(ruleForPrefix(RULES, "bridge-cnc-")?.clientIdPrefix).toBe("bridge-cnc-");
    expect(ruleForPrefix(RULES, "other-")).toBeUndefined();
  });
});

describe("the verified principal", () => {
  it("is the prefix of the credential that proved it, and null when anything is wrong", () => {
    const password = Buffer.from(STRONG);
    expect(authenticatedPrefix(CREDENTIALS, "bridge", password, "bridge-cnc-1")).toBe("bridge-");
    expect(authenticatedPrefix(CREDENTIALS, "bridge", password, "ops-1")).toBeNull();
    expect(authenticatedPrefix(CREDENTIALS, "bridge", Buffer.from("wrong"), "bridge-cnc-1")).toBeNull();
    expect(authenticatedPrefix(CREDENTIALS, "nobody", password, "bridge-cnc-1")).toBeNull();
    expect(authenticatedPrefix(CREDENTIALS, undefined, undefined, "bridge-cnc-1")).toBeNull();
  });
});

const TEST_PORT = 41892;
let broker: Aedes;
let server: Server;
const clients: MqttClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => new Promise<void>(resolve => c.end(true, {}, () => resolve()))));
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (broker) await new Promise<void>(resolve => broker.close(() => resolve()));
});

function connect(clientId: string, username: string, password: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://127.0.0.1:${TEST_PORT}`, { clientId, username, password, connectTimeout: 5000, reconnectPeriod: 0 });
    clients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
    client.on("error", () => { /* a late socket error after the test has moved on must not become an unhandled error */ });
  });
}

function closes(client: MqttClient, timeoutMs = 1200): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    client.once("close", () => { clearTimeout(timer); resolve(true); });
  });
}

describe("the ACL is evaluated against the verified principal, not the client ID that was chosen", () => {
  it("a 'bridge-' credential connecting as 'bridge-cnc-1' does not get the 'bridge-cnc-' rule", async () => {
    const built = await buildBroker(TEST_PORT, { credentials: CREDENTIALS, acl: RULES, host: "127.0.0.1" });
    broker = built.broker;
    server = built.server;

    // the topic only the privileged rule grants: denied (the connection is dropped, as Aedes does for a denied publish)
    const client = await connect("bridge-cnc-1", "bridge", STRONG);
    const dropped = closes(client);
    client.publish("hydra/bridges/cnc/cmd/cycle_start_resume", "go", { qos: 0 });
    expect(await dropped).toBe(true);

    // the topic the 'bridge-' rule grants: allowed (the connection stays open)
    const again = await connect("bridge-cnc-2", "bridge", STRONG);
    const stays = closes(again, 800);
    again.publish("hydra/bridges/status/cnc", "online", { qos: 0 });
    expect(await stays).toBe(false);
  });
});
