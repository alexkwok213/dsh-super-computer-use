import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("existing host exports stay intact", () => {
  assert.equal(pkg.name, "dsh-super-computer-use");
  assert.equal(pkg.exports["."].default, "./lib/index.mjs");
  assert.equal(pkg.exports["./core"].default, "./lib/core.mjs");
  assert.equal(pkg.exports["./locale/*"], "./locale/*");
  assert.equal(pkg.exports["./package.json"], "./package.json");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
});

test("client module is exported and shipped", () => {
  assert.equal(pkg.exports["./client"], "./client.js");
  assert.ok(pkg.files.includes("client.js"), "files must ship client.js");
  assert.ok(pkg.files.includes("lib"), "files must ship lib");
  assert.ok(existsSync(join(root, "client.js")), "client.js must exist");
});

test("client manifest declares web activation before its slot owners", () => {
  assert.equal(pkg.dsh.client.platform, "web");
  assert.equal(pkg.dsh.client.immediately, true);
  assert.ok(Array.isArray(pkg.dsh.client.inject));
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-conversation"));
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-layout"));
});

test("client bundle registers under the package name and takes React from the host", () => {
  const source = readFileSync(join(root, "client.js"), "utf8");
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, new RegExp(`id:\\s*["']${pkg.name}["']`));
  assert.match(source, /const React = require\(["']react["']\)/);
  assert.doesNotMatch(source, /require\(["']react-dom/);
  assert.doesNotMatch(source, /document\.body\.(append|appendChild)/);
});

test("client registers the ambient card and the frame-wide overlay", () => {
  const source = readFileSync(join(root, "client.js"), "utf8");
  assert.match(source, /conversation\.input\.dock/);
  assert.match(source, /shell\.overlay/);
  assert.match(source, /sessionId/);
});

test("locale files still provide plugin metadata", () => {
  for (const locale of ["en.json", "zh-CN.json"]) {
    const dict = JSON.parse(readFileSync(join(root, "locale", locale), "utf8"));
    assert.ok(dict.meta?.title, `${locale} meta.title`);
    assert.ok(dict.meta?.description, `${locale} meta.description`);
  }
});
