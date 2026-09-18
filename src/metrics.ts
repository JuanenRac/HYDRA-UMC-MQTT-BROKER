// =============================================================================
// HYDRA-UMC MQTT BROKER - Prometheus-format metrics: src/metrics.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real, always-on counters for this broker's own operational health -
// connected clients, total messages received from real clients, and total
// bytes read/written across every client connection (TCP and WebSocket
// alike, since both end up as a real `net.Socket` under the hood). Exposed
// as a Prometheus text-format scrape target (see server.ts's own
// `metricsPort` option) rather than a custom JSON shape, matching how any
// off-the-shelf Prometheus/Grafana setup already expects a broker's metrics
// to look with zero extra configuration.
//
// "messages/sec" is deliberately exposed as a monotonic counter
// (`hydra_mqtt_messages_total`), not a pre-computed rate - that is the
// standard Prometheus convention (e.g. `http_requests_total`); the actual
// per-second rate is `rate(hydra_mqtt_messages_total[1m])`, computed by the
// scraper, not guessed at here with an arbitrary internal window.
// =============================================================================

/** The subset of `net.Socket` this module actually needs - kept narrow so
 * tests can pass a plain object instead of a real socket. */
export interface TrackableSocket {
  bytesRead: number;
  bytesWritten: number;
  once(event: "close", listener: () => void): unknown;
}

export interface MetricsSnapshot {
  connectedClients: number;
  messagesTotal: number;
  bytesInTotal: number;
  bytesOutTotal: number;
}

export class MetricsRegistry {
  private connectedClients = 0;
  private messagesTotal = 0;
  private closedBytesIn = 0;
  private closedBytesOut = 0;
  // Real per-connection byte counts (Node maintains `bytesRead`/
  // `bytesWritten` on every `net.Socket` automatically) - summed live for
  // open sockets and folded into the closed-socket totals once a
  // connection ends, so a long-lived connection's traffic is never lost
  // and a closed one is never double-counted.
  private readonly openSockets = new Set<TrackableSocket>();

  clientConnected(): void {
    this.connectedClients += 1;
  }

  clientDisconnected(): void {
    this.connectedClients = Math.max(0, this.connectedClients - 1);
  }

  messagePublished(): void {
    this.messagesTotal += 1;
  }

  /** Starts counting one real connection's bytes in/out. Safe to call for
   * both the plain-TCP listener's sockets and the WebSocket HTTP listener's
   * underlying raw sockets - either way it's the same real byte counters. */
  trackSocket(socket: TrackableSocket): void {
    this.openSockets.add(socket);
    socket.once("close", () => {
      this.closedBytesIn += socket.bytesRead;
      this.closedBytesOut += socket.bytesWritten;
      this.openSockets.delete(socket);
    });
  }

  snapshot(): MetricsSnapshot {
    let openBytesIn = 0;
    let openBytesOut = 0;
    for (const socket of this.openSockets) {
      openBytesIn += socket.bytesRead;
      openBytesOut += socket.bytesWritten;
    }
    return {
      connectedClients: this.connectedClients,
      messagesTotal: this.messagesTotal,
      bytesInTotal: this.closedBytesIn + openBytesIn,
      bytesOutTotal: this.closedBytesOut + openBytesOut,
    };
  }

  /** Real Prometheus exposition-format text (the same shape `GET /metrics`
   * on any standard exporter returns) - HELP/TYPE lines plus one sample per
   * metric, no external `prom-client`-style dependency needed for four
   * plain counters/gauges. */
  renderPrometheus(): string {
    const s = this.snapshot();
    return [
      "# HELP hydra_mqtt_connected_clients Number of MQTT clients currently connected (TCP + WebSocket).",
      "# TYPE hydra_mqtt_connected_clients gauge",
      `hydra_mqtt_connected_clients ${s.connectedClients}`,
      "# HELP hydra_mqtt_messages_total Total PUBLISH messages received from real clients since startup.",
      "# TYPE hydra_mqtt_messages_total counter",
      `hydra_mqtt_messages_total ${s.messagesTotal}`,
      "# HELP hydra_mqtt_bytes_in_total Total bytes read from client connections since startup.",
      "# TYPE hydra_mqtt_bytes_in_total counter",
      `hydra_mqtt_bytes_in_total ${s.bytesInTotal}`,
      "# HELP hydra_mqtt_bytes_out_total Total bytes written to client connections since startup.",
      "# TYPE hydra_mqtt_bytes_out_total counter",
      `hydra_mqtt_bytes_out_total ${s.bytesOutTotal}`,
      "",
    ].join("\n");
  }
}
