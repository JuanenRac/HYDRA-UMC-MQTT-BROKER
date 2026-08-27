# Contributing to HYDRA-UMC-MQTT-BROKER 🦾

We welcome contributions to the lightweight telemetry bridge of the HYDRA-UMC ecosystem.

## Technology Stack
- **Runtime**: Node.js 20+.
- **Broker Core**: Aedes (High-performance MQTT broker).
- **Protocols**: MQTT v5, MQTT over WebSockets.
- **Security**: JWT-based authentication, Topic-level ACLs.

## Guidelines
1. **Messaging Efficiency**: Ensure that MQTT publishes for high-frequency telemetry (like joint angles) are optimized to prevent broker congestion.
2. **Topic Hierarchy**: Follow the standardized ecosystem topic structure (`hydra/swarm/<robot_id>/...`) to ensure compatibility with Studios and Apps.
3. **ACL Safety**: Any changes to the security module must maintain strict isolation between different robot swarms.
4. **Testing**: Validate broker performance under high load (100+ concurrent subscribers) using the `tests/load_test.js` script.
