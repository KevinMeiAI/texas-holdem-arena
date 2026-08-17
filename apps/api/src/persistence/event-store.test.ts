import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgEventStore } from "./event-store.js";

describe("decision leases", () => {
  it("renews a lease only while the same worker still owns the decision", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const store = new PgEventStore({ query } as unknown as Pool, new Uint8Array(32));

    await expect(store.renewDecisionLease("decision-1", "worker-a", 210_000)).resolves.toBe(true);
    await expect(store.renewDecisionLease("decision-1", "worker-b", 210_000)).resolves.toBe(false);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("lease_expires_at"),
      ["decision-1", "worker-a", 210_000],
    );
  });
});
