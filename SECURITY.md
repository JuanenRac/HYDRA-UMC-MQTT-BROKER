# Security Policy 🔒 (HYDRA-UMC-MQTT-BROKER)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x  | ✅ Yes             |

## Reporting a Vulnerability

**CRITICAL: Do not report safety-critical vulnerabilities through public GitHub issues.**

In an MQTT broker, a security flaw can allow unauthorized monitoring or command injection across the entire swarm. If you discover a vulnerability affecting **MQTT authentication**, **ACL enforcement**, payload limits, or connection handling:

1. **Email**: Send a detailed report to `electrohobby3d@gmail.com`.
2. **Impact**: Describe if the bug allows unauthorized subscription to private robot topics, publishing spoofed commands, or causing a denial of service (DoS) for factory telemetry.
3. **Response**: Initial acknowledgment within 48 hours.

### Current security boundary

`MQTT_AUTH_JSON` can require a configured username/password at MQTT CONNECT;
the broker compares a matching password using Node's constant-time comparison.
Pair it with `MQTT_ACL_JSON`: ACL rules restrict topics, while authentication
prevents a peer from merely selecting another client's ID. The transport is
plain MQTT/TCP today, so deployment on an untrusted network requires a trusted
private network or a TLS-terminating gateway. Never commit production secrets.

We follow a coordinated disclosure policy to ensure hardware safety before public release.
