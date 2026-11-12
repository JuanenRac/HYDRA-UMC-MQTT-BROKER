// =============================================================================
// HYDRA-UMC MQTT BROKER - tests/version.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The version shown at start is the one in package.json, and a package.json that is missing, damaged or has no version never stops the start.
// =============================================================================

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPackageVersion } from "../src/version.js";

const folders: string[] = [];

function inFolderWith(packageJson: string | undefined): void {
  const folder = mkdtempSync(path.join(tmpdir(), "mqtt-version-"));
  folders.push(folder);
  if (packageJson !== undefined) writeFileSync(path.join(folder, "package.json"), packageJson, "utf-8");
  vi.spyOn(process, "cwd").mockReturnValue(folder);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("readPackageVersion", () => {
  it("reads the version of the package.json next to the working directory", () => {
    inFolderWith(JSON.stringify({ name: "x", version: "1.2.3" }));
    expect(readPackageVersion()).toBe("1.2.3");
  });

  it.each([
    ["has no version", JSON.stringify({ name: "x" })],
    ["has an empty version", JSON.stringify({ version: "" })],
    ["is not JSON", "{broken"],
    ["is empty", ""],
  ])("falls back to 0.0.0 when the package.json %s", (_label, content) => {
    inFolderWith(content);
    expect(readPackageVersion()).toBe("0.0.0");
  });

  it("falls back to 0.0.0 when there is no package.json at all", () => {
    inFolderWith(undefined);
    expect(readPackageVersion()).toBe("0.0.0");
  });

  it("reads the real package.json of this repository when run from it", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
