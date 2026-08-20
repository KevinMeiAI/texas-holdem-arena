import { describe, expect, it } from "vitest";
import { uiLocaleFromSearch, urlWithUiLocale } from "./ui-preferences";

describe("URL-backed UI locale", () => {
  it("lets an explicit share-link locale take precedence", () => {
    expect(uiLocaleFromSearch("?lang=en")).toBe("en");
    expect(uiLocaleFromSearch("?tag=ALL_IN&lang=zh-CN")).toBe("zh-CN");
    expect(uiLocaleFromSearch("?lang=unknown")).toBeNull();
  });

  it("uses a compact English query and the query-free Chinese default", () => {
    expect(urlWithUiLocale("https://arena.example.com/moments/final?tag=all#table", "en"))
      .toBe("/moments/final?tag=all&lang=en#table");
    expect(urlWithUiLocale("https://arena.example.com/moments/final?tag=all&lang=en#table", "zh-CN"))
      .toBe("/moments/final?tag=all#table");
  });
});
