import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { CompetitorIdentityService } from "./identity-service.js";

const FAMILY_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const MODEL_CONFIG_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-19T08:00:00.000Z");

function familyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FAMILY_ID,
    display_name: "Kimi K3",
    status: "ACTIVE",
    linked_model_config_count: "2",
    available_model_config_count: "1",
    revision_count: "7",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("competitor identity service", () => {
  it("returns a family summary without runtime configuration or credentials", async () => {
    const query = vi.fn(async () => ({ rows: [familyRow()], rowCount: 1 }));
    const service = new CompetitorIdentityService({ query } as unknown as Pool);

    const family = await service.getFamily(FAMILY_ID);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("where f.id = $1"), [FAMILY_ID]);
    expect(family).toEqual({
      id: FAMILY_ID,
      displayName: "Kimi K3",
      status: "ACTIVE",
      linkedModelConfigCount: 2,
      availableModelConfigCount: 1,
      revisionCount: 7,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(family).not.toHaveProperty("parameters");
    expect(family).not.toHaveProperty("baseUrl");
    expect(family).not.toHaveProperty("apiKey");
  });

  it("keeps the revision display-name snapshot separate from the current family name", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        revision_id: REVISION_ID,
        revision_number: 3,
        model_config_id: MODEL_CONFIG_ID,
        competitor_family_id: FAMILY_ID,
        competitor_display_name: "Kimi k1.5",
        current_family_display_name: "Kimi K3",
        family_status: "ACTIVE",
        is_current_revision: false,
        model_config_archived: false,
        created_at: NOW,
        encrypted_api_key: "must-not-leak",
        parameters: { reasoning_effort: "high" },
      }],
      rowCount: 1,
    }));
    const service = new CompetitorIdentityService({ query } as unknown as Pool);

    const revision = await service.getRevisionIdentity(REVISION_ID);

    expect(revision).toEqual({
      revisionId: REVISION_ID,
      revisionNumber: 3,
      modelConfigId: MODEL_CONFIG_ID,
      familyId: FAMILY_ID,
      displayNameAtRevision: "Kimi k1.5",
      currentFamilyDisplayName: "Kimi K3",
      familyStatus: "ACTIVE",
      isCurrentRevision: false,
      modelConfigArchived: false,
      createdAt: NOW.toISOString(),
    });
    expect(revision).not.toHaveProperty("parameters");
    expect(revision).not.toHaveProperty("encryptedApiKey");
  });

  it("renames only the live family record and does not rewrite revision snapshots", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("update competitor_families")) {
        return { rows: [{ id: FAMILY_ID }], rowCount: 1 };
      }
      if (sql.includes("from competitor_families f")) {
        return { rows: [familyRow({ display_name: "Moonshot Kimi" })], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new CompetitorIdentityService({ query } as unknown as Pool);

    const family = await service.renameFamily(FAMILY_ID, "  Moonshot Kimi  ");

    expect(family?.displayName).toBe("Moonshot Kimi");
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set display_name = $2"),
      [FAMILY_ID, "Moonshot Kimi"],
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("update competitor_revisions")))
      .toBe(false);
  });

  it("uses retirement instead of exposing a destructive delete operation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("update competitor_families")) {
        return { rows: [{ id: FAMILY_ID }], rowCount: 1 };
      }
      return { rows: [familyRow({ status: "RETIRED" })], rowCount: 1 };
    });
    const service = new CompetitorIdentityService({ query } as unknown as Pool);

    const family = await service.setFamilyStatus(FAMILY_ID, "RETIRED");

    expect(family?.status).toBe("RETIRED");
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set status = $2"),
      [FAMILY_ID, "RETIRED"],
    );
    expect("deleteFamily" in service).toBe(false);
  });

  it("rejects blank or excessively long public names", async () => {
    const query = vi.fn();
    const service = new CompetitorIdentityService({ query } as unknown as Pool);

    await expect(service.createFamily("   ")).rejects.toThrow(
      "Competitor family display name must contain 1 to 120 characters",
    );
    await expect(service.renameFamily(FAMILY_ID, "x".repeat(121))).rejects.toThrow(
      "Competitor family display name must contain 1 to 120 characters",
    );
    expect(query).not.toHaveBeenCalled();
  });
});
