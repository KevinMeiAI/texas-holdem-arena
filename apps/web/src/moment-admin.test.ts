import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { momentMutationError } from "./moment-admin";

describe("moment admin errors", () => {
  it("explains an unsafe suspense cover in both supported locales", () => {
    const error = new ApiError(
      409,
      "moment_suspense_cover_unsafe",
      "The selected suspense cover reveals the hand result",
    );

    expect(momentMutationError(error, "zh-CN"))
      .toBe("这个封面已经透露牌局结果，请选择河牌发出或摊牌前的事件帧");
    expect(momentMutationError(error, "en"))
      .toBe("This cover reveals the result. Choose a frame before the river completes or showdown begins.");
  });
});
