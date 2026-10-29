<!-- =============================================================================
HYDRA-UMC-MQTT-BROKER - External machine bridge topic catalog
Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

# External Machine Bridge Topics

`HYDRA-UMC-BRIDGE-CNC`, `-LASER`, `-OPENPNP`, `-PRINTER3D` and `-ROS2`
each ship their own `mqtt_transport.py` reaching this broker - this
catalog documents the real, shared topic convention all five use, so a
dashboard, STUDIO panel or `mosquitto_sub` session can address any of
them without reading five separate repos. This document is the topic
catalog only; the safety authority and job contract itself is
`HYDRA-UMC-SDK`'s own `docs/BRIDGE_CONTRACT.md`.

## Convention

Every topic is namespaced `hydra/bridges/<name>/...`, `<name>` being
`cnc`, `laser`, `openpnp`, `printer3d` or `ros2`. Each bridge subscribes
to its own `hydra/bridges/<name>/cmd/#` (a wildcard) and answers every
command on a matching `hydra/bridges/<name>/cmd/<verb>/result` topic. An
unrecognised `cmd/` sub-topic is silently ignored by every bridge, never
an error - a future sibling topic a deployed bridge version doesn't know
about yet must never crash its message loop.

A `state` topic, where one exists, is always published **retained** -
so a client that subscribes after the last change still sees the
current state immediately, not only future updates.

Every bridge also announces itself on `hydra/bridges/<name>/availability`:
`online` (QoS 1, retained) once it is connected, and `offline` (the MQTT
will, also QoS 1 and retained) which the broker publishes if the bridge
dies. A dashboard should treat a `state` as stale when the bridge is
`offline`.

Nobody in this repository publishes the `cmd/` topics: a command comes
from whichever client (a dashboard, an orchestrator, `mosquitto_pub`)
the ACL lets publish there. A bridge never acts on a retained `cmd/`
message that the broker replays when it subscribes; it answers only
messages that were published live.

Bridges that watch their own safeguards also publish **events** on
`hydra/bridges/<name>/event/<kind>` at QoS 1, not retained (one message
per change, so a late subscriber does not replay old events).

