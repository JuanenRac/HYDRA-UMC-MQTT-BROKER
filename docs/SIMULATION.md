# Simulation bench

Runs the real broker with a simulated fleet of robots, bridges and dashboards (real MQTT clients, a fixed seed) that behave badly on command.

Scenarios:

- twenty simulated robots publish seeded telemetry and a dashboard receives every message, in order per robot;
- a bridge killed without a goodbye is announced offline by its will, a polite one is not; retained state comes back to a late client and a cleared one stays cleared;
- a robot that publishes where the ACL does not allow it is dropped without touching the others, and a dashboard cannot publish;
- an oversized message is dropped at the limit while a message at the limit passes;
- fifty connections of random bytes and a connection that never sends CONNECT do not stop the broker from serving a real client;
- the wrong password, the wrong user, no credentials and a borrowed identity are refused;
- commands that are unsigned, expired, future-dated, too long-lived, retained or not JSON never reach the bridge.

The evidence of this project is `simulator`: it says nothing about real machines, real networks or real load.
