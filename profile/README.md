<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo.svg">
    <img src="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo.svg" alt="fallow" width="260">
  </picture>
</p>

<p align="center">
  <strong>Codebase intelligence for TypeScript and JavaScript.</strong><br>
  Free static analysis. Optional paid runtime intelligence.
</p>

<p align="center">
  <a href="https://docs.fallow.tools"><img src="https://img.shields.io/badge/docs-docs.fallow.tools-blue.svg" alt="Documentation"></a>
  <a href="https://fallow.tools"><img src="https://img.shields.io/badge/site-fallow.tools-orange.svg" alt="Website"></a>
  <a href="https://www.npmjs.com/package/fallow"><img src="https://img.shields.io/npm/v/fallow.svg" alt="npm"></a>
  <a href="https://crates.io/crates/fallow-cli"><img src="https://img.shields.io/crates/v/fallow-cli.svg" alt="crates.io"></a>
</p>

---

Linters check files. TypeScript checks types. Fallow checks the codebase.

Fallow builds a module graph across your TypeScript and JavaScript project and reports what nothing depends on, what runs in cycles, what's duplicated, what's complex, and (with the optional runtime layer) what actually ran in production. One pipeline, two layers, zero configuration on the free side.

## Two layers, one decision system

- **Static intelligence (free, MIT).** Unused files, exports, types, dependencies, circular imports, code duplication, complexity hotspots, architecture boundaries, feature-flag usage. Rust-native, sub-second on most projects, 90 framework plugins, JSON / SARIF / CodeClimate / markdown outputs, CI + editor + MCP integrations.
- **Runtime intelligence (paid, Fallow Runtime).** Production execution evidence merged into the same `fallow health` report. Hot paths, cold paths, runtime-backed deletion confidence, runtime-weighted health, stale-flag evidence, trends, alerts, and shared team workflows.

Static analysis is free and open source. Runtime intelligence is the paid team layer.

## Start here

```bash
npx fallow
```

- [Documentation](https://docs.fallow.tools)
- [Static vs runtime intelligence](https://docs.fallow.tools/explanations/static-vs-runtime)
- [Website](https://fallow.tools)

## Repositories

| Repo | What it is |
|---|---|
| [fallow](https://github.com/fallow-rs/fallow) | The CLI, LSP, MCP server, GitHub Action, and VS Code extension. Rust-native, MIT. |
| [docs](https://github.com/fallow-rs/docs) | docs.fallow.tools (Mintlify). |
| [fallow-skills](https://github.com/fallow-rs/fallow-skills) | Agent Skills pack for Claude Code, Cursor, Codex, Gemini CLI, Copilot, Windsurf, Amp, and 30+ more. |
| [fallow-cov-protocol](https://github.com/fallow-rs/fallow-cov-protocol) | Wire contract between the fallow CLI and Fallow Runtime's production-coverage sidecar. |
| [oxc-coverage-instrument](https://github.com/fallow-rs/oxc-coverage-instrument) | Istanbul-compatible coverage instrumentation on the Oxc AST. Powers browser coverage collection. |

## Outcomes

- **Delete cold code** with runtime-backed confidence, not guesses.
- **Review hot-path changes** with evidence, not reviewer instinct.
- **Prioritize refactors** by traffic and complexity together.
- **Retire stale flags** from what ran in practice, not what's written.

## Contributing

Issues and PRs welcome across every repo in the org. Start with the [main `fallow` issue tracker](https://github.com/fallow-rs/fallow/issues) or check [discussions](https://github.com/fallow-rs/fallow/discussions).
