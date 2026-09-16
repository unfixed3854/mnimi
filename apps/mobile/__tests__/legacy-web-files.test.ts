import { access } from "node:fs/promises";
import { join } from "node:path";

const MOBILE_ROOT = join(__dirname, "..");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("legacy web client removal", () => {
  test.each([
    "src-" + "ta" + "uri",
    "vi" + "te.config.ts",
    "vi" + "test.config.ts",
    "index.html",
    "src/routes",
    "src/components/ui/alert.tsx",
    "src/components/ui/label.tsx",
    "src/components/ui/separator.tsx",
    "src/components/ui/sheet.tsx",
    "src/components/ui/sidebar.tsx",
    "src/components/ui/select.tsx",
    "src/components/ui/textarea.tsx",
    "src/components/ui/tooltip.tsx",
    "src/routeTree.gen.ts",
    "src/components/app-sidebar.tsx",
    "src/hooks/use-mobile.ts",
    "src/lib/api",
    "src/theme/index.ts",
    "src/vi" + "te-env.d.ts",
    "tsconfig.node.json",
    "components.json",
  ])("does not ship %s", async (path) => {
    expect(await exists(join(MOBILE_ROOT, path))).toBe(false);
  });
});
