import { createHash, createHmac, randomBytes } from "node:crypto";

export function createMasterSeed(): Uint8Array {
  return randomBytes(32);
}

export function seedCommitment(
  masterSeed: Uint8Array,
  tournamentId: string,
  rulesetVersion: string,
): string {
  return createHash("sha256")
    .update(masterSeed)
    .update("\0")
    .update(tournamentId)
    .update("\0")
    .update(rulesetVersion)
    .digest("hex");
}

export function deriveSeed(masterSeed: Uint8Array, domain: string): Uint8Array {
  return createHmac("sha256", masterSeed).update(domain).digest();
}

export class DeterministicRng {
  readonly #seed: Uint8Array;
  #counter = 0n;
  #buffer = Buffer.alloc(0);

  constructor(seed: Uint8Array) {
    if (seed.byteLength < 16) throw new Error("Deterministic RNG seed must be at least 128 bits");
    this.#seed = new Uint8Array(seed);
  }

  #refill(): void {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(this.#counter);
    this.#counter += 1n;
    this.#buffer = createHmac("sha256", this.#seed).update(counter).digest();
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("length must be a non-negative integer");
    const output = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      if (this.#buffer.length === 0) this.#refill();
      const take = Math.min(this.#buffer.length, length - offset);
      this.#buffer.copy(output, offset, 0, take);
      this.#buffer = this.#buffer.subarray(take);
      offset += take;
    }
    return output;
  }

  int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
      throw new Error("maxExclusive must be between 1 and 2^32");
    }
    const range = 0x1_0000_0000;
    const limit = Math.floor(range / maxExclusive) * maxExclusive;
    while (true) {
      const bytes = this.bytes(4);
      const value = Buffer.from(bytes).readUInt32BE(0);
      if (value < limit) return value % maxExclusive;
    }
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.int(index + 1);
      [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
    }
    return result;
  }
}
