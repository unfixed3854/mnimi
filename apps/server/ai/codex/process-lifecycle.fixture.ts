// Executed only by the offline lifecycle integration test using Bun 1.3.13.
import { CodexAppServerClient, spawnCodexAppServer } from "./app-server-client.ts";

const scenario = process.argv[2] ?? "detached-exit";
const detached = scenario.startsWith("detached");
const launcher = `
  import { spawn } from "node:child_process";
  import { createInterface } from "node:readline";
  const descendant = spawn(process.execPath, ["--no-env-file", "-e", "setTimeout(() => {}, 20000)"], {
    detached: ${JSON.stringify(detached)},
    stdio: ["ignore", "inherit", "inherit"],
  });
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "leave") process.exit(0);
    if (message.id !== undefined) process.stdout.write(JSON.stringify({
      id: message.id, result: { pid: descendant.pid },
    }) + "\\n");
  }
`;

let descendant: number | undefined;
let spawns = 0;
const client = new CodexAppServerClient({ spawn: () => {
  spawns++;
  return spawnCodexAppServer([process.execPath, "--no-env-file", "-e", launcher], {
    PATH: process.env.PATH ?? "",
  });
} });

async function alive(): Promise<boolean> {
  if (!descendant) return false;
  try {
    process.kill(descendant, 0);
    return true;
  } catch { return false; }
}

let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  const run = (async () => {
    descendant = (await client.request<{ pid: number }>("ready", {})).pid;
    const error = scenario.endsWith("exit")
      ? await client.request("leave", {}).catch((error: unknown) => error)
      : undefined;
    const before = performance.now();
    await client[Symbol.asyncDispose]();
    const closeMilliseconds = performance.now() - before;
    for (let i = 0; i < 40 && await alive(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    return { error, scenario, spawns, closeMilliseconds, descendantStopped: !await alive() };
  })();
  const result = await Promise.race([run, new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("Offline lifecycle did not settle")), 4000);
  })]);
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(deadline);
  await client[Symbol.asyncDispose]();
  if (await alive()) process.kill(descendant!, "SIGKILL");
}
