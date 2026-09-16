import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodexLoginSpawn, runCodexLogin } from "./codex-login.ts";

describe("Codex operator login", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
      ),
    );
  });

  it("launches device auth from the pinned CLI with private file credentials", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mnimi-codex-login-"));
    temporaryDirectories.push(fixture);
    const home = join(fixture, "home");
    const spawn = vi.fn<CodexLoginSpawn>(() => ({ exited: Promise.resolve(0) }));

    await runCodexLogin(
      {
        CODEX_HOME: home,
        OPENAI_API_KEY: "metered-secret",
        PATH: "/bin",
      },
      spawn,
    );

    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect(spawn).toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0]!;
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toMatch(/node_modules\/@openai\/codex\/bin\/codex\.js$/);
    expect(command.slice(2)).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "login",
      "--device-auth",
    ]);
    expect(options).toEqual({
      env: { CODEX_HOME: home, PATH: "/bin" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  });

  it("reports a nonzero CLI exit without exposing environment values", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mnimi-codex-login-"));
    temporaryDirectories.push(fixture);
    const secret = "operator-secret";

    const error = await runCodexLogin(
      { CODEX_HOME: join(fixture, "home"), SECRET: secret },
      () => ({ exited: Promise.resolve(17) }),
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Codex login exited with code 17" });
    expect(String(error)).not.toContain(secret);
  });
});
