// =============================================================================
// HYDRA-UMC MQTT BROKER - src/discovery.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Zero-configuration discovery, both opt-in and off by default:
//
//  * mDNS: the broker announces itself on the local network as `_mqtt._tcp` (and `_secure-mqtt._tcp` when TLS is on, `_mqtt-ws._tcp` when the WebSocket listener is on),
//    so a client, Home Assistant or a phone finds it without being told an address. The announcement carries only the product, the version and whether TLS and
//    sign-in are on; never a user, a topic or a key. `MQTT_MDNS=1` turns it on.
//  * Home Assistant: when a bridge of the machines publishes its health on `hydra/bridges/<name>/health` the broker publishes, once and retained, the config that
//    makes Home Assistant list that bridge (a connectivity sensor and a state sensor). `MQTT_HOME_ASSISTANT=1` turns it on; `MQTT_HOME_ASSISTANT_PREFIX` changes
//    the discovery prefix (`homeassistant` by default).
//
// Everything here is pure or takes the real thing as a parameter, so the checks run with a simulated network and a simulated broker.
// =============================================================================

export interface DiscoveryOptions {
  /** Announce the broker with mDNS. */
  mdns: boolean;
  /** The name shown for the announcement (`hydra-umc-mqtt` by default). */
  mdnsName: string;
  /** Publish the Home Assistant configs of the bridges. */
  homeAssistant: boolean;
  /** The discovery prefix Home Assistant listens on. */
  discoveryPrefix: string;
}

export class DiscoveryConfigError extends Error {}

const SWITCH = /^(|0|1)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/;
const PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const BRIDGE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Reads the options from the environment. A switch is exactly `1` (on) or `0`/empty (off): any other word is an error, so a misspelling cannot leave it silently off. */
export function parseDiscoveryEnv(env: Record<string, string | undefined>): DiscoveryOptions {
  const read = (name: string): boolean => {
    const raw = (env[name] ?? "").trim();
    if (!SWITCH.test(raw)) throw new DiscoveryConfigError(`${name} must be 1 or 0, got: ${env[name]}`);
    return raw === "1";
  };
  const name = (env.MQTT_MDNS_NAME ?? "").trim() || "hydra-umc-mqtt";
  if (!NAME.test(name)) throw new DiscoveryConfigError(`MQTT_MDNS_NAME must be letters, digits, spaces, dots, dashes or underscores (up to 63), got: ${env.MQTT_MDNS_NAME}`);
  const prefix = (env.MQTT_HOME_ASSISTANT_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, "") || "homeassistant";
  if (!PREFIX.test(prefix) || prefix.split("/").some((level) => /^\.+$/.test(level)) || prefix.length > 120) {
    throw new DiscoveryConfigError(`MQTT_HOME_ASSISTANT_PREFIX must be topic levels of letters, digits, . _ - separated by /, got: ${env.MQTT_HOME_ASSISTANT_PREFIX}`);
  }
  return { mdns: read("MQTT_MDNS"), mdnsName: name, homeAssistant: read("MQTT_HOME_ASSISTANT"), discoveryPrefix: prefix };
}

// ---- mDNS --------------------------------------------------------------------------------------------------------

export interface MdnsService {
  name: string;
  type: string;
  port: number;
  txt: Record<string, string>;
}

export interface MdnsPublisher {
  publish(service: MdnsService): void;
  unpublishAll(): Promise<void> | void;
}

export interface MdnsListeners {
  /** The port of the plain MQTT listener. */
  port: number;
  /** The port of the TLS listener, when there is one. */
  tlsPort?: number;
  /** The port of the MQTT-over-WebSocket listener, when there is one. */
  wsPort?: number;
  version: string;
  /** Whether a client must sign in. */
  auth: boolean;
}

/** What to announce: one service per listener that exists. Port 0 (an ephemeral port in a check) is never announced. */
export function mdnsServices(name: string, listeners: MdnsListeners): MdnsService[] {
  const txt = (tls: boolean): Record<string, string> => ({ product: "hydra-umc-mqtt-broker", version: listeners.version, tls: tls ? "1" : "0", auth: listeners.auth ? "1" : "0" });
  const out: MdnsService[] = [];
  if (listeners.port > 0) out.push({ name, type: "mqtt", port: listeners.port, txt: txt(false) });
  if (listeners.tlsPort !== undefined && listeners.tlsPort > 0) out.push({ name, type: "secure-mqtt", port: listeners.tlsPort, txt: txt(true) });
  if (listeners.wsPort !== undefined && listeners.wsPort > 0) out.push({ name, type: "mqtt-ws", port: listeners.wsPort, txt: txt(false) });
  return out;
}

