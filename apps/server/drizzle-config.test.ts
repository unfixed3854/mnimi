import { expect, test } from "vitest";

test("Drizzle paths are package-local and honor the test database", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "file::memory:";

  try {
    const { default: config } = await import("./drizzle.config.ts");
    expect(config.schema).toBe("./db/schema.ts");
    expect(config.out).toBe("./drizzle");
    expect(config).toMatchObject({ dbCredentials: { url: "file::memory:" } });
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
