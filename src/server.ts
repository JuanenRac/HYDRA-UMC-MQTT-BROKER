// =============================================================================
// HYDRA-UMC MQTT BROKER - MQTT 3.1.1 Broker over plain TCP: src/server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Lightweight, asynchronous pub/sub bridge between the HYDRA-UMC ecosystem
// and external IoT devices, dashboards and home-automation systems (see
// this project's own README.md for the full rationale). Aedes does the
// actual MQTT protocol work (CONNECT/PUBLISH/SUBSCRIBE framing, QoS,
// retained messages, will messages); this file is intentionally thin -
// just the TCP transport Aedes needs plus process-level logging. Topic
// bridging to/from HYDRA-UMC-SERVER's own WebSocket state (hydra/swarm/...
// as sketched in the README) lands once that wiring is defined - this
// entry point proves the broker itself starts and accepts real clients,
// verified by tests/server.test.ts using a real MQTT client library
// (not a mock) over a real TCP socket.
//
// buildBroker() is exported so tests can start a real broker on an
// ephemeral/test port and connect real MQTT clients against it.
// =============================================================================

import { createServer, type Server } from "node:net";
import { Aedes, type Client, type AedesPublishPacket } from "aedes";
import { readPackageVersion } from "./version.js";
import { type AclRule, isPublishAllowed, isSubscribeAllowed, parseAclConfig } from "./acl.js";
import {
  type BrokerCredential,
  credentialsAuthenticate,
  parseCredentialsConfig,
} from "./auth.js";

// 1883 is the IANA-registered plain-MQTT port (8883 is the TLS variant) -
// kept as the default here so any off-the-shelf MQTT client (mosquitto_sub,
// Home Assistant, MQTT Explorer, ...) can point at this broker with zero
// configuration during local development.
const DEFAULT_PORT = Number(process.env.PORT) || 1883;

export interface BuildBrokerOptions {
  /** Real, verifiable per-client-ID-prefix topic ACL (see acl.ts). Omitted
   * (the default) means every existing behavior is unchanged - fully open,
   * exactly as before this option existed. */
  acl?: AclRule[];
  /** Real payload size cap in bytes, enforced on PUBLISH. Omitted (the
   * default) means unlimited, exactly as before this option existed. */
  maxPayloadBytes?: number;
  /** Opt-in MQTT CONNECT credentials. When supplied, a client must provide
   * one matching username/password pair before any ACL is evaluated. */
  credentials?: BrokerCredential[];
}

export async function buildBroker(
  port: number = DEFAULT_PORT,
  options: BuildBrokerOptions = {},
): Promise<{ broker: Aedes; server: Server }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer from 0 to 65535");
  }
  if (
    options.maxPayloadBytes !== undefined &&
    (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes <= 0)
  ) {
    throw new RangeError("maxPayloadBytes must be a positive safe integer");
  }
  const broker = new Aedes({ id: "hydra-umc-mqtt-broker" });
  // Aedes 1.x moved persistence/mqemitter setup into an explicit async
  // listen() step (a real, undocumented-in-the-original-scaffold change
  // from the 0.x factory-function API) - skipping it left the broker's
  // `this.persistence` unset, so every real CONNECT silently hung until
  // the client's own connack timeout fired. Found via a real client
  // connecting and timing out in this project's own tests, not by
  // inspection.
  await broker.listen();

  if (options.credentials) {
    const credentials = options.credentials;
    broker.authenticate = (_client, username, password, callback) => {
      if (credentialsAuthenticate(credentials, username, password)) {
        callback(null, true);
        return;
      }
      // MQTT 3.1.1 CONNACK code 4: bad username or password. Aedes requires
      // this property to reject CONNECT without accepting a usable session.
      const error = Object.assign(new Error("MQTT authentication failed"), { returnCode: 4 as const });
      callback(error, false);
    };
  }

  // Real, opt-in enforcement - both hooks are left at Aedes's own default
  // (allow everything) unless the caller explicitly provides `acl` and/or
  // `maxPayloadBytes`, so every pre-existing test/behavior against
  // buildBroker(port) with no options is untouched.
  if (options.acl || options.maxPayloadBytes !== undefined) {
    broker.authorizePublish = (client, packet, callback) => {
      if (options.maxPayloadBytes !== undefined) {
        const payloadLength = Buffer.isBuffer(packet.payload)
          ? packet.payload.length
          : Buffer.byteLength(String(packet.payload ?? ""));
        if (payloadLength > options.maxPayloadBytes) {
          callback(new Error(`payload too large: ${payloadLength} bytes exceeds limit of ${options.maxPayloadBytes}`));
          return;
        }
      }
      if (options.acl) {
        const clientId = client?.id ?? "";
        if (!isPublishAllowed(options.acl, clientId, packet.topic)) {
          callback(new Error(`ACL: publish to '${packet.topic}' denied for client '${clientId || "(unknown)"}'`));
          return;
        }
      }
      callback(null);
    };
  }

  if (options.acl) {
    const rules = options.acl;
    broker.authorizeSubscribe = (client, subscription, callback) => {
      if (isSubscribeAllowed(rules, client.id, subscription.topic ?? "")) {
        callback(null, subscription);
        return;
      }
      // Silently deny (grant nothing for this filter) rather than erroring
      // the whole SUBSCRIBE - matches how a real multi-topic SUBSCRIBE can
      // partially succeed, one topic filter at a time.
      callback(null, null);
    };
  }

  const server = createServer(broker.handle);

  // Aedes emits these on its own event bus (not Node's `EventEmitter` types
  // from `net`), useful here purely as startup-visible proof the broker is
  // live and reacting to real client traffic, not just that the TCP socket
  // is open.
  broker.on("client", (client: Client) => {
    console.log(`[HYDRA-UMC-MQTT-BROKER] client connected: ${client?.id ?? "(unknown)"}`);
  });

  broker.on("clientDisconnect", (client: Client) => {
    console.log(`[HYDRA-UMC-MQTT-BROKER] client disconnected: ${client?.id ?? "(unknown)"}`);
  });

  broker.on("publish", (packet: AedesPublishPacket, client: Client | null) => {
    // client is null for messages the broker itself publishes (e.g. internal
    // $SYS topics) - only log real client traffic to keep this readable.
    if (client) {
      console.log(`[HYDRA-UMC-MQTT-BROKER] ${client.id} -> ${packet.topic}`);
    }
  });

  server.listen(port, "0.0.0.0");

  return { broker, server };
}

