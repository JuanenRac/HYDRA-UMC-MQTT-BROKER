// =============================================================================
// HYDRA-UMC MQTT BROKER - MQTT 3.1.1 Broker over plain TCP: src/server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
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
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { readFileSync } from "node:fs";
import { Duplex } from "node:stream";
import { Aedes, type Client, type AedesPublishPacket } from "aedes";
import { WebSocketServer, type WebSocket } from "ws";
import { readPackageVersion } from "./version.js";
import { type AclRule, isPublishAllowed, isSubscribeAllowed, parseAclConfig } from "./acl.js";
import {
  type BrokerCredential,
  authenticatedPrefixAsync,
  parseCredentialsConfig,
} from "./auth.js";
import { DEFAULT_PRODUCTION_RETAINED_TTL_MS, isProduction, openStartWarnings, productionProblems } from "./security.js";
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

// 8883 is the IANA-registered port of MQTT over TLS.
const DEFAULT_TLS_PORT = 8883;

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
  /** opt-in real expiry for retained messages. Aedes retains a
   * PUBLISH with `retain: true` indefinitely by default, with no concept
   * of "this state is too old to still hand to a new subscriber" - a
   * bridge/tool that died mid-session with a stale command retained
   * would keep replaying that exact command to every future subscriber
   * forever. already defends the CLIENT side of this (a bridge must
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
  /** Opt-in TLS for the MQTT listener (`tlsPort`, default 8883) and, when `wssPort` is set, for MQTT over WebSocket. PEM contents; `ca` plus `requireClientCert` turn it into mutual TLS. The plain listeners stay as they are: bind them to 127.0.0.1 or do not publish their ports when TLS is the only door. */
  tls?: {
    cert: string | Buffer;
    key: string | Buffer;
    ca?: string | Buffer;
    requireClientCert?: boolean;
    /** Opt-in: a client that presents a verified certificate is identified by the CN of its subject, and the ACL is evaluated against that CN (the client ID it declares must start with it) - no password needed. Needs `ca` and `requireClientCert`. A client without a certificate still has to use `credentials`, when there are any, and is refused otherwise. Omitted (the default) leaves the identity to the credentials as before. */
    certIdentity?: boolean;
  };
  /** TLS MQTT port. Only used when `tls` is set. Omitted means 8883. */
  tlsPort?: number;
  /** MQTT-over-WebSocket-over-TLS port. Only used when `tls` is set; omitted starts no WSS listener. */
  wssPort?: number;
  /** Browser origins allowed to open an MQTT-over-WebSocket connection. Omitted allows any origin; clients that send no Origin header (not browsers) are always allowed. */
  wsAllowedOrigins?: string[];
  /** The address the MQTT (TCP and WebSocket) listeners bind to. Omitted means every interface (0.0.0.0), as before; a deployment that only talks to local services sets 127.0.0.1. */
  host?: string;
  /** The address of the metrics listener. Omitted means the same as `host`. */
  metricsHost?: string;
  /** Milliseconds a new connection may wait before sending CONNECT; after that it is closed. Omitted keeps Aedes's own 30000. */
  connectTimeoutMs?: number;
  /** The largest keep-alive (seconds) a client may ask for; a client that asks for more, or for none, is refused. Omitted accepts any keep-alive, as before. */
  keepaliveLimitSeconds?: number;
  /** How many packets a connection may queue before its CONNECT is processed. Omitted keeps Aedes's own 42. */
  queueLimit?: number;
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
    // Aedes closes a client it rejects (protocol error, failed login, ACL,
    // keep-alive) by destroying this stream; the WebSocket underneath has to
    // go with it or it stays open as a zombie connection.
    final(callback) {
      socket.close();
      callback();
    },
    destroy(error, callback) {
      pending = [];
      if (socket.readyState !== socket.CLOSED) socket.terminate();
      callback(error);
    },
  });

  let pending: Buffer[] = [];
  let flushScheduled = false;
  let ended = false;
  const flush = () => {
    flushScheduled = false;
    if (ended || duplex.destroyed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    duplex.push(Buffer.concat(batch));
  };
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    pending.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flush);
    }
  });
  socket.on("close", () => {
    // Hand over what is still buffered (it may hold a DISCONNECT, which
    // decides whether the will message is sent) before signalling the end.
    flush();
    ended = true;
    duplex.push(null);
  });
  socket.on("error", (err) => duplex.destroy(err));

  return duplex;
}

/**
 * The CN of the verified client certificate behind an Aedes client, or null when the connection has none (plain TCP, plain WebSocket,
 * a TLS client without a certificate). Only a certificate the TLS layer accepted counts.
 */
