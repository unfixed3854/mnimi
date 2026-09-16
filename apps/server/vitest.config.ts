import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { DATABASE_URL: "file::memory:" },
    include: ["**/*.test.ts"],
  },
});
