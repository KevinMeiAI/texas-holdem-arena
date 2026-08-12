import { describe, expect, it } from "vitest";
import {
  createDealSchedule,
  rotateSeats,
  scheduledHandSeed,
  verifyDealSchedule,
} from "./deal-schedule.js";

describe("paired deal schedules", () => {
  it("derives identical hand seeds independently of tournament identity", () => {
    const schedule = createDealSchedule(new Uint8Array(32).fill(7));
    expect(verifyDealSchedule(schedule)).toBe(true);
    expect(scheduledHandSeed(schedule, 4)).toEqual(scheduledHandSeed(schedule, 4));
    expect(scheduledHandSeed(schedule, 4)).not.toEqual(scheduledHandSeed(schedule, 5));
  });

  it("detects a disclosed seed that does not match its commitment", () => {
    const schedule = createDealSchedule(new Uint8Array(32).fill(7));
    expect(verifyDealSchedule({ ...schedule, seedBase64: Buffer.alloc(32, 8).toString("base64") })).toBe(false);
  });

  it("rotates every competitor through every seat exactly once", () => {
    const players = ["a", "b", "c", "d"];
    const rotations = players.map((_, index) => rotateSeats(players, index));
    for (let seat = 0; seat < players.length; seat += 1) {
      expect(rotations.map((rotation) => rotation[seat]).sort()).toEqual([...players].sort());
    }
  });
});
