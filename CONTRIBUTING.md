# Contributing to HYDRA-UMC-MQTT-BROKER 🦾

We welcome contributions to the lightweight telemetry bridge of the HYDRA-UMC ecosystem.

## Technology Stack
- **Runtime**: Node.js 20+, TypeScript, ES modules.
- **Broker core**: Aedes (`aedes@1.1.x`, MQTT 3.1/3.1.1 only - not MQTT v5).
- **Transports**: plain MQTT/TCP (default `1883`), optional MQTT-over-WebSocket (`MQTT_WS_PORT`, default `8083`).
- **Build**: `esbuild` bundles `src/server.ts` to `dist/server.cjs`.
- **Security**: optional MQTT CONNECT username/password authentication (`MQTT_AUTH_JSON`), per-client-ID-prefix topic ACLs (`MQTT_ACL_JSON`), optional `MAX_PAYLOAD_BYTES` cap.

## Guidelines
1. **Messaging efficiency**: keep publishes for high-frequency telemetry optimized so a busy client cannot congest the broker.
2. **Topic hierarchy**: the real, wired topics today are the external-machine bridges' `hydra/bridges/<name>/...` namespace (see `docs/BRIDGE_TOPICS.md`) plus HYDRA-UMC-BRIDGE-AMR's VDA 5050 shape. `hydra/swarm/<robot_id>/...` is the intended target shape once HYDRA-UMC-SERVER state is bridged - not implemented yet, so do not document it as if it were live.
3. **ACL safety**: any change to `src/acl.ts` must keep subscription-scope checking intact (a wildcard SUBSCRIBE can never grant more than its rule) and maintain strict isolation between clients.
4. **Testing**: run `npm run typecheck` and `npm test` (the real Vitest suite drives a real MQTT client library against a real broker over a real socket), plus `python tools/ci_validate.py`, before opening a pull request.
