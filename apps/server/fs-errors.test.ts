import { describe, expect, it } from "vitest";
import { hasFsErrorCode } from "./fs-errors.ts";

describe("hasFsErrorCode", () => {
  it("matches Node filesystem errors by code", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(hasFsErrorCode(error, "ENOENT")).toBe(true);
    expect(hasFsErrorCode(error, "ENOTDIR")).toBe(false);
  });

  it("rejects non-errors and errors without a code", () => {
    expect(hasFsErrorCode(new Error("plain"), "ENOENT")).toBe(false);
    expect(hasFsErrorCode("ENOENT", "ENOENT")).toBe(false);
  });
});
