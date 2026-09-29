<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo.svg">
    <img src="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo.svg" alt="fallow" width="290">
  </picture>
</p>

<p align="center">
  <strong>Codebase intelligence for TypeScript and JavaScript.</strong><br>
  Health, complexity, duplication, architecture, styling, and unused code, from one graph of your repository.
</p>

<p align="center">
  <a href="https://docs.fallow.tools"><img src="https://img.shields.io/badge/docs-docs.fallow.tools-blue.svg" alt="Documentation"></a>
  <a href="https://fallow.tools"><img src="https://img.shields.io/badge/site-fallow.tools-orange.svg" alt="Website"></a>
  <a href="https://www.npmjs.com/package/fallow"><img src="https://img.shields.io/npm/v/fallow.svg" alt="npm"></a>
  <a href="https://crates.io/crates/fallow-cli"><img src="https://img.shields.io/crates/v/fallow-cli.svg" alt="crates.io"></a>
</p>

---

fallow reads a whole TypeScript or JavaScript repository as one graph. From that graph it answers the questions that a team asks about its code:

- Is this change safe to merge?
- Where is the code hard to change?
- Does the architecture hold?
- What is copied?
- Does the UI follow the design system?
- What does nothing use?

The analyzer is deterministic and written in Rust. There is no AI inside it. The same input gives the same findings, with typed JSON output that CI, editors, and coding agents can use.

```bash
npx fallow            # health, duplication, and unused code in one run
npx fallow audit      # the findings that a pull request introduces
npx fallow health     # health score, hotspots, and refactoring targets
```

## Repositories

| Repository | What it is |
|---|---|
| [fallow](https://github.com/fallow-rs/fallow) | The CLI, the GitHub Action, the GitLab template, the LSP and MCP servers, and the VS Code extension |
| [docs](https://github.com/fallow-rs/docs) | The source of [docs.fallow.tools](https://docs.fallow.tools) |
| [fallow-skills](https://github.com/fallow-rs/fallow-skills) | Agent skills for Claude Code, Codex, Cursor, and other coding agents |
| [srcmap](https://github.com/fallow-rs/srcmap) | A source map SDK for Rust tooling |
| [oxc-coverage-instrument](https://github.com/fallow-rs/oxc-coverage-instrument) | Istanbul-compatible coverage instrumentation on the Oxc AST |
| [fallow-cov-protocol](https://github.com/fallow-rs/fallow-cov-protocol) | The JSON contract between the CLI and the production-coverage sidecar |

Everything above is MIT licensed. Production runtime coverage is an optional paid add-on, Fallow Cloud.

## Contributing and support

Issues and pull requests are welcome in every repository. Start with the [fallow issue tracker](https://github.com/fallow-rs/fallow/issues) or the [discussions](https://github.com/fallow-rs/fallow/discussions). To support the project, see [GitHub Sponsors](https://github.com/sponsors/fallow-rs).
