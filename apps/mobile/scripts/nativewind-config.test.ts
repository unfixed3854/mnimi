import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const globalCssUrl = new URL("../global.css", import.meta.url);
const packageJson = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();
const rootPackageJson = await Bun.file(
  new URL("../../../package.json", import.meta.url),
).json();

test("uses the stable NativeWind 4 and Tailwind 3 dependency stack", () => {
  expect(packageJson.dependencies.nativewind).toBe("4.2.6");
  expect(packageJson.dependencies["react-native-css-interop"]).toBe("0.2.6");
  expect(packageJson.dependencies["react-native-css"]).toBeUndefined();
  expect(packageJson.dependencies["tailwindcss-animate"]).toBe("1.0.7");
  expect(packageJson.devDependencies.tailwindcss).toBe("3.4.17");
  expect(packageJson.devDependencies["@tailwindcss/postcss"]).toBeUndefined();
  expect(packageJson.devDependencies.postcss).toBeUndefined();
  expect(rootPackageJson.overrides?.lightningcss).toBeUndefined();
});

test("configures NativeWind 4 for Babel, Metro, Jest, and TypeScript", async () => {
  const [babelConfig, metroConfig, nativewindTypes, jestConfig] =
    await Promise.all([
      Bun.file(new URL("../babel.config.js", import.meta.url)).text(),
      Bun.file(new URL("../metro.config.js", import.meta.url)).text(),
      Bun.file(new URL("../nativewind-env.d.ts", import.meta.url)).text(),
      Bun.file(new URL("../jest.config.js", import.meta.url)).text(),
    ]);

  expect(babelConfig).toContain('jsxImportSource: "nativewind"');
  expect(babelConfig).toContain('"nativewind/babel"');
  expect(metroConfig).toContain("withNativeWind(config");
  expect(metroConfig).toContain('input: "./global.css"');
  expect(metroConfig).toContain("inlineRem: 16");
  expect(nativewindTypes).toContain("nativewind/types");
  expect(jestConfig).toContain("react-native-css-interop");
  expect(jestConfig).not.toContain("|react-native-css)");
});

test("keeps the app's semantic theme in Tailwind configuration", async () => {
  const [globalCss, tailwindConfig] = await Promise.all([
    Bun.file(globalCssUrl).text(),
    Bun.file(new URL("../tailwind.config.js", import.meta.url)).text(),
  ]);

  expect(globalCss).toBe(
    "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
  );
  expect(tailwindConfig).toContain('darkMode: "class"');
  expect(tailwindConfig).toContain('background: "#FAF8F3"');
  expect(tailwindConfig).toContain('primary: "#315C4D"');
  expect(tailwindConfig).toContain('title: ["32px", { lineHeight: "38px" }]');
  expect(tailwindConfig).toContain('plugins: [require("tailwindcss-animate")]');
  expect(
    await Bun.file(new URL("../postcss.config.mjs", import.meta.url)).exists(),
  ).toBe(false);
});

test("compiles the app's semantic and responsive Tailwind utilities", async () => {
  const postcss = require("postcss");
  const tailwindcss = require("tailwindcss");
  const tailwindConfigPath = fileURLToPath(
    new URL("../tailwind.config.js", import.meta.url),
  );
  const result = await postcss([
    tailwindcss({ config: tailwindConfigPath }),
  ]).process(await Bun.file(globalCssUrl).text(), {
    from: fileURLToPath(globalCssUrl),
  });

  for (const selector of [
    ".bg-background",
    ".px-md",
    ".rounded-lg",
    ".text-title",
    ".md\\:w-full",
  ]) {
    expect(result.css).toContain(selector);
  }
  expect(result.css).toContain("@media (min-width: 768px)");
});