// Real, opt-in production config for the authentication/ACL/payload-limit options above -
// unset (the default) means fully open/unlimited, exactly as before these
// env vars existed. A malformed MQTT_ACL_JSON fails startup loudly rather
// than silently running unprotected.
function loadBrokerOptionsFromEnv(): BuildBrokerOptions {
  const options: BuildBrokerOptions = {};

  if (process.env.MQTT_ACL_JSON) {
    try {
      options.acl = parseAclConfig(process.env.MQTT_ACL_JSON);
    } catch (err) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] ${(err as Error).message}`);
      process.exit(1);
    }
  }

  if (process.env.MQTT_AUTH_JSON) {
    try {
      options.credentials = parseCredentialsConfig(process.env.MQTT_AUTH_JSON);
    } catch (err) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] ${(err as Error).message}`);
      process.exit(1);
    }
  }

  if (process.env.MAX_PAYLOAD_BYTES) {
    const maxPayloadBytes = Number(process.env.MAX_PAYLOAD_BYTES);
    if (!Number.isFinite(maxPayloadBytes) || maxPayloadBytes <= 0) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] MAX_PAYLOAD_BYTES must be a positive number, got: ${process.env.MAX_PAYLOAD_BYTES}`);
      process.exit(1);
    }
    options.maxPayloadBytes = maxPayloadBytes;
  }

  return options;
}

async function main() {
  const { broker, server } = await buildBroker(DEFAULT_PORT, loadBrokerOptionsFromEnv());

  server.on("error", (err) => {
    console.error("[HYDRA-UMC-MQTT-BROKER] fatal transport error:", err);
    process.exit(1);
  });

  server.on("listening", () => {
    console.log("=================================================");
    console.log(` HYDRA-UMC-MQTT-BROKER v${readPackageVersion()}`);
    console.log(" ROLE: Lightweight telemetry bridge for IoT / external integrations");
    console.log(` STATUS: Running on port ${DEFAULT_PORT} (MQTT/TCP)`);
    console.log("=================================================");
  });

  // Aedes keeps its own client/subscription state in memory; on shutdown we
  // close the TCP listener first (stop accepting new clients) then let
  // Aedes tear down existing ones, mirroring the graceful-shutdown shape
  // used by HYDRA-UMC-SERVER's own src/server.ts.
  function shutdown() {
    console.log("[HYDRA-UMC-MQTT-BROKER] shutting down...");
    server.close(() => {
      broker.close(() => process.exit(0));
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only auto-start when run directly, not when imported by
// tests/server.test.ts.
const entryFile = process.argv[1] ? process.argv[1].split(/[/\\]/).pop() : "";
if (entryFile === "server.ts" || entryFile === "server.cjs" || entryFile === "server.js") {
  main().catch((err) => {
    console.error("[HYDRA-UMC-MQTT-BROKER] fatal startup error:", err);
    process.exit(1);
  });
}
