import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "bun:test";

const mobileRoot = resolve(import.meta.dir, "..");

test("resolves an Android adaptive launcher icon with its foreground asset", () => {
  const result = spawnSync(
    process.execPath,
    ["x", "expo", "config", "--type", "public", "--json"],
    {
    cwd: mobileRoot,
    encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);

  const config = JSON.parse(result.stdout) as {
    plugins?: Array<string | [string, Record<string, unknown>]>;
    android?: {
      adaptiveIcon?: { foregroundImage?: string; backgroundColor?: string };
    };
  };
  const adaptiveIcon = config.android?.adaptiveIcon;

  expect(adaptiveIcon?.foregroundImage).toBe("./assets/icon-foreground.png");
  expect(adaptiveIcon?.backgroundColor).toBe("#25134d");
  expect(existsSync(resolve(mobileRoot, adaptiveIcon?.foregroundImage ?? ""))).toBe(
    true,
  );
  expect(config.plugins).toContainEqual([
    "expo-notifications",
    {
      icon: "./assets/icon-foreground.png",
      color: "#25134d",
    },
  ]);
});