function verifiedCertificateSubject(client: Client | null | undefined): string | null {
  const conn = (client as unknown as { conn?: { getPeerCertificate?: unknown; peerSocket?: unknown } } | null | undefined)?.conn;
  const socket = (typeof conn?.getPeerCertificate === "function" ? conn : conn?.peerSocket) as
    | { authorized?: boolean; getPeerCertificate?: () => { subject?: { CN?: string | string[] } } }
    | undefined;
  if (!socket || socket.authorized !== true || typeof socket.getPeerCertificate !== "function") return null;
  const common = socket.getPeerCertificate()?.subject?.CN;
  const name = Array.isArray(common) ? common[0] : common;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Whether `origin` may open an MQTT-over-WebSocket connection. */
function originAllowed(origin: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!origin) return true; // not a browser
  return allowed.includes(origin);
}

export async function buildBroker(
  port: number = DEFAULT_PORT,
  options: BuildBrokerOptions = {},
): Promise<{
  broker: Aedes;
  server: Server;
  wsServer?: HttpServer;
  metricsServer?: HttpServer;
  tlsServer?: TlsServer;
  wssServer?: HttpServer;
  metrics: MetricsRegistry;
}> {
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
  for (const [name, value] of [
    ["connectTimeoutMs", options.connectTimeoutMs],
    ["keepaliveLimitSeconds", options.keepaliveLimitSeconds],
    ["queueLimit", options.queueLimit],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (options.tls?.certIdentity && (!options.tls.ca || options.tls.requireClientCert !== true)) {
    throw new RangeError("tls.certIdentity needs tls.ca and tls.requireClientCert");
  }
  // Real counters, always maintained regardless of whether `metricsPort` is
  // set - a caller can read `metrics.snapshot()` directly (as tests below
  // do) even with no HTTP listener running.
  const metrics = new MetricsRegistry();
  // maxClientsIdLength: MQTT 3.1 caps a client ID at 23 characters and Aedes enforces
  // that for protocol level 3, which would refuse the bridges' longer IDs.
  const broker = new Aedes({
    id: "hydra-umc-mqtt-broker",
    maxClientsIdLength: 128,
    ...(options.connectTimeoutMs !== undefined ? { connectTimeout: options.connectTimeoutMs } : {}),
    ...(options.keepaliveLimitSeconds !== undefined ? { keepaliveLimit: options.keepaliveLimitSeconds } : {}),
    ...(options.queueLimit !== undefined ? { queueLimit: options.queueLimit } : {}),
  });
  const host = options.host ?? "0.0.0.0";
  const metricsHost = options.metricsHost ?? host;
  // The verified principal of each authenticated client (the prefix of the credential it proved). The ACL is evaluated against it, not against the client ID the client chose.
  const principals = new WeakMap<object, string>();
  const aclIdentity = (client: Client | null | undefined): string => (client ? principals.get(client) ?? client.id ?? "" : "");
  // Aedes 1.x moved persistence/mqemitter setup into an explicit async
  // listen() step (a real, undocumented-in-the-original-scaffold change
  // from the 0.x factory-function API) - skipping it left the broker's
  // `this.persistence` unset, so every real CONNECT silently hung until
  // the client's own connack timeout fired. Found via a real client
  // connecting and timing out in this project's own tests, not by
  // inspection.
  await broker.listen();

  const certIdentity = options.tls?.certIdentity === true;
  if (options.credentials || certIdentity) {
    const credentials = options.credentials ?? [];
    broker.authenticate = (client, username, password, callback) => {
      const reject = () => {
        // MQTT 3.1.1 CONNACK code 4: bad username or password. Aedes requires
        // this property to reject CONNECT without accepting a usable session.
        const error = Object.assign(new Error("MQTT authentication failed"), { returnCode: 4 as const });
        callback(error, false);
      };
      if (certIdentity) {
        const subject = verifiedCertificateSubject(client);
        if (subject !== null) {
          // the client ID must start with the certificate's own name, as a credential's prefix is bound to its ID
          if (client?.id.startsWith(subject)) {
            principals.set(client, subject);
            callback(null, true);
          } else {
            reject();
          }
          return;
        }
      }
      // client.id is already populated from the real CONNECT
      // packet at this point (Aedes parses it before calling authenticate)
      // - binding it here is what stops a validly-authenticated, low-
      // privilege user from simply declaring a different, privileged
      // client ID to pass src/acl.ts's own prefix-based rules.
      // The password check of a hashed credential runs in the thread pool, not on the event loop.
      authenticatedPrefixAsync(credentials, username, password, client?.id).then(
        (principal) => {
          if (principal !== null) {
            if (client) principals.set(client, principal);
            callback(null, true);
          } else {
            reject();
          }
        },
        () => reject(),
      );
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
        const clientId = aclIdentity(client);
        if (!isPublishAllowed(options.acl, clientId, packet.topic)) {
          metrics.aclDenied();
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
      if (isSubscribeAllowed(rules, aclIdentity(client), subscription.topic ?? "")) {
        callback(null, subscription);
        return;
      }
      metrics.aclDenied();
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
        // Dropped straight from the persistence layer. Publishing an empty
        // retained message instead would also be delivered to live
        // subscribers, and a bridge would read that empty message as a fresh
        // command.
        (broker as unknown as { persistence: { storeRetained(packet: unknown): Promise<void> } }).persistence
          .storeRetained({ cmd: "publish", topic, payload: Buffer.alloc(0), qos: 0, retain: true, dup: false })
          .then(
            () => console.log(`[HYDRA-UMC-MQTT-BROKER] expired retained message on '${topic}' (older than ${ttl}ms)`),
            (err: Error) => console.error(`[HYDRA-UMC-MQTT-BROKER] failed to expire retained message on '${topic}': ${err.message}`),
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

  // One WebSocket front for the plain and the TLS HTTP listeners.
  function attachWebSocket(httpServer: HttpServer): void {
    const wsSocketServer = new WebSocketServer({
      server: httpServer,
      // A frame bigger than the payload cap can never be a valid packet; without a
      // cap `ws` accepts 100 MiB frames.
      ...(options.maxPayloadBytes !== undefined ? { maxPayload: options.maxPayloadBytes + 65536 } : {}),
      verifyClient: (info: { origin: string }) => originAllowed(info.origin || undefined, options.wsAllowedOrigins),
    });
    wsSocketServer.on("connection", (socket, request) => {
      const stream = wsToDuplex(socket);
      // the TLS socket under a secure WebSocket, for the certificate identity
      (stream as unknown as { peerSocket: unknown }).peerSocket = request.socket;
      // A WS transport error (client vanished mid-frame, a malformed
      // frame) would otherwise crash the process as an unhandled 'error'
      // on the wrapped Duplex - the broker.on("client"/"clientDisconnect")
      // logging above already covers a WS client exactly like a TCP one,
      // since those are real Aedes-level events, not transport-level.
      stream.on("error", () => undefined);
      broker.handle(stream);
    });
  }

  server.listen(port, host);

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
    attachWebSocket(wsServer);
    wsServer.listen(wsPort, host);
  }

  let tlsServer: TlsServer | undefined;
  let wssServer: HttpServer | undefined;
  if (options.tls) {
    const tlsOptions = {
      cert: options.tls.cert,
      key: options.tls.key,
      ca: options.tls.ca,
      requestCert: options.tls.requireClientCert === true,
      rejectUnauthorized: options.tls.requireClientCert === true,
    };
    tlsServer = createTlsServer(tlsOptions, broker.handle);
    tlsServer.on("secureConnection", (socket) => metrics.trackSocket(socket));
    tlsServer.listen(options.tlsPort ?? DEFAULT_TLS_PORT, host);
    if (options.wssPort !== undefined) {
      wssServer = createHttpsServer(tlsOptions);
      wssServer.on("secureConnection", (socket) => metrics.trackSocket(socket));
      attachWebSocket(wssServer);
      wssServer.listen(options.wssPort, host);
    }
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
    metricsServer.listen(metricsPort, metricsHost);
  }

  return { broker, server, wsServer, metricsServer, tlsServer, wssServer, metrics };
}

/**
 * Orderly stop: Aedes closes its clients first (a server.close() on its own
 * waits for those connections to end, which never happens while clients stay
 * connected), then every listener closes. A safety timer ends the wait if
 * something still holds on.
 */
export async function closeBroker(
  built: { broker: Aedes; server: Server; wsServer?: HttpServer; metricsServer?: HttpServer; tlsServer?: TlsServer; wssServer?: HttpServer },
  timeoutMs = 5000,
): Promise<void> {
  const closeListener = (listener: { close(callback: () => void): unknown } | undefined) =>
    new Promise<void>((resolve) => {
      if (!listener) return resolve();
      try {
        listener.close(() => resolve());
      } catch {
        resolve(); // already closed
      }
    });
  const closing = (async () => {
    await new Promise<void>((resolve) => built.broker.close(() => resolve()));
    await Promise.all([
      closeListener(built.server),
      closeListener(built.wsServer),
      closeListener(built.metricsServer),
      closeListener(built.tlsServer),
      closeListener(built.wssServer),
    ]);
  })();
  await Promise.race([closing, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
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

  if (process.env.MQTT_TLS_CERT || process.env.MQTT_TLS_KEY) {
    if (!process.env.MQTT_TLS_CERT || !process.env.MQTT_TLS_KEY) {
      console.error("[HYDRA-UMC-MQTT-BROKER] MQTT_TLS_CERT and MQTT_TLS_KEY must be set together");
      process.exit(1);
    }
    try {
      options.tls = {
        cert: readFileSync(process.env.MQTT_TLS_CERT),
        key: readFileSync(process.env.MQTT_TLS_KEY),
        ...(process.env.MQTT_TLS_CA ? { ca: readFileSync(process.env.MQTT_TLS_CA) } : {}),
        requireClientCert: process.env.MQTT_TLS_REQUIRE_CLIENT_CERT === "1",
        certIdentity: process.env.MQTT_TLS_CERT_IDENTITY === "1",
      };
    } catch (err) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] cannot read the TLS files: ${(err as Error).message}`);
      process.exit(1);
    }
    if (options.tls.requireClientCert && !options.tls.ca) {
      console.error("[HYDRA-UMC-MQTT-BROKER] MQTT_TLS_REQUIRE_CLIENT_CERT=1 needs MQTT_TLS_CA");
      process.exit(1);
    }
    if (options.tls.certIdentity && !options.tls.requireClientCert) {
      console.error("[HYDRA-UMC-MQTT-BROKER] MQTT_TLS_CERT_IDENTITY=1 needs MQTT_TLS_REQUIRE_CLIENT_CERT=1 and MQTT_TLS_CA");
      process.exit(1);
    }
    for (const [name, key] of [["MQTT_TLS_PORT", "tlsPort"], ["MQTT_WSS_PORT", "wssPort"]] as const) {
      const raw = process.env[name];
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        console.error(`[HYDRA-UMC-MQTT-BROKER] ${name} must be an integer from 0 to 65535, got: ${raw}`);
        process.exit(1);
      }
      options[key] = value;
    }
  }

  if (process.env.MQTT_WS_ALLOWED_ORIGINS) {
    options.wsAllowedOrigins = process.env.MQTT_WS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  }

  for (const [name, key] of [
    ["MQTT_CONNECT_TIMEOUT_MS", "connectTimeoutMs"],
    ["MQTT_KEEPALIVE_LIMIT_SECONDS", "keepaliveLimitSeconds"],
    ["MQTT_QUEUE_LIMIT", "queueLimit"],
  ] as const) {
    const raw = process.env[name];
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] ${name} must be a positive integer, got: ${raw}`);
      process.exit(1);
    }
    options[key] = value;
  }

  if (process.env.MQTT_BIND_HOST) options.host = process.env.MQTT_BIND_HOST.trim();
  if (process.env.MQTT_METRICS_HOST) options.metricsHost = process.env.MQTT_METRICS_HOST.trim();

  if (process.env.MQTT_RETAINED_TTL_MS) {
    const retainedTtlMs = Number(process.env.MQTT_RETAINED_TTL_MS);
    if (!Number.isSafeInteger(retainedTtlMs) || retainedTtlMs <= 0) {
      console.error(`[HYDRA-UMC-MQTT-BROKER] MQTT_RETAINED_TTL_MS must be a positive integer, got: ${process.env.MQTT_RETAINED_TTL_MS}`);
      process.exit(1);
    }
    options.retainedTtlMs = retainedTtlMs;
  } else if (isProduction(process.env)) {
    // A retained command must not be replayed to every future subscriber for ever.
    options.retainedTtlMs = DEFAULT_PRODUCTION_RETAINED_TTL_MS;
  }

  const problems = productionProblems({ ...options, certIdentity: options.tls?.certIdentity }, process.env);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[HYDRA-UMC-MQTT-BROKER] refusing to start in production: ${problem}`);
    console.error("[HYDRA-UMC-MQTT-BROKER] set MQTT_AUTH_JSON and MQTT_ACL_JSON (see docs), or MQTT_ALLOW_ANONYMOUS=1 for an open lab broker.");
    process.exit(1);
  }
  for (const warning of openStartWarnings({ ...options, certIdentity: options.tls?.certIdentity })) console.warn(`[HYDRA-UMC-MQTT-BROKER] WARNING: ${warning}`);

  return options;
}

async function main() {
  const options = loadBrokerOptionsFromEnv();
  const built = await buildBroker(DEFAULT_PORT, options);
  const { server, wsServer, metricsServer, tlsServer, wssServer } = built;

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
    void closeBroker(built).then(() => process.exit(0));
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
