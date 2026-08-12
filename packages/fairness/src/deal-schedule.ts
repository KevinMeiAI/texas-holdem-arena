import { createHash, randomBytes } from "node:crypto";
import { deriveSeed } from "./rng.js";

export const DEAL_SCHEDULE_VERSION = "arena-deal-schedule-v1";
export const SEAT_ROTATION_POLICY_VERSION = "arena-seat-rotation-v1";

export interface DealSchedule {
  version: typeof DEAL_SCHEDULE_VERSION;
  id: string;
  seedBase64: string;
  commitment: string;
}

function dealScheduleCommitment(version: string, seedBase64: string): string {
  return createHash("sha256")
    .update(`arena:deal-schedule-commitment:${version}:${seedBase64}`)
    .digest("hex");
}

export function createDealSchedule(seed: Uint8Array = randomBytes(32)): DealSchedule {
  if (seed.byteLength !== 32) throw new Error("Deal schedule seed must be 256 bits");
  const seedBase64 = Buffer.from(seed).toString("base64");
  return {
    version: DEAL_SCHEDULE_VERSION,
    id: createHash("sha256")
      .update(`arena:deal-schedule:${DEAL_SCHEDULE_VERSION}:${seedBase64}`)
      .digest("hex")
      .slice(0, 24),
    seedBase64,
    commitment: dealScheduleCommitment(DEAL_SCHEDULE_VERSION, seedBase64),
  };
}

export function scheduledHandSeed(schedule: DealSchedule, handNo: number): Uint8Array {
  if (schedule.version !== DEAL_SCHEDULE_VERSION) {
    throw new Error(`Unsupported deal schedule version: ${String(schedule.version)}`);
  }
  if (!Number.isSafeInteger(handNo) || handNo < 1) throw new Error("Scheduled hand number must be positive");
  return deriveSeed(
    Buffer.from(schedule.seedBase64, "base64"),
    `${schedule.version}:${schedule.id}:hand:${handNo}`,
  );
}

export function verifyDealSchedule(schedule: DealSchedule): boolean {
  if (schedule.version !== DEAL_SCHEDULE_VERSION) return false;
  const seed = Buffer.from(schedule.seedBase64, "base64");
  if (seed.byteLength !== 32 || seed.toString("base64") !== schedule.seedBase64) return false;
  const expected = createDealSchedule(seed);
  return expected.id === schedule.id && expected.commitment === schedule.commitment;
}

export function rotateSeats<T>(
  entries: readonly T[],
  rotation: number,
  policyVersion = SEAT_ROTATION_POLICY_VERSION,
): T[] {
  if (policyVersion !== SEAT_ROTATION_POLICY_VERSION) {
    throw new Error(`Unsupported seat rotation policy: ${policyVersion}`);
  }
  if (entries.length < 2 || entries.length > 9) throw new Error("Seat rotations require 2-9 entries");
  if (!Number.isSafeInteger(rotation) || rotation < 0) throw new Error("Seat rotation must be non-negative");
  const offset = rotation % entries.length;
  return [...entries.slice(offset), ...entries.slice(0, offset)];
}
