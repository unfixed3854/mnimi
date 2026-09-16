import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  repositoryRoot,
  resolveDatabaseUrl,
  resolveRuntimePath,
} from "./runtime-paths.ts";

describe("runtime paths", () => {
  it("anchors relative storage paths at the repository root", () => {
    expect(resolveRuntimePath("./data/images")).toBe(
      join(repositoryRoot, "data/images"),
    );
    expect(isAbsolute(resolveRuntimePath("./data/images"))).toBe(true);
  });

  it("leaves absolute storage paths unchanged", () => {
    expect(resolveRuntimePath("/tmp/mnimi-images")).toBe("/tmp/mnimi-images");
  });

  it("normalizes only relative file database URLs", () => {
    expect(resolveDatabaseUrl("file:./data/mnimi.db")).toBe(
      `file:${join(repositoryRoot, "data/mnimi.db")}`,
    );
    expect(resolveDatabaseUrl("file::memory:")).toBe("file::memory:");
    expect(resolveDatabaseUrl("file:/tmp/mnimi.db")).toBe("file:/tmp/mnimi.db");
    expect(resolveDatabaseUrl("libsql://example.turso.io")).toBe(
      "libsql://example.turso.io",
    );
  });
});