/** Announces the services and returns the function that withdraws them. Never throws: a network without multicast leaves the broker running, and says so. */
export function startMdns(publisher: MdnsPublisher, services: MdnsService[], log: (message: string) => void): () => Promise<void> {
  const announced: string[] = [];
  for (const service of services) {
    try {
      publisher.publish(service);
      announced.push(`_${service.type}._tcp:${service.port}`);
    } catch (error) {
      log(`[HYDRA-UMC-MQTT-BROKER] mDNS could not announce _${service.type}._tcp: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (announced.length > 0) log(`[HYDRA-UMC-MQTT-BROKER] mDNS announcing ${announced.join(", ")}`);
  return async () => {
    try {
      await publisher.unpublishAll();
    } catch {
      /* best effort on the way out */
    }
  };
}

/** The real publisher (the `bonjour-service` package, loaded only when mDNS is on so that a broker without it still runs). */
export async function loadBonjourPublisher(): Promise<MdnsPublisher & { destroy(): void }> {
  const module: any = await import("bonjour-service");
  const Bonjour = module.default ?? module.Bonjour ?? module;
  const instance = new Bonjour();
  return {
    publish: (service) => {
      instance.publish({ name: service.name, type: service.type, protocol: "tcp", port: service.port, txt: service.txt });
    },
    unpublishAll: () => new Promise<void>((resolve) => instance.unpublishAll(() => resolve())),
    destroy: () => instance.destroy(),
  };
}

// ---- Home Assistant ----------------------------------------------------------------------------------------------

/** `hydra/bridges/<name>/health` -> the name of the bridge, or null. */
export function bridgeNameOfHealthTopic(topic: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "hydra" || parts[1] !== "bridges" || parts[3] !== "health") return null;
  return BRIDGE.test(parts[2]) ? parts[2] : null;
}

export interface DiscoveryMessage {
  topic: string;
  payload: string;
}

/**
 * The configs that make Home Assistant list a bridge: a connectivity sensor (on while the state in the `HealthReport` of the bridge is READY) and a sensor with the
 * state itself. They read the retained health topic, so a bridge that goes quiet keeps its last state until the broker expires the message, exactly as any other
 * subscriber sees it.
 */
export function bridgeDiscoveryMessages(bridge: string, discoveryPrefix: string): DiscoveryMessage[] {
  const node = `hydra_umc_bridge_${bridge.replace(/-/g, "_")}`;
  const stateTopic = `hydra/bridges/${bridge}/health`;
  const device = { identifiers: [node], name: `HYDRA-UMC bridge ${bridge}`, manufacturer: "HYDRA-UMC", model: "machine bridge" };
  return [
    {
      topic: `${discoveryPrefix}/binary_sensor/${node}/online/config`,
      payload: JSON.stringify({
        name: "Ready", unique_id: `${node}_ready`, device, state_topic: stateTopic, device_class: "connectivity",
        value_template: "{{ 'ON' if value_json.state == 'READY' else 'OFF' }}",
      }),
    },
    {
      topic: `${discoveryPrefix}/sensor/${node}/state/config`,
      payload: JSON.stringify({ name: "State", unique_id: `${node}_state`, device, state_topic: stateTopic, value_template: "{{ value_json.state }}" }),
    },
  ];
}

/** Publishes the configs of a bridge the first time its health topic is seen. */
export class BridgeDiscovery {
  private readonly announced = new Set<string>();

  constructor(
    private readonly discoveryPrefix: string,
    private readonly publish: (message: DiscoveryMessage) => void,
    /** At most this many bridges are announced (a client that invents names cannot fill the broker). */
    private readonly maxBridges = 64,
  ) {}

  /** A PUBLISH went through the broker. Returns true when it announced a bridge. */
  onPublish(topic: string, payload: Buffer | string): boolean {
    const bridge = bridgeNameOfHealthTopic(topic);
    if (bridge === null || this.announced.has(bridge) || this.announced.size >= this.maxBridges) return false;
    if ((Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload)) === 0) return false; // an empty retained message clears the topic
    this.announced.add(bridge);
    for (const message of bridgeDiscoveryMessages(bridge, this.discoveryPrefix)) this.publish(message);
    return true;
  }

  get count(): number {
    return this.announced.size;
  }
}
