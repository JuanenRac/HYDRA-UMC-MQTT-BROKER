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
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Duplex } from "node:stream";
import { Aedes, type Client, type AedesPublishPacket } from "aedes";
import { WebSocketServer, type WebSocket } from "ws";
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

// 8083 is the de facto convention for plain (non-TLS) MQTT-over-WebSocket
// among real brokers (e.g. EMQX's own default) - picked so a browser-based
// client pointed at this broker with zero configuration lands on the same
// port a real operator would already expect.
const DEFAULT_WS_PORT = 8083;

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
  /** Opt-in MQTT-over-WebSocket listener, alongside the existing plain-TCP
   * one - found in an ecosystem-wide software-improvements audit: this
   * README's own "Websockets Support" feature was listed as "planned -
   * not implemented" with no WS dependency in package.json at all. Wraps
   * the SAME broker instance in a real HTTP+WS listener without touching
   * the existing protocol logic - see `wsToDuplex()`'s own comment for a
   * real, reproducible Aedes/Node hang this had to work around first.
   * Omitted (the default) starts no WS listener at all, unchanged from
   * before this option existed - `true` uses `DEFAULT_WS_PORT`, a number
   * picks the port explicitly. */
  wsPort?: number | true;
}

// Adapts one `ws` connection into the real Duplex stream `broker.handle()`
// already accepts from a plain-TCP `net.Socket`. Deliberately NOT `ws`'s
// own `createWebSocketStream()` helper: a real, reproducible bug was
// found against it here - a caller (e.g. mqtt.js's own Node-side
// MQTT-over-WS client, unlike its browser build) that writes one MQTT
// packet as many small successive WS messages made Aedes's own internal
// read-batching (`nextBatch` in aedes/lib/client.js) stop re-triggering
// reads after the first tiny chunk, hanging the CONNECT handshake
// forever with no error on either side - reproduced with `ws`'s own
// helper AND with an equivalent hand-rolled Duplex, so it isn't specific
// to one implementation. Coalescing every WS message that arrives within
// the same event-loop turn into ONE `push()` (via `setImmediate`, so a
// real multi-frame packet is joined back into a single chunk before
// Aedes ever sees it) sidesteps the hang entirely - proven against a
// real client over a real socket in tests/ws-broker.test.ts, not just in
// isolation.
function wsToDuplex(socket: WebSocket): Duplex {
  const duplex = new Duplex({
    read() {
      // No pull-based fetch needed - `message` below pushes eagerly.
    },
    write(chunk, _encoding, callback) {
      socket.send(chunk, callback);
    },
  });

  let pending: Buffer[] = [];
  let flushScheduled = false;
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    pending.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(() => {
        flushScheduled = false;
        const batch = pending;
        pending = [];
        duplex.push(Buffer.concat(batch));
      });
    }
  });
  socket.on("close", () => duplex.push(null));
  socket.on("error", (err) => duplex.destroy(err));

  return duplex;
}

export async function buildBroker(
  port: number = DEFAULT_PORT,
  options: BuildBrokerOptions = {},
): Promise<{ broker: Aedes; server: Server; wsServer?: HttpServer }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer from 0 to 65535");
  }
  if (
    options.maxPayloadBytes !== undefined &&
    (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes <= 0)
  ) {
    throw new RangeError("maxPayloadBytes must be a positive safe integer");
  }
  const wsPort = options.wsPort === true ? DEFAULT_WS_PORT : options.wsPort;
  if (wsPort !== undefined && (!Number.isInteger(wsPort) || wsPort < 0 || wsPort > 65535)) {
    throw new RangeError("wsPort must be an integer from 0 to 65535");
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
    broker.authenticate = (client, username, password, callback) => {
      // MQTT-01: client.id is already populated from the real CONNECT
      // packet at this point (Aedes parses it before calling authenticate)
      // - binding it here is what stops a validly-authenticated, low-
      // privilege user from simply declaring a different, privileged
      // client ID to pass src/acl.ts's own prefix-based rules.
      if (credentialsAuthenticate(credentials, username, password, client?.id)) {
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

  let wsServer: HttpServer | undefined;
  if (wsPort !== undefined) {
    // Wraps the SAME broker instance in a real HTTP+WS listener -
    // authentication/ACL/payload-limit hooks set above on `broker` apply
    // to a WS-connected client exactly as they do to a TCP one, since
    // Aedes itself (not the transport) is what evaluates them.
    // `createWebSocketStream()` adapts a `ws` connection into a real
    // Duplex stream, the same shape `broker.handle()` already accepts
    // from the plain-TCP `net.Socket` above.
    wsServer = createHttpServer();
    const wsSocketServer = new WebSocketServer({ server: wsServer });
    wsSocketServer.on("connection", (socket) => {
      const stream = wsToDuplex(socket);
      // A WS transport error (client vanished mid-frame, a malformed
      // frame) would otherwise crash the process as an unhandled 'error'
      // on the wrapped Duplex - the broker.on("client"/"clientDisconnect")
      // logging above already covers a WS client exactly like a TCP one,
      // since those are real Aedes-level events, not transport-level.
      stream.on("error", () => undefined);
      broker.handle(stream);
    });
    wsServer.listen(wsPort, "0.0.0.0");
  }

  return { broker, server, wsServer };
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

  if (process.env.MQTT_WS_PORT) {
    const wsPort = Number(process.env.MQTT_WS_PORT);
    if (!Number.isInteger(wsPort) || wsPort < 0 || wsPort > 65535) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] MQTT_WS_PORT must be an integer from 0 to 65535, got: ${process.env.MQTT_WS_PORT}`);
      process.exit(1);
    }
    options.wsPort = wsPort;
  }

  return options;
}

async function main() {
  const options = loadBrokerOptionsFromEnv();
  const { broker, server, wsServer } = await buildBroker(DEFAULT_PORT, options);

  server.on("error", (err) => {
    console.error("[HYDRA-UMC-MQTT-BROKER] fatal transport error:", err);
    process.exit(1);
  });

  server.on("listening", () => {
    console.log("=================================================");
    console.log(` HYDRA-UMC-MQTT-BROKER v${readPackageVersion()}`);
    console.log(" ROLE: Lightweight telemetry bridge for IoT / external integrations");
    console.log(` STATUS: Running on port ${DEFAULT_PORT} (MQTT/TCP)`);
    if (wsServer) {
      const wsPort = options.wsPort === true ? DEFAULT_WS_PORT : options.wsPort;
      console.log(` STATUS: Running on port ${wsPort} (MQTT/WebSocket)`);
    }
    console.log("=================================================");
  });

  if (wsServer) {
    wsServer.on("error", (err) => {
      console.error("[HYDRA-UMC-MQTT-BROKER] fatal WebSocket transport error:", err);
      process.exit(1);
    });
  }

  // Aedes keeps its own client/subscription state in memory; on shutdown we
  // close both listeners first (stop accepting new clients on either
  // transport) then let Aedes tear down existing ones, mirroring the
  // graceful-shutdown shape used by HYDRA-UMC-SERVER's own src/server.ts.
  function shutdown() {
    console.log("[HYDRA-UMC-MQTT-BROKER] shutting down...");
    server.close(() => {
      if (wsServer) {
        wsServer.close(() => broker.close(() => process.exit(0)));
      } else {
        broker.close(() => process.exit(0));
      }
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