`HYDRA-UMC-BRIDGE-AMR` (VDA 5050), `-UAV` (MAVLink) and `-DROIDS`
(a legged robot's own SDK) are not part of this catalog: the AMR bridge
publishes VDA 5050 topics (`<interface>/<major>/<manufacturer>/<serial>/
order|instantActions`, outside `hydra/bridges/`), and the other two do not
use MQTT commands. Give the AMR bridge's client id
(`hydra-umc-bridge-amr`) an ACL entry for the VDA 5050 topics of its AGVs.

## The shared job gate: `cmd/job`

All five bridges accept a `BridgeJob` (the shared SDK's `job_to_dict()`
wire shape - `hydra_umc_sdk.bridge_contract`) on `hydra/bridges/<name>/
cmd/job` and answer with a gate decision on `.../cmd/job/result`. This
is the exact same `evaluate_job()`-based safety gate every bridge's own
Python API already enforced before this transport existed - reachable
over MQTT now, granting no new physical authority.

```json
// hydra/bridges/cnc/cmd/job (PUBLISH)
{
  "job_id": "job-42",
  "idempotency_key": "job-42-v1",
  "source": "HYDRA-UMC-ORCHESTRATOR",
  "phase": "LOAD",
  "machine_state": "IDLE",
  "parameters": {}
}
```

```json
// hydra/bridges/cnc/cmd/job/result (bridge PUBLISH, response)
{"allowed": true, "reason": "cell and external machine are ready"}
```

A malformed `cmd/job` payload (bad JSON, a missing field, an unrecognised
`phase`/`machine_state`) always fails closed with `{"allowed": false,
"reason": "malformed job payload: ..."}` on the same result topic -
never a dropped message or a crashed bridge process.

## Per-bridge topics

Every real command below is one each bridge's own Python API already
implemented before this transport existed - MQTT only changes how it is
reached, never what it can do.

### `hydra/bridges/cnc/*` (GRBL)

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `state` | bridge -> broker, retained | `CncSnapshot` + `machine_state` | - |
| `cmd/status` | -> bridge | (empty) | re-query real GRBL status |
| `cmd/feed_hold` | -> bridge | (empty) | GRBL real-time feed hold (`!`) |
| `cmd/soft_reset` | -> bridge | (empty) | GRBL real-time soft reset (`Ctrl-X`) |
| `cmd/cycle_start_resume` | -> bridge | (empty) | GRBL real-time cycle start/resume (`~`), only from `HOLDING` |
| `mtconnect` | bridge -> broker, retained | MTConnect observations (`avail`, `execution`, `estop`, `door`, `spindle_speed`, `path_feedrate`, ...) | only when switched on with `HYDRA_UMC_CNC_MTCONNECT=1` |

Never streams a G-code program - LinuxCNC or the native controller keeps
all real-time trajectory, limits, spindle and safety authority.

### `hydra/bridges/laser/*`

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `state` | bridge -> broker, retained | `LaserSafetySnapshot` + `machine_state` | - |
| `cmd/status` | -> bridge | (empty) | re-read the 3 real GPIO safeguards (key/enclosure/interlock) |
| `event/safety` | bridge -> broker, QoS 1, not retained | one record per safeguard that changed | - |
| `event/interlock_open` | bridge -> broker, QoS 1, not retained | the cell went from safe to unsafe | - |

`state` also carries `auxiliary` (extraction, assist air, temperature
checks, when declared) and `laser_power` / `feed_rate` when the
controller state comes from a GRBL reader.

No real actuation command exists here, on purpose: this bridge cannot
arm or fire a laser either way, and is deliberately controller-neutral
until a specific machine and safety interface are chosen.

### `hydra/bridges/openpnp/*`

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `cmd/job` | -> bridge | `BridgeJob` with `parameters.board_id` set | the shared board-flow gate |
| `cmd/handoff` | -> bridge | `{"job": <job_to_dict>, "identity": {"board_id","recipe_id","revision","lot_id"} }`; `slot_id`, `rack_id` and `table_id` are optional identity fields | a full traceable, always `mode: "simulation-only"` hand-off |
| `cmd/status` | -> bridge | (empty) | read the state file written by the OpenPnP event scripts and publish `state` (only with a state source) |
| `state` | bridge -> broker, retained | the machine state OpenPnP last reported, with `observed`, `event`, `job`, `observed_at` | only with a state source |
| `cmd/smema_status` | -> bridge | (empty) | read the SMEMA lines and publish `smema` (only with a receiver or a sender) |
| `cmd/smema_ready` | -> bridge | `{"ready": bool, "fixture_empty": bool}` | tell the upstream machine that the cell can take a board (the shared gate decides) |
| `cmd/smema_offer` | -> bridge | `{"available": bool, "board_staged": bool}` | tell the downstream machine that a finished board can leave (the shared gate decides) |
| `smema` | bridge -> broker, retained | what the neighbours assert and what the cell asserts | - |
| `event/board` | bridge -> broker, QoS 1, not retained | the trace of a board when its cycle ends | only with a trace recorder |

Without a state source there is no `state` topic: a bridge that has no
real machine transport to observe does not invent one. `cmd/handoff`'s
own result is always tagged `mode: "simulation-only"`, never machine
proof; see `HYDRA-UMC-BRIDGE-OPENPNP`'s own `docs/HANDOFF_EVIDENCE.md`.

### `hydra/bridges/printer3d/*` (Moonraker/Klipper)

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `state` | bridge -> broker, retained | `PrinterStatus` | - |
| `cmd/status` | -> bridge | (empty) | re-fetch real Moonraker readiness |
| `cmd/start` | -> bridge | `{"job": <job_to_dict>, "filename": "part.gcode"}` | `POST /printer/print/start` |
| `cmd/pause` | -> bridge | (empty) | `POST /printer/print/pause`, always allowed |
| `cmd/resume` | -> bridge | (empty) | `POST /printer/print/resume`, only from `HOLDING` |
| `cmd/cancel` | -> bridge | (empty) | `POST /printer/print/cancel`, always allowed |
| `cmd/emergency_stop` | -> bridge | (empty) | Klipper `M112`, the hard stop, always allowed |

Only ever references an already-uploaded, already-sliced file by name -
never streams raw G-code, never touches firmware, heaters or motion
directly.

### `hydra/bridges/ros2/*`

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `state` | bridge -> broker, retained | `{"state": "..."}`, republished from the real ROS 2 `state_topic` | - |
| `cmd/safe_stop` | -> bridge | (empty) | real `std_srvs/Trigger` call on `/hydra_umc/request_safe_stop` |

`cmd/job` here answers `Ros2Dispatch` (`accepted`/`interface`/`reason`/
`mode: "plan-only"`), naming which real ROS 2 interface a phase maps to
without a ROS 2 install being required to ask. `inspect_service`/
`job_action` have no command topic yet - no real, honest ROS 2 message/
action type exists for them today; see `HYDRA-UMC-BRIDGE-ROS2`'s own
`docs/BRIDGE_GUIDE.md`.

## ACL

Each bridge connects with a distinct MQTT client ID prefix
(`hydra-umc-bridge-cnc`, `-laser`, `-openpnp`, `-printer3d`, `-ros2` -
each bridge's own `run_forever()` default `client_id`; the broker accepts
client IDs of up to 128 characters, also at MQTT 3.1, so the longer ones such
as `hydra-umc-bridge-printer3d` connect), so `src/acl.ts`
can scope every bridge to publish only inside its own
`hydra/bridges/<name>/#` and subscribe only to its own `hydra/bridges/
<name>/cmd/#` - see `.env.example`'s own `MQTT_ACL_JSON` for a real
example covering all five.
