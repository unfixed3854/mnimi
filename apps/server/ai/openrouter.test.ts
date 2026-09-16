import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getLogger } from "../logging.ts";
import {
  classifyReasoning,
  generateReasoning,
  imageModel,
} from "./openrouter.ts";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "none"];
const previousImageModel = process.env.IMAGE_MODEL;
const previousClassifyEffort = process.env.CLASSIFY_EFFORT;
const previousGenerateEffort = process.env.GENERATE_EFFORT;

describe("imageModel", () => {
  beforeEach(() => {
    delete process.env.IMAGE_MODEL;
  });

  afterEach(() => {
    if (previousImageModel === undefined) delete process.env.IMAGE_MODEL;
    else process.env.IMAGE_MODEL = previousImageModel;
  });

  it("returns the Flux default when IMAGE_MODEL is unset", () => {
    expect(imageModel()).toBe("black-forest-labs/flux.2-klein-4b");
  });

  it("returns an explicit IMAGE_MODEL override unchanged", () => {
    process.env.IMAGE_MODEL = "some/provider-model";
    expect(imageModel()).toBe("some/provider-model");
  });
});

describe("classifyReasoning", () => {
  beforeEach(() => {
    delete process.env.CLASSIFY_EFFORT;
  });

  afterEach(() => {
    if (previousClassifyEffort === undefined) {
      delete process.env.CLASSIFY_EFFORT;
    } else process.env.CLASSIFY_EFFORT = previousClassifyEffort;
  });

  it("returns undefined when CLASSIFY_EFFORT is unset", () => {
    expect(classifyReasoning()).toBeUndefined();
  });

  it("returns the effort for each valid value", () => {
    for (const value of EFFORTS) {
      process.env.CLASSIFY_EFFORT = value;
      expect(classifyReasoning()).toEqual({ effort: value });
    }
  });

  it("returns undefined and warns once for an invalid value", () => {
    const logger = getLogger(["mnimi", "ai"]);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.CLASSIFY_EFFORT = "extreme";

    expect(classifyReasoning()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe("generateReasoning", () => {
  beforeEach(() => {
    delete process.env.GENERATE_EFFORT;
  });

  afterEach(() => {
    if (previousGenerateEffort === undefined) {
      delete process.env.GENERATE_EFFORT;
    } else process.env.GENERATE_EFFORT = previousGenerateEffort;
  });

  it("returns undefined when GENERATE_EFFORT is unset", () => {
    expect(generateReasoning()).toBeUndefined();
  });

  it("returns the effort for a valid value", () => {
    process.env.GENERATE_EFFORT = "high";
    expect(generateReasoning()).toEqual({ effort: "high" });
  });

  it("returns undefined and warns once for an invalid value", () => {
    const logger = getLogger(["mnimi", "ai"]);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.GENERATE_EFFORT = "extreme";

    expect(generateReasoning()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
