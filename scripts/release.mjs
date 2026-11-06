#!/usr/bin/env node
// Mandatory release flow for this repository.
//
//   npm run release -- patch|minor|major
//   npm run release -- --version 0.4.0
//
// One command does all of it:
//   1. bump package.json version + client.js CLIENT_VERSION (they must match),
//   2. run the full dev:sync gate (tests -> build -> DSH reload -> real identity),
//   3. commit every change, push main, create and push the vX.Y.Z tag,
//   4. wait for the GitHub Actions release workflow and verify the Release.
//
// Use --dry-run to preview the version bump without writing or publishing.
// Use --no-watch only for diagnostics; it still pushes and tags.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = join(ROOT, "package.json");
const CLIENT_PATH = join(ROOT, "client.js");
const RELEASE_WORKFLOW = "release.yml";

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function bumpVersion(current, kind) {
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`invalid current version: ${current}`);
  if (kind === "major") return `${parsed.major + 1}.0.0`;
  if (kind === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  if (kind === "patch") return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  throw new Error(`unknown bump kind: ${kind}`);
}

export function setClientVersion(source, version) {
  const pattern = /(const CLIENT_VERSION = ")([^"]*)(";)/;
  if (!pattern.test(source)) throw new Error("CLIENT_VERSION declaration not found in client.js");
  return source.replace(pattern, `$1${version}$3`);
}

export function tagMatchesVersion(tag, version) {
  return String(tag ?? "").replace(/^v/, "") === String(version ?? "");
}

function run(command, args, options = {}) {
  const capture = Boolean(options.encoding);
  return execFileSync(command, args, {
    cwd: ROOT,
    stdio: options.stdio ?? (capture ? ["ignore", "pipe", "pipe"] : "inherit"),
    encoding: options.encoding ?? "utf8",
    timeout: options.timeout,
  });
}

function git(args, options = {}) {
  return run("git", args, options);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function currentVersion() {
  return readJson(PACKAGE_PATH).version;
}

function applyVersion(version) {
  const pkg = readJson(PACKAGE_PATH);
  pkg.version = version;
  writeJson(PACKAGE_PATH, pkg);
  const source = readFileSync(CLIENT_PATH, "utf8");
  writeFileSync(CLIENT_PATH, setClientVersion(source, version));
}

function parseArgs(argv) {
  const args = { kind: null, version: null, dryRun: false, noWatch: false, message: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-watch") args.noWatch = true;
    else if (arg === "--version") args.version = argv[++i];
    else if (arg === "--message") args.message = argv[++i];
    else if (["patch", "minor", "major"].includes(arg)) args.kind = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function requireCleanBranch() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  if (branch !== "main") throw new Error(`release must run on main, not ${branch}`);
  const remotes = git(["remote"], { encoding: "utf8" });
  if (!/^origin$/m.test(remotes)) throw new Error("git remote origin is required");
}

function releaseRunForTag(tag, { timeoutMs = 120000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = execFileSync("gh", [
      "run", "list", "--workflow", RELEASE_WORKFLOW, "--limit", "30",
      "--json", "databaseId,headBranch,status,conclusion,createdAt,url",
    ], { cwd: ROOT, encoding: "utf8" });
    const runs = JSON.parse(raw);
    const match = runs.find((entry) => entry.headBranch === tag);
    if (match) return match;
    execFileSync("sleep", ["5"], { cwd: ROOT });
  }
  return null;
}

function verifyRelease(tag) {
  const runInfo = releaseRunForTag(tag);
  if (!runInfo) throw new Error(`no GitHub Actions run found for tag ${tag}`);
  console.log(`[release] workflow run ${runInfo.databaseId} ${runInfo.url}`);
  try {
    run("gh", ["run", "watch", String(runInfo.databaseId), "--exit-status", "--interval", "10"], {
      timeout: 45 * 60 * 1000,
    });
  } catch (error) {
    throw new Error(`release workflow failed: ${runInfo.url}\n${error?.message ?? error}`);
  }
  const raw = execFileSync("gh", [
    "release", "view", tag, "--json", "tagName,name,url,assets",
  ], { cwd: ROOT, encoding: "utf8" });
  const release = JSON.parse(raw);
  console.log(`[release] RELEASE OK ${release.url}`);
  console.log(`[release] assets: ${(release.assets ?? []).map((asset) => asset.name).join(", ") || "(none)"}`);
  return release;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const before = currentVersion();
  let next;
  if (args.version) {
    if (!parseVersion(args.version)) throw new Error(`invalid --version ${args.version}`);
    next = args.version;
  } else {
    if (!args.kind) {
      throw new Error("usage: npm run release -- patch|minor|major [--dry-run] [--no-watch]");
    }
    next = bumpVersion(before, args.kind);
  }

  console.log(`[release] version ${before} -> ${next}`);
  if (args.dryRun) {
    console.log("[release] dry run: no files written, dev:sync, commit or push performed");
    return;
  }

  requireCleanBranch();
  applyVersion(next);

  console.log("[release] running dev:sync (tests -> build -> DSH reload -> runtime identity)");
  run("npm", ["run", "dev:sync"]);

  if (args.message && args.message.trim()) {
    git(["add", "-A"]);
    git(["commit", "-m", args.message.trim()]);
  } else {
    git(["add", "-A"]);
    git(["commit", "-m", `chore(release): v${next}`]);
  }
  git(["tag", "-a", `v${next}`, "-m", `v${next}`]);
  git(["push", "origin", "HEAD:main"]);
  git(["push", "origin", `v${next}`]);
  console.log(`[release] pushed main and tag v${next}`);

  if (args.noWatch) {
    console.log(`[release] pushed; GitHub Actions not watched (--no-watch). Tag: v${next}`);
    return;
  }
  verifyRelease(`v${next}`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[release] FAILED: ${error?.message ?? error}`);
    process.exit(1);
  });
}
