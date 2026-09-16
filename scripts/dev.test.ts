import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { runDev } from "./dev.mjs";

type FakeChild = {
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
};

function controlledChild() {
  let finish!: (code: number) => void;
  let killed = false;
  const child: FakeChild = {
    exited: new Promise<number>((resolve) => finish = resolve),
    kill: () => {
      killed = true;
      finish(0);
    },
  };
  return { child, finish, killed: () => killed };
}

describe("runDev", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(`${tmpdir()}/mnimi-dev-unit-`); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it("gives Expo inherited stdio and keeps server output out of the TUI", async () => {
    const server = controlledChild();
    const mobile = controlledChild();
    const calls: Array<{
      command: string[];
      options: Record<string, unknown>;
    }> = [];
    const result = runDev({
      logPath: pathToFileURL(`${dir}/server.log`),
      waitForReady: async () => {},
      installSignals: false,
      spawn: (command, options) => {
        calls.push({ command, options });
        return calls.length === 1 ? server.child : mobile.child;
      },
    });
    mobile.finish(0);
    expect(await result).toBe(0);
    expect(calls[0].command).toEqual(["bun", "run", "server:dev"]);
    expect(calls[0].options.stdin).toBe("ignore");
    expect(calls[1].command).toEqual(["bun", "run", "mobile:dev"]);
    expect(calls[1].options).toMatchObject({
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(server.killed()).toBe(true);
  });

  it("terminates Expo and fails when the server exits", async () => {
    const server = controlledChild();
    const mobile = controlledChild();
    let calls = 0;
    const result = runDev({
      logPath: pathToFileURL(`${dir}/server.log`),
      waitForReady: async () => {},
      installSignals: false,
      spawn: () => ++calls === 1 ? server.child : mobile.child,
    });
    while (calls < 2) await Bun.sleep(5);
    server.finish(9);
    expect(await result).toBe(1);
    expect(mobile.killed()).toBe(true);
  });
});

describe("real dev subprocesses", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`cleans up a stubborn backend on ${signal}`, async () => {
      const dir = await mkdtemp(`${tmpdir()}/mnimi-dev-signal-`);
      const backendSource = `
        process.on('SIGTERM', () => {});
        const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
        await Bun.write(${JSON.stringify(`${dir}/backend.json`)}, JSON.stringify({ pid: process.pid, port: server.port }));
        console.log(process.env.MNIMI_DEV_READY_TOKEN);
      `;
      const runner = Bun.spawn([process.execPath, "-e", `
        import { runDev } from ${JSON.stringify(new URL("./dev.mjs", import.meta.url).href)};
        process.exitCode = await runDev({
          logPath: new URL(${JSON.stringify(pathToFileURL(`${dir}/server.log`).href)}),
          shutdownTimeoutMs: 100,
          spawn(command, options) {
            return Bun.spawn([process.execPath, '-e', command.includes('server:dev')
              ? ${JSON.stringify(backendSource)}
              : ${JSON.stringify(`await Bun.write(${JSON.stringify(`${dir}/mobile`)}, 'started'); setInterval(() => {}, 1000);`)}], options);
          },
        });
      `], { stdout: "ignore", stderr: "pipe" });
      let backend: { pid: number; port: number } | undefined;
      try {
        for (let i = 0; i < 200 && !await Bun.file(`${dir}/mobile`).exists(); i++) await Bun.sleep(10);
        expect(await Bun.file(`${dir}/mobile`).exists()).toBe(true);
        backend = JSON.parse(await readFile(`${dir}/backend.json`, "utf8"));
        expect((await fetch(`http://127.0.0.1:${backend!.port}`)).status).toBe(200);
        runner.kill(signal);
        expect(await runner.exited).toBe(signal === "SIGINT" ? 130 : 143);
        const replacement = Bun.serve({ port: backend!.port, fetch: () => new Response("new") });
        replacement.stop(true);
      } finally {
        runner.kill("SIGKILL");
        if (!backend) backend = JSON.parse(await readFile(`${dir}/backend.json`, "utf8").catch(() => "null"));
        if (backend) { try { process.kill(backend.pid, "SIGKILL"); } catch {} }
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
  for (const failure of [false, true, "timeout"] as const) {
    it(failure === "timeout" ? "times out without accepting another launch's readiness token" : failure ? "rejects a watch process that cannot bind without starting Expo" : "stops a backend descendant when Expo exits", async () => {
      const dir = await mkdtemp(`${tmpdir()}/mnimi-dev-`);
      const children: ReturnType<typeof Bun.spawn>[] = [];
      let mobileStarted = false;
      let descendant = 0;
      const result = runDev({
        installSignals: false,
        logPath: pathToFileURL(`${dir}/server.log`),
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 100,
        spawn: (command, options) => {
          const backend = command.includes("server:dev");
          if (!backend) mobileStarted = true;
          const source = backend ? `
            const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
            await Bun.write(${JSON.stringify(`${dir}/pid`)}, String(child.pid));
            console.log(${failure === "timeout" ? '"mnimi-ready:previous-launch"' : failure ? '"EADDRINUSE: port already in use"' : 'process.env.MNIMI_DEV_READY_TOKEN'});
            setInterval(() => {}, 1000);
          ` : "process.exit(0)";
          const child = Bun.spawn([process.execPath, "-e", source], options);
          children.push(child);
          return child;
        },
      });
      try {
        expect(await result).toBe(failure ? 1 : 0);
        descendant = Number(await readFile(`${dir}/pid`, "utf8"));
        expect(mobileStarted).toBe(!failure);
        // A surviving descendant keeps executing even after its wrapper exits.
        let running = true;
        for (let i = 0; i < 100; i++) {
          try {
            const stat = await readFile(`/proc/${descendant}/stat`, "utf8");
            running = !stat.split(") ")[1].startsWith("Z");
          } catch { running = false; }
          if (!running) break;
          await Bun.sleep(10);
        }
        expect(running).toBe(false);
      } finally {
        if (!descendant) descendant = Number(await readFile(`${dir}/pid`, "utf8").catch(() => "0"));
        if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
        for (const child of children) { try { child.kill("SIGKILL"); } catch {} }
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("root mobile:dev route", () => {
  it("invokes the mobile member directly so Expo retains TTY ownership", async () => {
    const rootPackage = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    const route = rootPackage.scripts["mobile:dev"];

    expect(route).toBe("cd apps/mobile && bun run dev");
    expect(route).not.toContain("--filter");
  });
});

describe("root server:start route", () => {
  it("starts the API with production security defaults", async () => {
    const serverPackage = JSON.parse(
      await readFile(
        new URL("../apps/server/package.json", import.meta.url),
        "utf8",
      ),
    );

    expect(serverPackage.scripts.start).toBe(
      "NODE_ENV=production bun --env-file=.env main.ts",
    );
  });
});

describe("server environment reload", () => {
  it("reloads edited, replaced and removed .env files and releases the port on shutdown", async () => {
    const dir = await mkdtemp(`${tmpdir()}/mnimi-env-reload-`);
    const serverDir = `${dir}/apps/server`;
    await mkdir(`${serverDir}/scripts`, { recursive: true });
    await mkdir(`${dir}/scripts`, { recursive: true });
    await Bun.write(`${dir}/bunfig.toml`, await Bun.file(new URL("../bunfig.toml", import.meta.url)).text());
    await Bun.write(`${serverDir}/package.json`, await Bun.file(new URL("../apps/server/package.json", import.meta.url)).text());
    const supervisor = Bun.file(new URL("./server-dev.mjs", import.meta.url));
    await Bun.write(`${dir}/scripts/server-dev.mjs`, await supervisor.text());
    await Bun.write(`${serverDir}/scripts/validate-runtime-config.ts`, "");
    await Bun.write(`${serverDir}/.env`, "MNIMI_RELOAD_TEST=first\n");
    await Bun.write(`${serverDir}/main.ts`, `
      const server = Bun.serve({ port: 0, fetch: () => new Response(process.env.MNIMI_RELOAD_TEST ?? 'missing') });
      await Bun.write('address.json', JSON.stringify({ port: server.port }));
    `);
    const child = Bun.spawn([process.execPath, "run", "dev"], {
      cwd: serverDir, stdout: "ignore", stderr: "ignore",
    });
    let port = 0;
    async function waitForValue(value: string) {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          port = JSON.parse(await Bun.file(`${serverDir}/address.json`).text()).port;
          if (await (await fetch(`http://127.0.0.1:${port}`)).text() === value) return;
        } catch {}
        await Bun.sleep(25);
      }
      throw new Error(`Server did not serve ${value}`);
    }
    try {
      await waitForValue("first");
      const source = await Bun.file(`${serverDir}/main.ts`).text();
      await Bun.write(`${serverDir}/main.ts`, source.replace("process.env.MNIMI_RELOAD_TEST ?? 'missing'", "(process.env.MNIMI_RELOAD_TEST ?? 'missing') + '-source'"));
      await waitForValue("first-source");
      await Bun.write(`${serverDir}/.env`, "MNIMI_RELOAD_TEST=second\n");
      await waitForValue("second-source");
      await Bun.write(`${serverDir}/.env.next`, "MNIMI_RELOAD_TEST=third\n");
      await rename(`${serverDir}/.env.next`, `${serverDir}/.env`);
      await waitForValue("third-source");
      await rm(`${serverDir}/.env`);
      await waitForValue("missing-source");
      child.kill("SIGTERM");
      await child.exited;
      const replacement = Bun.serve({ port, fetch: () => new Response("ok") });
      replacement.stop(true);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
