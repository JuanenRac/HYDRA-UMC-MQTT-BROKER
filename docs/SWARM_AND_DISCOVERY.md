<!--
=============================================================================
HYDRA-UMC MQTT BROKER - The swarm topics of the server and the discovery
Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
CC BY-SA 4.0 - see LICENSE.md
=============================================================================
-->

# The swarm topics of the server, and discovery

## `hydra/swarm/...`: the state of the robots

HYDRA-UMC-SERVER has an MQTT bridge of its own (off by default; its `docs/MQTT_BRIDGE.md` describes the modes and the topics). It connects to this broker with a client ID that
starts with `hydra-umc-server-` and publishes, retained, the state of every robot on `<prefix>/robot_<id>/state`, `/joints` and `/tool` (`<prefix>` is `hydra/swarm` unless the
server says another) and its own presence on `<prefix>/status`. In the mode `commands` it also subscribes to `<prefix>/+/cmd/+`, carries each command out through its own
`POST /api/robot/:id/command` with the token of a dedicated account, and answers on `<prefix>/robot_<id>/cmd/<command>/result`. This broker does not know any of that: it carries
the messages and enforces the ACL.

The ACL below is the one the checks of this repository run against a real broker (`tests/discovery-broker.test.ts`). Put it in `MQTT_ACL_JSON` and give each client a credential whose
`clientIdPrefix` is the prefix of its rule (see `MQTT_AUTH_JSON`):

```json
[
  { "clientIdPrefix": "hydra-umc-server-",
    "publish": ["hydra/swarm/status", "hydra/swarm/+/state", "hydra/swarm/+/joints", "hydra/swarm/+/tool", "hydra/swarm/safety/estop", "hydra/swarm/+/cmd/+/result", "homeassistant/#"],
    "subscribe": ["hydra/swarm/+/cmd/+"] },
  { "clientIdPrefix": "operator-", "publish": ["hydra/swarm/+/cmd/+"], "subscribe": ["hydra/swarm/#"] },
  { "clientIdPrefix": "dashboard-", "publish": [], "subscribe": ["hydra/swarm/#"] }
]
```

* The server alone can publish state; only an `operator-` client can publish a command, and the server still presents it to the route with the role of its command account, so the
  reservations of the robots and the limits of the jog apply as to any other client.
* A dashboard reads and cannot command. A client the ACL does not name can neither publish nor subscribe.
* `homeassistant/#` is only needed when the server publishes the Home Assistant configs of the robots (`mqtt.homeAssistant.enabled` of the server).
* `hydra/swarm/+/cmd/+/result` is the answer to a command; give a client that sends commands `subscribe` on it as well when it wants the answer.

## mDNS: find the broker without an address

Off by default. `MQTT_MDNS=1` makes the broker announce itself on the local network once its listeners are up:

| Service | When | Port |
|---|---|---|
| `_mqtt._tcp` | always | the MQTT port |
| `_secure-mqtt._tcp` | TLS is configured | the TLS port |
| `_mqtt-ws._tcp` | the WebSocket listener is on | the WebSocket port |

The text of each announcement holds `product`, `version`, `tls` and `auth` (`1` or `0`), never a user, a topic or a key. `MQTT_MDNS_NAME` changes the name shown
(`hydra-umc-mqtt` by default). The announcement is withdrawn when the broker stops. A network that does not carry multicast leaves the broker running and the log says which service
could not be announced. The package `bonjour-service` does the work and is loaded only when `MQTT_MDNS=1`.

mDNS tells a client where the broker is, not whether it may connect: sign-in and the ACL decide that exactly as before.

## Home Assistant: the bridges appear by themselves

Off by default. `MQTT_HOME_ASSISTANT=1` makes the broker publish, once and retained, the configs that Home Assistant reads when a machine bridge publishes its health on
`hydra/bridges/<name>/health`: a connectivity sensor (on while the `state` of its `HealthReport` is `READY`) and a sensor with the state itself, grouped in one device
`HYDRA-UMC bridge <name>`. `MQTT_HOME_ASSISTANT_PREFIX` changes the discovery prefix (`homeassistant` by default). At most 64 bridges are announced, a bridge is announced once per run of the broker,
and an empty message (the way a retained message is cleared) announces nothing. The robots of the server are announced by the server itself, not by this broker.

A start with a switch that is neither `1` nor `0`, an invalid name or a prefix with wildcards stops with a message instead of running with the option silently off.

Nothing here has run against a real Home Assistant or on a real network with multicast: the checks use a real broker and real MQTT clients, and a simulated mDNS publisher.
