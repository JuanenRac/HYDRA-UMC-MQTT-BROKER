// =============================================================================
// HYDRA-UMC-MQTT-BROKER - vitest.config.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The tests open real sockets and WebSocket upgrades; on a loaded CI runner a few of them need more than the default 5 seconds, so the timeouts are generous and a test that
// fails only because of a late socket gets one more try.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    retry: 2,
  },
});
