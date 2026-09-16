import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set these before importing the server: smoke tests never touch app data or providers.
const mediaDir = mkdtempSync(join(tmpdir(), "mnimi-web-media-"));
process.env.DATABASE_URL = "file::memory:";
process.env.IMAGES_DIR = join(mediaDir, "images");
process.env.AUDIO_DIR = join(mediaDir, "audio");
process.env.OPENROUTER_API_KEY = "test-only";
process.env.ELEVENLABS_API_KEY = "";
const [{ createTestDb }, { createAuth }, { createApp }] = await Promise.all([
  import("../../server/db/testing"),
  import("../../server/auth"),
  import("../../server/app"),
]);
const testDb = await createTestDb();
const origin = "http://localhost:18081";
const auth = createAuth(testDb.db, {
  secret: "web-smoke-test-secret-at-least-32-characters",
  baseURL: "http://localhost:18787",
  trustedOrigins: [origin],
  registrationEnabled: true,
});
const app = createApp({
  db: testDb.db,
  auth,
  corsOrigin: origin,
  devtoolsEnabled: true,
  registrationEnabled: true,
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 18787, fetch: app.fetch });
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  server.stop(true);
  testDb.close();
  rmSync(mediaDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
