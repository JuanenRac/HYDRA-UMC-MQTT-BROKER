// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/discovery.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// mDNS announcement and Home Assistant discovery of the bridges: the options, what is announced, and the behaviour with a simulated network. The same
// discovery against a real broker and a real client is in discovery-broker.test.ts.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  BridgeDiscovery,
  DiscoveryConfigError,
  bridgeDiscoveryMessages,
  bridgeNameOfHealthTopic,
  mdnsServices,
  parseDiscoveryEnv,
  startMdns,
  type DiscoveryMessage,
  type MdnsPublisher,
  type MdnsService,
} from "../src/discovery.js";

describe("the options are off by default and a misspelt switch is an error", () => {
  it("starts with nothing on", () => {
    expect(parseDiscoveryEnv({})).toEqual({ mdns: false, mdnsName: "hydra-umc-mqtt", homeAssistant: false, discoveryPrefix: "homeassistant" });
    expect(parseDiscoveryEnv({ MQTT_MDNS: "0", MQTT_HOME_ASSISTANT: "" }).mdns).toBe(false);
  });

  it("turns on with the exact word 1", () => {
    const options = parseDiscoveryEnv({ MQTT_MDNS: "1", MQTT_HOME_ASSISTANT: "1", MQTT_MDNS_NAME: "Cell 2", MQTT_HOME_ASSISTANT_PREFIX: "/ha/custom/" });
    expect(options).toEqual({ mdns: true, mdnsName: "Cell 2", homeAssistant: true, discoveryPrefix: "ha/custom" });
  });

  it("refuses any other word, a bad name and a prefix with wildcards", () => {
    for (const word of ["yes", "true", "on", "2"]) {
      expect(() => parseDiscoveryEnv({ MQTT_MDNS: word })).toThrow(DiscoveryConfigError);
      expect(() => parseDiscoveryEnv({ MQTT_HOME_ASSISTANT: word })).toThrow(DiscoveryConfigError);
    }
    expect(() => parseDiscoveryEnv({ MQTT_MDNS_NAME: "bad/name" })).toThrow(DiscoveryConfigError);
    expect(() => parseDiscoveryEnv({ MQTT_MDNS_NAME: "x".repeat(64) })).toThrow(DiscoveryConfigError);
    for (const prefix of ["a/#", "a/+/b", "a b", "../x", "a/./b"]) {
      expect(() => parseDiscoveryEnv({ MQTT_HOME_ASSISTANT_PREFIX: prefix })).toThrow(DiscoveryConfigError);
    }
  });
});

describe("what mDNS announces", () => {
  it("announces one service per listener that exists, with nothing secret in the text", () => {
    const services = mdnsServices("cell", { port: 1883, tlsPort: 8883, wsPort: 8083, version: "0.1.9", auth: true });
    expect(services.map((s) => [s.type, s.port])).toEqual([["mqtt", 1883], ["secure-mqtt", 8883], ["mqtt-ws", 8083]]);
    expect(services[0].txt).toEqual({ product: "hydra-umc-mqtt-broker", version: "0.1.9", tls: "0", auth: "1" });
    expect(services[1].txt.tls).toBe("1");
    for (const service of services) expect(Object.keys(service.txt).sort()).toEqual(["auth", "product", "tls", "version"]);
  });

  it("leaves out a listener that is absent or on the ephemeral port", () => {
    expect(mdnsServices("cell", { port: 1883, version: "1", auth: false }).map((s) => s.type)).toEqual(["mqtt"]);
    expect(mdnsServices("cell", { port: 0, wsPort: 0, version: "1", auth: false })).toEqual([]);
  });

  it("publishes through the publisher it is given and withdraws everything on stop", async () => {
    const published: MdnsService[] = [];
    let withdrawn = 0;
    const publisher: MdnsPublisher = { publish: (s) => { published.push(s); }, unpublishAll: () => { withdrawn++; } };
    const logs: string[] = [];
    const stop = startMdns(publisher, mdnsServices("cell", { port: 1883, wsPort: 8083, version: "1", auth: false }), (m) => logs.push(m));
    expect(published.map((s) => s.type)).toEqual(["mqtt", "mqtt-ws"]);
    expect(logs[0]).toContain("_mqtt._tcp:1883");
    await stop();
    expect(withdrawn).toBe(1);
  });

  it("goes on when the network refuses an announcement, and says so", async () => {
    const logs: string[] = [];
    const publisher: MdnsPublisher = {
      publish: (s) => { if (s.type === "mqtt") throw new Error("no multicast route"); },
      unpublishAll: () => { throw new Error("already closed"); },
    };
    const stop = startMdns(publisher, mdnsServices("cell", { port: 1883, wsPort: 8083, version: "1", auth: false }), (m) => logs.push(m));
    expect(logs.some((l) => l.includes("could not announce _mqtt._tcp: no multicast route"))).toBe(true);
    expect(logs.some((l) => l.includes("_mqtt-ws._tcp:8083"))).toBe(true);
    await expect(stop()).resolves.toBeUndefined();
  });
});

describe("Home Assistant configs of the bridges", () => {
  it("reads the bridge name from its health topic only", () => {
    expect(bridgeNameOfHealthTopic("hydra/bridges/cnc-1/health")).toBe("cnc-1");
    for (const topic of ["hydra/bridges/cnc-1/state", "hydra/bridges//health", "hydra/bridges/Bad Name/health", "hydra/bridges/a/b/health", "x/bridges/a/health", "hydra/swarm/status"]) {
      expect(bridgeNameOfHealthTopic(topic)).toBeNull();
    }
  });

  it("describes a connectivity sensor and a state sensor that read the retained health", () => {
    const [ready, state] = bridgeDiscoveryMessages("cnc-1", "homeassistant");
    expect(ready.topic).toBe("homeassistant/binary_sensor/hydra_umc_bridge_cnc_1/online/config");
    expect(state.topic).toBe("homeassistant/sensor/hydra_umc_bridge_cnc_1/state/config");
    const config = JSON.parse(ready.payload);
    expect(config.state_topic).toBe("hydra/bridges/cnc-1/health");
    expect(config.device.identifiers).toEqual(["hydra_umc_bridge_cnc_1"]);
    expect(config.value_template).toContain("READY");
    expect(JSON.parse(state.payload).unique_id).toBe("hydra_umc_bridge_cnc_1_state");
  });

  it("announces a bridge once, never for an empty (clearing) message, and no more than the cap", () => {
    const sent: DiscoveryMessage[] = [];
    const discovery = new BridgeDiscovery("ha", (m) => sent.push(m), 2);
    expect(discovery.onPublish("hydra/bridges/a/health", Buffer.alloc(0))).toBe(false);
    expect(discovery.onPublish("hydra/bridges/a/health", '{"state":"READY"}')).toBe(true);
    expect(discovery.onPublish("hydra/bridges/a/health", '{"state":"READY"}')).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.topic.startsWith("ha/"))).toBe(true);
    expect(discovery.onPublish("hydra/bridges/b/health", Buffer.from("{}"))).toBe(true);
    expect(discovery.onPublish("hydra/bridges/c/health", Buffer.from("{}"))).toBe(false);
    expect(discovery.count).toBe(2);
  });
});
