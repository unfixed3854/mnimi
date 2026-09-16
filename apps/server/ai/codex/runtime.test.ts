import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryRoot } from "../../runtime-paths.ts";
import {
  assertPrivateCodexCredentials,
  codexAppServerCommand,
  codexChildEnv,
  ensurePrivateCodexHome,
  resolveCodexHome,
} from "./runtime.ts";

describe("Codex runtime boundary", () => {
  let fixturePath: string;

  beforeEach(async () => {
    fixturePath = await mkdtemp(join(tmpdir(), "mnimi-codex-"));
  });

  afterEach(async () => {
    await rm(fixturePath, { recursive: true, force: true });
  });

  it("defaults CODEX_HOME below ignored repository data", () => {
    expect(resolveCodexHome({})).toBe(join(repositoryRoot, "data/codex"));
  });

  it("resolves a relative configured CODEX_HOME below the repository root", () => {
    expect(resolveCodexHome({ CODEX_HOME: "./data/codex" })).toBe(
      join(repositoryRoot, "data/codex"),
    );
  });

  it("keeps an absolute configured CODEX_HOME unchanged", () => {
    expect(resolveCodexHome({ CODEX_HOME: "/data/codex" })).toBe("/data/codex");
  });

  it("preserves an explicitly empty CODEX_HOME", () => {
    expect(resolveCodexHome({ CODEX_HOME: "" })).toBe("");
  });

  it("removes only metered OpenAI API authentication from the child", () => {
    expect(
      codexChildEnv("/safe/codex", {
        OPENAI_API_KEY: "metered-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
        PATH: "/bin",
      }),
    ).toEqual({
      CODEX_HOME: "/safe/codex",
      OPENROUTER_API_KEY: "openrouter-secret",
      PATH: "/bin",
    });
  });

  it.each(["IMAGE_MODEL", "OPENAI_API_KEY"])("omits %s without invoking its getter", (key) => {
    const env = Object.defineProperty({
      CODEX_HOME: "/old-home", OPENROUTER_API_KEY: "openrouter-secret", PATH: "/bin", UNSET: undefined,
    }, key, { enumerable: true, get() { throw new Error(`${key} must not be read`); } });
    expect(codexChildEnv("/safe/codex", env)).toEqual({
      CODEX_HOME: "/safe/codex", OPENROUTER_API_KEY: "openrouter-secret", PATH: "/bin",
    });
  });

  it("launches the pinned package with file auth and a least-privilege profile", async () => {
    const command = codexAppServerCommand();

    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toMatch(/node_modules\/@openai\/codex\/bin\/codex\.js$/);
    expect((await stat(command[1]!)).isFile()).toBe(true);
    expect(command).toContain('cli_auth_credentials_store="file"');
    expect(command).toContain('forced_login_method="chatgpt"');
    expect(command).toContain('default_permissions="mnimi-generation"');
    expect(command).toContain(
      'permissions.mnimi-generation.filesystem={ ":minimal" = "read", ":workspace_roots" = { "." = "write" } }',
    );
    expect(command).toContain("permissions.mnimi-generation.network.enabled=false");
    expect(command.slice(-3)).toEqual(["app-server", "--strict-config", "--stdio"]);
  });

  it("creates and restricts CODEX_HOME to its owner", async () => {
    const home = join(fixturePath, "codex");
    await mkdir(home, { recursive: true, mode: 0o755 });

    await ensurePrivateCodexHome(home);

    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("reports the local login command when credentials are missing", async () => {
    const home = join(fixturePath, "codex");
    await mkdir(home, { mode: 0o700 });

    await expect(assertPrivateCodexCredentials(home)).rejects.toThrow(
      "bun run codex:login",
    );
  });

  if (process.platform !== "win32") {
    it("rejects a CODEX_HOME readable by other users", async () => {
      const home = join(fixturePath, "codex");
      await mkdir(home, { mode: 0o700 });
      await writeFile(join(home, "auth.json"), "{}", { mode: 0o600 });
      await chmod(home, 0o755);

      await expect(assertPrivateCodexCredentials(home)).rejects.toThrow(/0700/);
    });

    it("rejects credentials readable by other users", async () => {
      const home = join(fixturePath, "codex");
      await mkdir(home, { mode: 0o700 });
      const credentials = join(home, "auth.json");
      await writeFile(credentials, "{}", { mode: 0o600 });
      await chmod(credentials, 0o640);

      await expect(assertPrivateCodexCredentials(home)).rejects.toThrow(/0600/);
    });
  }

  it("rejects a CODEX_HOME path that is not a directory", async () => {
    const home = join(fixturePath, "codex");
    await writeFile(home, "not a directory", { mode: 0o600 });

    await expect(assertPrivateCodexCredentials(home)).rejects.toThrow(
      "CODEX_HOME must be a directory",
    );
  });

  it("rejects an auth.json path that is not a file", async () => {
    const home = join(fixturePath, "codex");
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(home, "auth.json"), { mode: 0o700 });

    await expect(assertPrivateCodexCredentials(home)).rejects.toThrow(
      "Codex auth.json must be a file",
    );
  });

  it("accepts a private CODEX_HOME and file credentials", async () => {
    const home = join(fixturePath, "codex");
    await mkdir(home, { mode: 0o700 });
    const credentials = join(home, "auth.json");
    await writeFile(credentials, "{}", { mode: 0o600 });
    await chmod(home, 0o700);
    await chmod(credentials, 0o600);

    await expect(assertPrivateCodexCredentials(home)).resolves.toBeUndefined();
  });
});
