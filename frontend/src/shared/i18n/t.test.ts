import { describe, it, expect } from "vitest";
import { t } from "./t";

describe("t (i18n seam, CC.4)", () => {
  it("returns the string unchanged until i18next is swapped in (identity)", () => {
    expect(t("Sign in")).toBe("Sign in");
    expect(t("Deploy")).toBe("Deploy");
    expect(t("")).toBe("");
  });
});
