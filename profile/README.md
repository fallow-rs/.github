<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo.svg">
    <img src="https://raw.githubusercontent.com/fallow-rs/fallow/main/assets/logo.svg" alt="fallow" width="290">
  </picture>
</p>

<p align="center">
  <strong>Codebase intelligence for TypeScript and JavaScript.</strong><br>
  Quality, risk, architecture, dependencies, duplication, and design-system drift, for humans, CI, and the agents writing your code.<br>
  Free static analysis of code and styles. Optional runtime intelligence (Fallow Runtime) adds production execution evidence.<br>
  <sub>Rust-native · zero-config · sub-second · no AI inside the analyzer</sub>
</p>

<p align="center">
  <a href="https://docs.fallow.tools"><img src="https://img.shields.io/badge/docs-docs.fallow.tools-blue.svg" alt="Documentation"></a>
  <a href="https://fallow.tools"><img src="https://img.shields.io/badge/site-fallow.tools-orange.svg" alt="Website"></a>
  <a href="https://www.npmjs.com/package/fallow"><img src="https://img.shields.io/npm/v/fallow.svg" alt="npm"></a>
  <a href="https://crates.io/crates/fallow-cli"><img src="https://img.shields.io/crates/v/fallow-cli.svg" alt="crates.io"></a>
</p>

---

Fallow turns a JS/TS repository into a trusted quality report: health score, changed-code risk, hotspots, duplication, architecture issues, dependency hygiene, styling consistency, and cleanup opportunities. It helps you answer:

- What changed?
- What got riskier?
- What should I review?
- What should I refactor?
- What can be safely removed?

Fallow is built for maintainers, CI pipelines, editors, and AI agents that need structured evidence instead of guesses. No AI inside the analyzer. Fallow produces deterministic findings, typed output contracts, and traceable explanations that downstream tools can trust.

Linters check files. TypeScript checks types. Fallow checks the codebase.

## Two layers, one decision system

- **Static intelligence (free, MIT).** Unused files, exports, types, dependencies, circular imports, code duplication, complexity hotspots, architecture boundaries, design-system drift, feature-flag usage. Broad framework support, JSON / SARIF / CodeClimate / markdown outputs, CI + editor + MCP integrations.
- **Runtime intelligence (paid, Fallow Runtime).** Production execution evidence merged into the same `fallow health` report. Hot paths, cold paths, runtime-backed deletion confidence, runtime-weighted health, stale-flag evidence, trends, alerts, and shared team workflows.

Static analysis is free and open source. Runtime intelligence is the paid team layer.

## Start here

```bash
npx fallow audit       # Changed-code risk gate for PRs
npx fallow             # Full codebase analysis: cleanup + duplication + health
npx fallow health      # Quality score, hotspots, refactor targets
```

- [Documentation](https://docs.fallow.tools)
- [Static vs runtime intelligence](https://docs.fallow.tools/explanations/static-vs-runtime)
- [Website](https://fallow.tools)

## Repositories

| Repo | What it is |
|---|---|
| [fallow](https://github.com/fallow-rs/fallow) | The CLI, LSP, MCP server, GitHub Action, and VS Code extension. MIT. |
| [docs](https://github.com/fallow-rs/docs) | docs.fallow.tools (Mintlify). |
| [fallow-skills](https://github.com/fallow-rs/fallow-skills) | Agent Skills pack for Claude Code, Cursor, Codex, Gemini CLI, Copilot, Windsurf, Amp, and 30+ more. |
| [fallow-cov-protocol](https://github.com/fallow-rs/fallow-cov-protocol) | Wire contract between the fallow CLI and Fallow Runtime's production-coverage sidecar. |
| [oxc-coverage-instrument](https://github.com/fallow-rs/oxc-coverage-instrument) | Istanbul-compatible coverage instrumentation on the Oxc AST. Powers browser coverage collection. |

## Built for agents

Fallow gives AI agents structured repo truth instead of forcing them to infer everything from grep. Every issue in `--format json` carries a machine-actionable `actions` array with an `auto_fixable` flag, so agents can self-correct before opening a PR. MCP server, LSP, and a version-matched Agent Skill ship in the npm package for Claude Code, Codex, Cursor, Windsurf, and other agents.

## Outcomes

- **Delete cold code** with runtime-backed confidence, not guesses.
- **Review hot-path changes** with evidence, not reviewer instinct.
- **Prioritize refactors** by traffic and complexity together.
- **Retire stale flags** from what ran in practice, not what's written.

## Contributing

Issues and PRs welcome across every repo in the org. Start with the [main `fallow` issue tracker](https://github.com/fallow-rs/fallow/issues) or check [discussions](https://github.com/fallow-rs/fallow/discussions).
