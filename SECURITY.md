# Security Policy 🔒 (HYDRA-UMC-MQTT-BROKER)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x  | ✅ Yes             |

## Reporting a Vulnerability

**CRITICAL: Do not report safety-critical vulnerabilities through public GitHub issues.**

In an MQTT broker, a security flaw can allow unauthorized monitoring or command injection across the entire swarm. If you discover a vulnerability affecting the **JWT validation**, **ACL enforcement**, or **WebSocket hijacking**:

1. **Email**: Send a detailed report to `electrohobby3d@gmail.com`.
2. **Impact**: Describe if the bug allows unauthorized subscription to private robot topics, publishing spoofed commands, or causing a denial of service (DoS) for factory telemetry.
3. **Response**: Initial acknowledgment within 48 hours.

We follow a coordinated disclosure policy to ensure hardware safety before public release.
