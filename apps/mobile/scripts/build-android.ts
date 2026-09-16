import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getApiUrl } from "../src/config/api-url.ts";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type RunOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
};

type RunCommand = (
  command: string[],
  options: RunOptions,
) => Promise<void>;

type RemoveFile = (
  path: string,
  options: { force: boolean },
) => Promise<void>;

async function runCommand(
  command: string[],
  options: RunOptions,
): Promise<void> {
  const child = Bun.spawn(command, {
    ...options,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${exitCode}: ${command.join(" ")}`,
    );
  }
}

export async function buildAndroid(
  {
    run = runCommand,
    remove = rm,
    env = process.env,
  }: {
    run?: RunCommand;
    remove?: RemoveFile;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  getApiUrl({ apiUrl: env.EXPO_PUBLIC_API_URL, development: false });

  await run([
    "bun",
    "run",
    "--no-install",
    "expo",
    "prebuild",
    "--platform",
    "android",
    "--no-clean",
    "--no-install",
    "--skip-dependency-update",
    "expo,react,react-native",
  ], {
    cwd: mobileRoot,
    env: { ...env, CI: "1" },
  });

  const androidDir = join(mobileRoot, "android");
  await remove(
    join(
      androidDir,
      "app",
      "build",
      "outputs",
      "apk",
      "release",
      "app-release.apk",
    ),
    { force: true },
  );
  await run([
    join(androidDir, "gradlew"),
    "-p",
    androidDir,
    "assembleRelease",
    "--no-daemon",
  ], {
    cwd: mobileRoot,
    env: { ...env, NODE_ENV: "production", CI: "1" },
  });
}

if (import.meta.main) {
  try {
    await buildAndroid();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
