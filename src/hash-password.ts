// =============================================================================
// HYDRA-UMC-MQTT-BROKER - Writes the hashed form of a password for MQTT_AUTH_JSON: src/hash-password.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The password is read from the standard input (one line) or from the environment variable
// MQTT_PASSWORD_TO_HASH, never from the command line, where it would show in the process list and the
// shell history. The printed value goes in the "password" field of an MQTT_AUTH_JSON credential.
// =============================================================================

import { createInterface } from "node:readline";
import { hashPassword } from "./auth.js";

async function readPassword(): Promise<string> {
  const fromEnv = process.env.MQTT_PASSWORD_TO_HASH;
  if (fromEnv) return fromEnv;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    lines.close();
    return line.replace(/\r$/, "");
  }
  return "";
}

const password = await readPassword();
if (password.length < 12) {
  console.error("[HYDRA-UMC-MQTT-BROKER] give a password of at least 12 characters on the standard input (or in MQTT_PASSWORD_TO_HASH)");
  process.exit(1);
}
console.log(hashPassword(password));
