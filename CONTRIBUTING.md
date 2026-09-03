# Contributing to HYDRA-UMC-MQTT-BROKER 🦾

We welcome contributions to the lightweight telemetry bridge of the HYDRA-UMC ecosystem.

## Technology Stack
- **Runtime**: Node.js 20+.
- **Broker Core**: Aedes (High-performance MQTT broker).
- **Protocols**: MQTT 3.1.1 (Aedes), MQTT over WebSockets.
- **Security**: MQTT CONNECT username/password authentication (`MQTT_AUTH_JSON`), Topic-level ACLs.

## Guidelines
1. **Messaging Efficiency**: Ensure that MQTT publishes for high-frequency telemetry (like joint angles) are optimized to prevent broker congestion.
2. **Topic Hierarchy**: Follow the standardized ecosystem topic structure (`hydra/swarm/<robot_id>/...`) to ensure compatibility with Studios and Apps.
3. **ACL Safety**: Any changes to the security module must maintain strict isolation between different robot swarms.
4. **Testing**: Run the real Vitest suite (`npm test`, `tests/*.test.ts`) - it drives a real MQTT client library against a real broker over a real TCP socket for CONNECT, PUBLISH, ACL and auth behavior.
