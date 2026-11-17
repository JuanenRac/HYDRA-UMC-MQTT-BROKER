// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/log-id.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A client id or a topic is written to the log without control characters, so a client cannot forge a log line with a line break in its id.
// =============================================================================

import { describe, expect, it } from "vitest";
import { safeLogId } from "../src/security.js";

const at = (code: number): string => String.fromCharCode(code);
const LF = at(10);
const CR = at(13);
const TAB = at(9);
const ESC = at(27);
const LINE_SEPARATOR = at(0x2028);
const NEXT_LINE = at(0x85);
const DELETE = at(0x7f);

describe("safeLogId", () => {
  it("leaves a plain id as it is", () => {
    expect(safeLogId("bridge-cnc-1")).toBe("bridge-cnc-1");
    expect(safeLogId("hydra/bridges/cnc-1/health")).toBe("hydra/bridges/cnc-1/health");
    const accented = "sensor " + at(0xf1) + " " + at(0x6e29) + at(0x5ea6);
    expect(safeLogId(accented)).toBe(accented);
  });

  it("turns a line break, an escape and the other control characters into a visible mark", () => {
    expect(safeLogId("a" + LF + "b")).toBe("a?b");
    expect(safeLogId("x" + CR + LF + "[HYDRA-UMC-MQTT-BROKER] client connected: root")).toBe("x??[HYDRA-UMC-MQTT-BROKER] client connected: root");
    expect(safeLogId(ESC + "[31mred")).toBe("?[31mred");
    expect(safeLogId("tab" + TAB + "here")).toBe("tab?here");
    expect(safeLogId("a" + LINE_SEPARATOR + "b" + NEXT_LINE + "c" + DELETE + "d")).toBe("a?b?c?d");
  });

  it("cuts a long id and says it", () => {
    const long = "a".repeat(300);
    expect(safeLogId(long)).toBe("a".repeat(128) + "...");
    expect(safeLogId(long, 10)).toBe("aaaaaaaaaa...");
    expect(safeLogId("a".repeat(128))).toHaveLength(128);
  });

  it("takes what is not text", () => {
    expect(safeLogId(undefined)).toBe("");
    expect(safeLogId(null)).toBe("");
    expect(safeLogId(42)).toBe("42");
  });
});
