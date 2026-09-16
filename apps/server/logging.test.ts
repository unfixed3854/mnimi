import { describe, it, expect } from "vitest";
import { getLogger } from "./logging.ts";

describe("logging", () => {
  it("configures a logger that can log without throwing", () => {
    const logger = getLogger(["mnimi", "test"]);
    expect(() => logger.warn("test message")).not.toThrow();
  });
});
