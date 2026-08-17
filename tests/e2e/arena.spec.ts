import { expect, test, type Page } from "@playwright/test";

const completedId = "11111111-1111-4111-8111-111111111111";
const cancelledId = "22222222-2222-4222-8222-222222222222";

function state(tournamentId: string, name: string, status: "COMPLETED" | "CANCELLED") {
  return {
    tournamentId,
    name,
    rulesetVersion: "holdem-tournament-v1",
    protocolBundleId: "arena-decision-v3",
    promptHash: "a".repeat(64),
    status,
    completedHands: 1,
    championPlayerId: "alpha",
    seedCommitment: "b".repeat(64),
    seedRevealed: true,
    players: [
      { id: "alpha", displayName: "Alpha", seat: 0, stack: 200, status: "CHAMPION", finishingPosition: 1, folded: false, allIn: false, streetCommitted: 0, totalCommitted: 0 },
      { id: "beta", displayName: "Beta", seat: 1, stack: 0, status: "ELIMINATED", finishingPosition: 2, folded: false, allIn: false, streetCommitted: 0, totalCommitted: 0 },
    ],
    hand: null,
  };
}

const completedState = state(completedId, "Completed fixture", "COMPLETED");
const cancelledState = state(cancelledId, "Cancelled fixture", "CANCELLED");
const summaries = [completedState, cancelledState].map((publicState, index) => ({
  id: publicState.tournamentId,
  name: publicState.name,
  status: publicState.status,
  rulesetVersion: publicState.rulesetVersion,
  promptHash: publicState.promptHash,
  championPlayerId: publicState.championPlayerId,
  publicState,
  createdAt: new Date(Date.UTC(2026, 7, 17 - index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 7, 17 - index)).toISOString(),
}));

async function mockArenaApi(page: Page) {
  let replayRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/session") return json({ session: null, csrfToken: null });
    if (path === "/api/public/tournaments") return json({ tournaments: summaries });
    const id = path.includes(cancelledId) ? cancelledId : completedId;
    const selectedState = id === cancelledId ? cancelledState : completedState;
    if (path.endsWith("/broadcast-replay")) {
      replayRequests += 1;
      return json({ state: selectedState, timeline: [], events: [], playerBrands: {} });
    }
    if (path.endsWith("/broadcast")) return json({ state: selectedState, broadcast: null, timeline: [], playerBrands: {} });
    if (path.endsWith("/stack-history")) return json({ points: [{ handNo: 1, stacks: { alpha: 200, beta: 0 } }] });
    if (path.endsWith("/statistics")) return json({ error: "fixture_not_required" }, 503);
    if (/\/hands\/\d+\/replay$/.test(path)) return json({ events: [], decisions: [], decisionAuditAvailable: true });
    if (path.endsWith("/hands")) return json({ hands: [{ handNo: 1, eventCount: 0, completed: true }] });
    if (path === `/api/public/tournaments/${id}`) return json({ state: selectedState });
    return json({ error: "fixture_not_found" }, 404);
  });
  return { replayRequests: () => replayRequests };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("arena-locale", "zh-CN");
    window.localStorage.setItem("arena-theme", "dark");
  });
});

test("public watch room and local admin login load", async ({ page }) => {
  await mockArenaApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Completed fixture" })).toBeVisible();
  await expect(page.getByRole("link", { name: "观赛室", exact: true })).toBeVisible();

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "身份验证" })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入控制室" })).toBeVisible();
});

test("switching a finished tournament does not start replay", async ({ page }) => {
  const api = await mockArenaApi(page);
  await page.goto("/");
  await page.getByRole("combobox", { name: "切换观赛赛事" }).click();
  await page.getByRole("option", { name: /Cancelled fixture/ }).click();

  await expect(page).toHaveURL(new RegExp(`tournament=${cancelledId}`));
  await expect(page.getByRole("heading", { name: "Cancelled fixture" })).toBeVisible();
  await expect(page.getByRole("button", { name: "回放" })).toBeVisible();
  expect(api.replayRequests()).toBe(0);
});

test("a late response from the previous tournament cannot replace the new selection", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/public/tournaments") return json({ tournaments: summaries });
    if (path === `/api/public/tournaments/${completedId}/broadcast`) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return json({ state: completedState, broadcast: null, timeline: [], playerBrands: {} });
    }
    if (path === `/api/public/tournaments/${cancelledId}/broadcast`) {
      return json({ state: cancelledState, broadcast: null, timeline: [], playerBrands: {} });
    }
    return json({ error: "fixture_not_found" });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(80);
  await page.evaluate((tournamentId) => {
    window.history.pushState({}, "", `/?tournament=${tournamentId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, cancelledId);

  await expect(page.getByRole("heading", { name: "Cancelled fixture" })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByRole("heading", { name: "Cancelled fixture" })).toBeVisible();
});

test("match analysis navigation starts at the top", async ({ page }) => {
  await mockArenaApi(page);
  await page.goto("/");
  await page.evaluate(() => {
    document.body.style.minHeight = "3000px";
    window.scrollTo(0, 1800);
  });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.getByRole("link", { name: /查看赛事解析/ }).click();
  await expect(page).toHaveURL(`/tournaments/${completedId}/replay`);
  await expect(page.getByRole("link", { name: "返回赛事列表" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("language and theme preferences update the document", async ({ page }) => {
  await mockArenaApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "切换为英文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "Watch Room", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
