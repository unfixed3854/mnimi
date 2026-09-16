import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { createAuth } from "../auth.ts";
import type { Db } from "../db/index.ts";

type CreateUserInput = {
  email: string;
  name?: string;
  password: string;
};

type AuthOptions = {
  secret?: string;
  baseURL?: string;
};

export function parseCreateUserArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: "string" },
      name: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const email = values.email?.trim();
  if (!email) throw new Error("--email is required");

  const name = values.name?.trim();
  return name ? { email, name } : { email };
}

export async function createUser(
  db: Db,
  input: CreateUserInput,
  authOptions: AuthOptions = {},
) {
  const auth = createAuth(db, {
    ...authOptions,
    registrationEnabled: true,
    autoSignIn: false,
  });
  const response = await auth.api.signUpEmail({
    body: {
      email: input.email,
      name: input.name ?? input.email,
      password: input.password,
    },
  });

  return response.user;
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Password input requires an interactive terminal");
  }

  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  try {
    process.stdout.write(label);
    muted = true;
    return await readline.question("");
  } finally {
    muted = false;
    process.stdout.write("\n");
    readline.close();
  }
}

async function main() {
  const input = parseCreateUserArgs(process.argv.slice(2));
  const password = await promptHidden("Password: ");
  const confirmation = await promptHidden("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match");

  const { db } = await import("../db/index.ts");
  const created = await createUser(db, { ...input, password });
  process.stdout.write(`Created user ${created.email}.\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not create user: ${message}\n`);
    process.exitCode = 1;
  });
}
