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
Each credential also declares its own `clientIdPrefix`, and CONNECT is
rejected unless the client's declared ID actually starts with it - a valid,
lower-privilege credential cannot simply choose a different, more privileged
client ID and inherit `MQTT_ACL_JSON`'s permissions for it (found and fixed
in an ecosystem-wide software-improvements audit). Pair the two: ACL rules
restrict topics, authentication requires a real credential, and the
credential's own prefix ties that identity to the ACL rule it is actually
allowed to use. The transport is
plain MQTT/TCP today, so deployment on an untrusted network requires a trusted
private network or a TLS-terminating gateway. Never commit production secrets.

We follow a coordinated disclosure policy to ensure hardware safety before public release.
