import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimePath } from "../../runtime-paths.ts";

export const CODEX_PACKAGE_VERSION = "0.154.0";
export const CODEX_PERMISSION_PROFILE = "mnimi-generation";

const SECURITY_OVERRIDES = [
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  `default_permissions="${CODEX_PERMISSION_PROFILE}"`,
  "-c",
  `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={ ":minimal" = "read", ":workspace_roots" = { "." = "write" } }`,
  "-c",
  `permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=false`,
];

function codexEntrypoint(): string {
  const packageJson = fileURLToPath(
    import.meta.resolve("@openai/codex/package.json"),
  );
  return resolve(dirname(packageJson), "bin/codex.js");
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME;
  if (configured === undefined) return resolveRuntimePath("./data/codex");
  return configured === "" ? configured : resolveRuntimePath(configured);
}

export async function ensurePrivateCodexHome(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function assertPrivateCodexCredentials(path: string): Promise<void> {
  const credentialsPath = join(path, "auth.json");
  let home;

  try {
    home = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Codex credentials are missing; run bun run codex:login");
    }
    throw error;
  }

  if (!home.isDirectory()) {
    throw new Error("CODEX_HOME must be a directory");
  }

  let credentials;
  try {
    credentials = await stat(credentialsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Codex credentials are missing; run bun run codex:login");
    }
    throw error;
  }

  if (!credentials.isFile()) {
    throw new Error("Codex auth.json must be a file");
  }

  if (process.platform !== "win32" && (home.mode & 0o077) !== 0) {
    throw new Error("CODEX_HOME must have mode 0700");
  }
  if (process.platform !== "win32" && (credentials.mode & 0o077) !== 0) {
    throw new Error("Codex auth.json must have mode 0600");
  }
}

export function codexChildEnv(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    if (key === "OPENAI_API_KEY" || key === "IMAGE_MODEL") continue;
    const value = env[key];
    if (value !== undefined) child[key] = value;
  }
  child.CODEX_HOME = home;
  return child;
}

export function codexCliCommand(args: string[]): string[] {
  return [process.execPath, codexEntrypoint(), ...args];
}

export function codexAppServerCommand(): string[] {
  return [
    process.execPath,
    codexEntrypoint(),
    ...SECURITY_OVERRIDES,
    "app-server",
    "--strict-config",
    "--stdio",
  ];
}
