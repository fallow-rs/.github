import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/dependabot.yml", import.meta.url),
  "utf8",
);
const botList = workflow.match(/^\s+allowed_bots: (.+)$/mu)?.[1];
const defaultApp = workflow.match(/      app-login:\n[\s\S]*?        default: '([^']+)'/u)?.[1];

const normalize = (actor) =>
  actor
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/u, "");

const allowsActor = (actor, appLogin = defaultApp) => {
  assert.equal(typeof botList, "string", "the Claude step declares allowed_bots");
  assert.equal(typeof appLogin, "string", "the workflow declares its repair App");
  const configured = botList.replace(/\$\{\{\s*inputs\.app-login\s*\}\}/gu, appLogin);
  const allowed = configured.split(",").map(normalize);
  return allowed.includes("*") || allowed.includes(normalize(actor));
};

test("Claude accepts the original Dependabot actor and the default repair App", () => {
  for (const actor of [
    "dependabot",
    "dependabot[bot]",
    "fallow-dependabot",
    "fallow-dependabot[bot]",
  ]) {
    assert.equal(allowsActor(actor), true, actor);
  }
  assert.equal(allowsActor("unrelated-app[bot]"), false);
});

test("Claude follows the caller's repair App without admitting unrelated bots", () => {
  const appLogin = "custom-repair[bot]";
  assert.equal(allowsActor("dependabot[bot]", appLogin), true);
  assert.equal(allowsActor("custom-repair", appLogin), true);
  assert.equal(allowsActor("custom-repair[bot]", appLogin), true);
  assert.equal(allowsActor("fallow-dependabot[bot]", appLogin), false);
  assert.equal(allowsActor("unrelated-app[bot]", appLogin), false);
});
