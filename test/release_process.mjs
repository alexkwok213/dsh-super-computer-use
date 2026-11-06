// Release process regressions: the mandatory version/publish flow must stay
// aligned. These tests cover only pure helpers; the real tag/push/CI path is
// verified by the release command itself.

import test from "node:test";
import assert from "node:assert/strict";

import {
  bumpVersion,
  parseVersion,
  setClientVersion,
  tagMatchesVersion,
} from "../scripts/release.mjs";

test("semver bump supports patch, minor and major", () => {
  assert.equal(bumpVersion("0.3.0", "patch"), "0.3.1");
  assert.equal(bumpVersion("0.3.0", "minor"), "0.4.0");
  assert.equal(bumpVersion("0.3.0", "major"), "1.0.0");
  assert.equal(bumpVersion("1.9.9", "patch"), "1.9.10");
});

test("invalid versions and bump kinds are rejected", () => {
  assert.equal(parseVersion("0.4"), null);
  assert.equal(parseVersion("v0.4.0"), null);
  assert.deepEqual(parseVersion("0.4.0"), { major: 0, minor: 4, patch: 0 });
  assert.throws(() => bumpVersion("0.4", "minor"), /invalid current version/);
  assert.throws(() => bumpVersion("0.4.0", "build"), /unknown bump kind/);
});

test("client.js CLIENT_VERSION is rewritten exactly once", () => {
  const source = 'const CLIENT_VERSION = "0.3.0";\nconst OTHER = "0.3.0";\n';
  const next = setClientVersion(source, "0.4.0");
  assert.match(next, /const CLIENT_VERSION = "0\.4\.0";/);
  assert.match(next, /const OTHER = "0\.3\.0";/, "unrelated strings stay untouched");
  assert.throws(() => setClientVersion("const OTHER = 1;", "0.4.0"), /CLIENT_VERSION declaration not found/);
});

test("release tag must equal the package version", () => {
  assert.equal(tagMatchesVersion("v0.4.0", "0.4.0"), true);
  assert.equal(tagMatchesVersion("0.4.0", "0.4.0"), true);
  assert.equal(tagMatchesVersion("v0.3.0", "0.4.0"), false);
});
