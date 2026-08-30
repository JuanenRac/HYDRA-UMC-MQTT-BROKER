# Changelog

All notable public work on **HYDRA-UMC-MQTT-BROKER** is summarized here,
newest first. This changelog intentionally omits calendar dates and internal
work-session detail.

## Versioning scheme

`scripts/bump-version.mjs` bumps `package.json`'s `version` field
automatically as the first step of every real `npm run build` (same
mechanism HYDRA-UMC-SERVER/HYDRA-UMC-STUDIO already use) - no manual
version edits, no build that silently ships under the previous number.

It follows the ecosystem-wide base-10 "odometer" rule rather than
semantic-versioning judgment calls:

- `PATCH` +1 on every build
- when `PATCH` would exceed 9, it resets to 0 and `MINOR` +1 instead (e.g. `0.0.9` -> `0.1.0`, never `0.0.10`)
- the same carry cascades into `MAJOR` if `MINOR` would exceed 9

---

## Unreleased - Opt-in authenticated MQTT sessions

- **`src/auth.ts`** (new) - validates the `MQTT_AUTH_JSON` credential list,
  rejects blank or duplicate user names at startup, and verifies matching
  password buffers with Node's constant-time comparison primitive. Secrets
  are never written to logs or errors.
- **`src/server.ts`** - `buildBroker()` now accepts optional credentials and
  rejects unauthenticated MQTT CONNECT attempts with the standard bad
  username/password CONNACK outcome. Authentication remains opt-in so an
  existing local broker stays compatible until explicitly configured.
- **`.env.example`** documents secure deployment of `MQTT_AUTH_JSON` and why
  authenticated identity must be paired with the topic ACL.

## [0.0.6] - Validate programmatic listener port and payload limits

- **`buildBroker()`** - validated its own `port` (integer, 0..65535) and
  `options.maxPayloadBytes` (positive safe integer) arguments before opening
  the broker, matching the existing environment-variable validation path -
  a caller embedding this broker programmatically got the same guarantees
  as the CLI/env-driven path already had.
- 51/51 tests passing.

## [0.0.5] - Real ecosystem live-status opt-in

- **`hydra-umc.project.json`** declares its real `service.port` (1883,
  the default MQTT/TCP listen port) - HYDRA-UMC-SERVER's ecosystem
  status endpoint now does a real TCP-connect probe against it instead
  of only reporting static manifest metadata. No `health_path` (this is
  a raw MQTT/TCP protocol, not HTTP), so the probe is a bare connect.

## [0.0.4] - Fixed after a live ecosystem bug audit

- **`src/acl.ts`** - removed a dead source-comment reference. No functional
  change - the surrounding security limitation remains self-contained.

## [0.0.3] - Real, verifiable topic ACL and payload size limit

- **`src/acl.ts`** (new) - real, verifiable per-client-ID-prefix topic ACL. `topicMatchesFilter()` is a real MQTT wildcard matcher (`+`/`#`) for a concrete PUBLISH topic. `isSubscriptionWithinScope()` is the check the promotion audit specifically asked for: a client's own SUBSCRIBE request is itself a filter that can carry `+`/`#`, so a segment-by-segment scope check proves a requested filter (e.g. `hydra/robots/#`) can never match more than an allow-rule (e.g. `hydra/robots/+/status`) actually granted - a naive "does it overlap" check would have let a client escalate its own subscription into someone else's topics. `isPublishAllowed()`/`isSubscribeAllowed()` are real default-deny: a client with no matching rule, or a rule that doesn't list the exact topic, is denied.
- **`buildBroker(port, options)`** (`src/server.ts`) gained an optional `{ acl, maxPayloadBytes }` - both fully opt-in, unset means every pre-existing behavior (open access, unlimited payload) is unchanged. When set, `authorizePublish`/`authorizeSubscribe` hooks enforce them against Aedes for real.
- **`MQTT_ACL_JSON`/`MAX_PAYLOAD_BYTES`** (new env vars, `main()`) - real production config, not just a library option only tests exercise. `parseAclConfig()` validates the JSON shape and fails startup loudly (not silently) on malformed config.
- 22 new tests: `tests/acl.test.ts` (20, pure unit tests of the matching/scope/config-parsing logic) + `tests/acl-broker.test.ts` (9, real `mqtt` client against a real Aedes broker - a robot publishing/subscribing within its granted scope succeeds; a robot attempting a topic its rule never granted, an ID matching no rule at all, or an oversized payload all get real behavior verified, not assumed: **Aedes closes the whole connection** on a denied PUBLISH rather than NACKing just that message - found by running the test against the real broker, not by reading the docs; a denied SUBSCRIBE instead returns SUBACK reason 128, which this MQTT.js client surfaces as a real error) = 39 total, all passing.
- Real verification beyond the test suite: built the actual `dist/server.cjs`, ran it with real `MQTT_ACL_JSON`/`MAX_PAYLOAD_BYTES` env vars, and connected real `mqtt` clients over a real socket - a robot publishing its own status succeeded, the same robot ID publishing to an ungranted topic got disconnected, and an oversized payload got disconnected too.
- `.env.example` documents both new variables.

## [0.0.2] - Fixed a real bug: the broker never actually accepted clients

- **Real bug found and fixed**: Aedes 1.x moved persistence/mqemitter setup into an explicit async `broker.listen()` step (a real API change from the 0.x factory-function shape the original scaffold was written against). Without it, every real MQTT `CONNECT` reached the broker over a real TCP socket but silently hung until the client's own connack timeout fired - the broker looked "up" (the TCP port accepted connections) but no client could actually complete a session. Found via a real `mqtt` client timing out in this project's own tests, not by inspection - `mqtt_probe.mjs`/`mqtt_probe2.mjs` diagnostic scripts isolated it down to a missing `await broker.listen()` before the TCP listener starts.
- **`src/server.ts`** refactored: broker construction now lives in an exported, async `buildBroker(port)` (awaits the real `broker.listen()` fix above) so tests can start a real broker on a test port without going through `main()`.
- **`tests/server.test.ts`** - 4 real tests using the `mqtt` npm package (a real client, not a mock) against a real Aedes broker over a real TCP socket: CONNECT succeeds, a real PUBLISH is delivered to a real SUBSCRIBEd client, a client subscribed to a different topic does not receive it, and a real retained message is delivered to a client that subscribes afterward. These are exactly the tests that would have caught the `listen()` bug above had they existed sooner.
- **`src/version.ts`** - added for consistency with the rest of the family (not yet wired into a broker-reported version string, since Aedes doesn't expose one in its own protocol responses the way OPC-UA's `buildInfo` or MTConnect's XML header do).
- **`build.sh`/`build.bat`** - now run the real test suite (`npm test`, vitest) as a required step before compiling; a failing test fails the build.

## [0.0.1] - Automatic version bump on build

- Added `scripts/bump-version.mjs` (copied/adapted from HYDRA-UMC-SERVER's
  own) and wired it into `package.json`'s `build` script - this project
  no longer relies on a manual version edit before each real build, like
  every other Node project in the ecosystem.

## [0.0.0] - Initial scaffolding

- **`src/server.ts`** - minimal real entry point. No broker logic yet - a real MQTT broker bridging this cell's own event stream lands in a later pass.
- **`package.json`** - project metadata, no runtime dependencies yet.
- **`build.sh` / `build.bat`** - `npm install && npm run build`.
- **`dev.sh` / `dev.bat`** - run against source directly (no build step) for local development.
