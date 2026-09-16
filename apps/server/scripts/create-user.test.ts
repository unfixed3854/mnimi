import { count } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { session, user } from "../db/schema.ts";
import { createTestDb } from "../db/testing.ts";

const databases: Awaited<ReturnType<typeof createTestDb>>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("create-user", () => {
  it("parses a required email and optional name", async () => {
    const { parseCreateUserArgs } = await import("./create-user.ts");

    expect(
      parseCreateUserArgs(["--email", "ada@example.com", "--name", "Ada"]),
    ).toEqual({ email: "ada@example.com", name: "Ada" });
    expect(() => parseCreateUserArgs([])).toThrow("--email is required");
  });

  it("rejects passwords passed on the command line", async () => {
    const { parseCreateUserArgs } = await import("./create-user.ts");

    expect(() =>
      parseCreateUserArgs([
        "--email",
        "ada@example.com",
        "--password",
        "visible-in-process-list",
      ]),
    ).toThrow();
  });

  it("creates a user without creating a session", async () => {
    const { createUser } = await import("./create-user.ts");
    const database = await createTestDb();
    databases.push(database);

    const created = await createUser(
      database.db,
      {
        email: "ada@example.com",
        name: "Ada",
        password: "correct-horse",
      },
      {
        secret: "test-secret-at-least-32-characters-long",
        baseURL: "http://localhost:3000",
      },
    );

    expect(created.email).toBe("ada@example.com");
    expect(await database.db.select().from(user)).toHaveLength(1);
    expect(await database.db.select({ count: count() }).from(session)).toEqual([
      { count: 0 },
    ]);
  });
});
