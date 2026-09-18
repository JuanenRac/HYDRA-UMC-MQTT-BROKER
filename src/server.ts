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
import { MetricsRegistry } from "./metrics.js";

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

// A dedicated metrics port (distinct from both MQTT listeners above) so a
// Prometheus scrape target never shares a port with real MQTT traffic -
// 9883 keeps the same "883" family as 1883/8083 for this broker while
// staying clear of node_exporter's own 9100 default and other common
// exporters.
const DEFAULT_METRICS_PORT = 9883;

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
  /** I41: opt-in real expiry for retained messages. Aedes retains a
   * PUBLISH with `retain: true` indefinitely by default, with no concept
   * of "this state is too old to still hand to a new subscriber" - a
   * bridge/tool that died mid-session with a stale command retained
   * would keep replaying that exact command to every future subscriber
   * forever. H051 already defends the CLIENT side of this (a bridge must
   * never blindly trust a retained replay as a live command); this is
   * the complementary broker-side policy - a retained message older than
   * `retainedTtlMs` is actively cleared (a real empty-payload retained
   * PUBLISH, the standard MQTT way to clear one) instead of living on
   * forever. Omitted (the default) means unlimited retained lifetime,
   * exactly as before this option existed. */
  retainedTtlMs?: number;
  /** Opt-in MQTT-over-WebSocket listener, alongside the existing plain-TCP
   * one - this
   * README's own "Websockets Support" feature was listed as "planned -
   * not implemented" with no WS dependency in package.json at all. Wraps
   * the SAME broker instance in a real HTTP+WS listener without touching
   * the existing protocol logic - see `wsToDuplex()`'s own comment for a
   * real, reproducible Aedes/Node hang this had to work around first.
   * Omitted (the default) starts no WS listener at all, unchanged from
   * before this option existed - `true` uses `DEFAULT_WS_PORT`, a number
   * picks the port explicitly. */
  wsPort?: number | true;
  /** Opt-in Prometheus-format metrics HTTP listener, serving `GET /metrics`
   * with real connected-client, message, and byte-in/out counters (see
   * metrics.ts). A separate listener rather than a route on the WS/MQTT
   * HTTP server above so metrics scraping never shares a port with real
   * MQTT-over-WS traffic. Omitted (the default) starts no metrics listener
   * at all, unchanged from before this option existed - `true` uses
   * `DEFAULT_METRICS_PORT`, a number picks the port explicitly. */
  metricsPort?: number | true;
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
): Promise<{ broker: Aedes; server: Server; wsServer?: HttpServer; metricsServer?: HttpServer; metrics: MetricsRegistry }> {
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
  const metricsPort = options.metricsPort === true ? DEFAULT_METRICS_PORT : options.metricsPort;
  if (
    metricsPort !== undefined &&
    (!Number.isInteger(metricsPort) || metricsPort < 0 || metricsPort > 65535)
  ) {
    throw new RangeError("metricsPort must be an integer from 0 to 65535");
  }
  if (
    options.retainedTtlMs !== undefined &&
    (!Number.isSafeInteger(options.retainedTtlMs) || options.retainedTtlMs <= 0)
  ) {
    throw new RangeError("retainedTtlMs must be a positive safe integer");
  }
  // Real counters, always maintained regardless of whether `metricsPort` is
  // set - a caller can read `metrics.snapshot()` directly (as tests below
  // do) even with no HTTP listener running.
  const metrics = new MetricsRegistry();
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
  // Real per-connection byte counts, straight from Node's own `net.Socket`
  // (`bytesRead`/`bytesWritten`) - counts actual wire traffic for the
  // plain-TCP listener, independent of MQTT-level payload sizes.
  server.on("connection", (socket) => metrics.trackSocket(socket));

  // Aedes emits these on its own event bus (not Node's `EventEmitter` types
  // from `net`), useful here purely as startup-visible proof the broker is
  // live and reacting to real client traffic, not just that the TCP socket
  // is open.
  broker.on("client", (client: Client) => {
    console.log(`[HYDRA-UMC-MQTT-BROKER] client connected: ${client?.id ?? "(unknown)"}`);
    metrics.clientConnected();
  });

  broker.on("clientDisconnect", (client: Client) => {
    console.log(`[HYDRA-UMC-MQTT-BROKER] client disconnected: ${client?.id ?? "(unknown)"}`);
    metrics.clientDisconnected();
  });

  broker.on("publish", (packet: AedesPublishPacket, client: Client | null) => {
    // client is null for messages the broker itself publishes (e.g. internal
    // $SYS topics, or this broker's own retained-TTL expiry below) - only
    // log/count real client traffic to keep this readable and the metric
    // meaningful.
    if (client) {
      console.log(`[HYDRA-UMC-MQTT-BROKER] ${client.id} -> ${packet.topic}`);
      metrics.messagePublished();
    }
  });

  if (options.retainedTtlMs !== undefined) {
    const ttl = options.retainedTtlMs;
    // Real per-topic "when was this retained state last (re)set" clock -
    // Aedes's own persistence layer tracks retained payloads but not
    // their age, so this is the smallest real addition needed rather
    // than reaching into that layer's own undocumented internals.
    const retainedSetAt = new Map<string, number>();
    broker.on("publish", (packet: AedesPublishPacket, client: Client | null) => {
      if (!packet.retain) return;
      const hasPayload = Buffer.isBuffer(packet.payload)
        ? packet.payload.length > 0
        : Buffer.byteLength(String(packet.payload ?? "")) > 0;
      if (hasPayload) {
        // A real client set/refreshed retained state - restart its clock.
        // The broker's OWN clearing publish below also has client===null
        // and an empty payload, so it can never re-arm an entry it just
        // expired.
        if (client) retainedSetAt.set(packet.topic, Date.now());
      } else {
        // Cleared (by a real client, or by this same sweep) - nothing
        // left to expire.
        retainedSetAt.delete(packet.topic);
      }
    });
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [topic, setAt] of retainedSetAt) {
        if (now - setAt < ttl) continue;
        retainedSetAt.delete(topic);
        broker.publish(
          { cmd: "publish", topic, payload: Buffer.alloc(0), qos: 0, retain: true, dup: false },
          (err) => {
            if (err) {
              console.error(`[HYDRA-UMC-MQTT-BROKER] failed to expire retained message on '${topic}': ${err.message}`);
            } else {
              console.log(`[HYDRA-UMC-MQTT-BROKER] expired retained message on '${topic}' (older than ${ttl}ms)`);
            }
          },
        );
      }
      // A sweep interval longer than the TTL itself would let a message
      // outlive its own limit by up to (interval - ttl) before this ever
      // notices it - capping at `ttl` keeps the worst-case delay bounded
      // by the TTL, never by an unrelated fixed cadence.
    }, Math.min(ttl, 30_000));
    sweep.unref();
    broker.on("closed", () => clearInterval(sweep));
  }

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
    // Same real byte-counting as the plain-TCP listener above - the raw
    // socket underneath a WS upgrade is still a real `net.Socket` with its
    // own `bytesRead`/`bytesWritten`.
    wsServer.on("connection", (socket) => metrics.trackSocket(socket));
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

  let metricsServer: HttpServer | undefined;
  if (metricsPort !== undefined) {
    // Deliberately a separate, minimal HTTP server rather than a route
    // bolted onto `wsServer` above - a Prometheus scraper's own port must
    // never collide with real MQTT-over-WS client traffic, and this way
    // metrics stay available even when `wsPort` itself is omitted.
    metricsServer = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        const body = metrics.renderPrometheus();
        res.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    });
    metricsServer.listen(metricsPort, "0.0.0.0");
  }

  return { broker, server, wsServer, metricsServer, metrics };
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

  if (process.env.MQTT_METRICS_PORT) {
    const metricsPort = Number(process.env.MQTT_METRICS_PORT);
    if (!Number.isInteger(metricsPort) || metricsPort < 0 || metricsPort > 65535) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] MQTT_METRICS_PORT must be an integer from 0 to 65535, got: ${process.env.MQTT_METRICS_PORT}`);
      process.exit(1);
    }
    options.metricsPort = metricsPort;
  }

  if (process.env.MQTT_RETAINED_TTL_MS) {
    const retainedTtlMs = Number(process.env.MQTT_RETAINED_TTL_MS);
    if (!Number.isSafeInteger(retainedTtlMs) || retainedTtlMs <= 0) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] MQTT_RETAINED_TTL_MS must be a positive integer, got: ${process.env.MQTT_RETAINED_TTL_MS}`);
      process.exit(1);
    }
    options.retainedTtlMs = retainedTtlMs;
  }

  return options;
}

async function main() {
  const options = loadBrokerOptionsFromEnv();
  const { broker, server, wsServer, metricsServer } = await buildBroker(DEFAULT_PORT, options);

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
    if (metricsServer) {
      const metricsPort = options.metricsPort === true ? DEFAULT_METRICS_PORT : options.metricsPort;
      console.log(` STATUS: Running on port ${metricsPort} (Prometheus metrics, GET /metrics)`);
    }
    console.log("=================================================");
  });

  if (wsServer) {
    wsServer.on("error", (err) => {
      console.error("[HYDRA-UMC-MQTT-BROKER] fatal WebSocket transport error:", err);
      process.exit(1);
    });
  }

  if (metricsServer) {
    metricsServer.on("error", (err) => {
      console.error("[HYDRA-UMC-MQTT-BROKER] fatal metrics transport error:", err);
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
      const closeWsThen = (next: () => void) => (wsServer ? wsServer.close(() => next()) : next());
      const closeMetricsThen = (next: () => void) => (metricsServer ? metricsServer.close(() => next()) : next());
      closeWsThen(() => closeMetricsThen(() => broker.close(() => process.exit(0))));
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
