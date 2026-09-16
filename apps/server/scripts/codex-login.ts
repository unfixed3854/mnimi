import {
  codexChildEnv,
  codexCliCommand,
  ensurePrivateCodexHome,
  resolveCodexHome,
} from "../ai/codex/runtime.ts";

export type CodexLoginSpawn = (
  command: string[],
  options: {
    env: Record<string, string>;
    stdin: "inherit";
    stdout: "inherit";
    stderr: "inherit";
  },
) => { exited: Promise<number> };

const spawnCodexLogin: CodexLoginSpawn = (command, options) =>
  Bun.spawn(command, options);

export async function runCodexLogin(
  env: NodeJS.ProcessEnv = process.env,
  spawn: CodexLoginSpawn = spawnCodexLogin,
): Promise<void> {
  const home = resolveCodexHome(env);
  await ensurePrivateCodexHome(home);
  const child = spawn(
    codexCliCommand([
      "-c",
      'cli_auth_credentials_store="file"',
      "login",
      "--device-auth",
    ]),
    {
      env: codexChildEnv(home, env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Codex login exited with code ${exitCode}`);
  }
}

if (import.meta.main) await runCodexLogin();
