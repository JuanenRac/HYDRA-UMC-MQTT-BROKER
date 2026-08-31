<!-- =============================================================================
HYDRA-UMC-MQTT-BROKER - External machine bridge topic catalog
Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0 - see LICENSE
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

Never streams a G-code program - LinuxCNC or the native controller keeps
all real-time trajectory, limits, spindle and safety authority.

### `hydra/bridges/laser/*`

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `state` | bridge -> broker, retained | `LaserSafetySnapshot` + `machine_state` | - |
| `cmd/status` | -> bridge | (empty) | re-read the 3 real GPIO safeguards (key/enclosure/interlock) |

No real actuation command exists here, on purpose: this bridge cannot
arm or fire a laser either way, and is deliberately controller-neutral
until a specific machine and safety interface are chosen.

### `hydra/bridges/openpnp/*`

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `cmd/handoff` | -> bridge | `{"job": <job_to_dict>, "identity": {"board_id","recipe_id","revision","lot_id"}}` | a full traceable, always `mode: "simulation-only"` hand-off |

No `state` topic here - there is no real machine transport in this
bridge to observe. `cmd/handoff`'s own result is always tagged
`mode: "simulation-only"`, never machine proof; see
`HYDRA-UMC-BRIDGE-OPENPNP`'s own `docs/HANDOFF_EVIDENCE.md`.

### `hydra/bridges/printer3d/*` (Moonraker/Klipper)

| Topic | Direction | Payload | Real command |
|---|---|---|---|
| `state` | bridge -> broker, retained | `PrinterStatus` | - |
| `cmd/status` | -> bridge | (empty) | re-fetch real Moonraker readiness |
| `cmd/start` | -> bridge | `{"job": <job_to_dict>, "filename": "part.gcode"}` | `POST /printer/print/start` |
| `cmd/pause` | -> bridge | (empty) | `POST /printer/print/pause`, always allowed |
| `cmd/resume` | -> bridge | (empty) | `POST /printer/print/resume`, only from `HOLDING` |
| `cmd/cancel` | -> bridge | (empty) | `POST /printer/print/cancel`, always allowed |

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
each bridge's own `run_forever()` default `client_id`), so `src/acl.ts`
can scope every bridge to publish only inside its own
`hydra/bridges/<name>/#` and subscribe only to its own `hydra/bridges/
<name>/cmd/#` - see `.env.example`'s own `MQTT_ACL_JSON` for a real
example covering all five.
