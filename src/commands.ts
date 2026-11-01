// =============================================================================
// HYDRA-UMC MQTT BROKER - src/commands.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Opt-in check on the command topics of the bridges: a PUBLISH to
// hydra/bridges/<name>/cmd/job must carry the envelope of a signed command
// (issued_at_ms, expires_in_ms, signature) and must be current and not
// retained. The broker does NOT verify the signature: the key is shared by
// the sender and the bridge only, and the bridge (hydra_umc_sdk.signed_commands)
// is the single place that checks it. This is the cheap first filter in front
// of it - an unsigned, expired, future-dated, over-long-lived or retained
// command never reaches a bridge, and a command that is replayed late by the
// network is stopped at the door.
// =============================================================================

export interface CommandEnvelopeOptions {
  /** How far in the future (milliseconds) a command may have been issued, for a sender whose clock is a little ahead. Omitted means 5000. */
  maxClockSkewMs?: number;
  /** The longest validity (milliseconds) a command may ask for. Omitted means 300000. */
  maxExpiresInMs?: number;
}

export const DEFAULT_COMMAND_MAX_CLOCK_SKEW_MS = 5_000;
export const DEFAULT_COMMAND_MAX_EXPIRES_IN_MS = 300_000;

const COMMAND_JOB_TOPIC = /^hydra\/bridges\/[^/+#]+\/cmd\/job$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

/** Whether `topic` is the job command topic of a bridge (the topic the envelope is asked for). */
export function isCommandJobTopic(topic: string): boolean {
  return COMMAND_JOB_TOPIC.test(topic);
}

export function validateCommandEnvelopeOptions(options: CommandEnvelopeOptions): void {
  for (const [name, value] of [
    ["commandEnvelope.maxClockSkewMs", options.maxClockSkewMs],
    ["commandEnvelope.maxExpiresInMs", options.maxExpiresInMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || (name.endsWith("maxExpiresInMs") && value === 0))) {
      throw new RangeError(`${name} must be a whole number of milliseconds (the expiry above zero)`);
    }
  }
}

/**
 * Why a PUBLISH to a job command topic must be refused, or `null` when it may go on to the bridge. Anything that is not
 * a job command topic is not judged here.
 */
export function commandEnvelopeProblem(
  topic: string,
  retain: boolean,
  payload: Buffer | string,
  nowMs: number,
  options: CommandEnvelopeOptions,
): string | null {
  if (!isCommandJobTopic(topic)) return null;
  if (retain) return "a command must not be retained: the broker would replay it at every reconnect";
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : payload);
  } catch {
    return "the command is not JSON";
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return "the command is not a JSON object";
  const body = decoded as Record<string, unknown>;
  const { issued_at_ms: issued, expires_in_ms: expires, signature } = body;
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return "the command is not signed (a signature of 64 lowercase hexadecimal digits is needed)";
  if (!Number.isSafeInteger(issued) || (issued as number) < 0 || !Number.isSafeInteger(expires) || (expires as number) <= 0) {
    return "the command needs issued_at_ms and expires_in_ms, whole numbers of milliseconds";
  }
  const skew = options.maxClockSkewMs ?? DEFAULT_COMMAND_MAX_CLOCK_SKEW_MS;
  const longest = options.maxExpiresInMs ?? DEFAULT_COMMAND_MAX_EXPIRES_IN_MS;
  if ((expires as number) > longest) return `the command asks to stay valid for ${expires} ms; at most ${longest} ms is accepted`;
  if ((issued as number) > nowMs + skew) return "the command was issued in the future: the clock of the sender is off";
  if (nowMs > (issued as number) + (expires as number)) return "the command has expired";
  return null;
}
