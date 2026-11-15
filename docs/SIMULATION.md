# Simulation bench

Runs the real broker with a simulated fleet of robots, bridges and dashboards (real MQTT clients, a fixed seed) that behave badly on command.

Scenarios:

- twenty simulated robots publish seeded telemetry and a dashboard receives every message, in order per robot;
- a bridge killed without a goodbye is announced offline by its will, a polite one is not; retained state comes back to a late client and a cleared one stays cleared;
- a robot that publishes where the ACL does not allow it is dropped without touching the others, and a dashboard cannot publish;
- an oversized message is dropped at the limit while a message at the limit passes;
- fifty connections of random bytes and a connection that never sends CONNECT do not stop the broker from serving a real client;
- the wrong password, the wrong user, no credentials and a borrowed identity are refused;
- commands that are unsigned, expired, future-dated, too long-lived, retained or not JSON never reach the bridge;
- a client that opens a connection, sends its first packet and goes silent is declared dead after one and a half keep-alive periods, its will reaches the dashboard and its connection is closed;
- a second connection with the same client identifier takes over and the first is dropped, and the commands then reach the newer one;
- a robot with a persistent session gets, in order, the commands published while it was away, and one with a clean session does not;
- a broker that is stopped and started again under a live fleet is found by the clients that reconnect and resubscribe on their own, and the traffic resumes.

Pending on real hardware: a run of the same scenarios on the CM5 bench with the real bridges and a real network that drops packets, and the load of a full fleet.

The evidence of this project is `simulator`: it says nothing about real machines, real networks or real load.
