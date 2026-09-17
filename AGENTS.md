# Agent instructions

- Use `bun` for package management and public script execution in this project.
  Do not use Deno, `npm`, `npx`, Yarn, or pnpm. Node-backed CLIs invoked by
  `bun run` are an implementation detail of the declared scripts.
- Run the full test suite with `bun run test`, not raw `bun test`; the package
  script runs workspace test runners sequentially with their required setup.
- Use conventional commits.
