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
// If GitHub-hosted macOS runners cannot start (a run is cancelled with zero
// steps), the command falls back to packaging locally and creating the same
// GitHub Release with the same assets. --local forces that path.
//
// Use --dry-run to preview the version bump without writing or publishing.
// Use --no-watch only for diagnostics; it still pushes and tags.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = join(ROOT, "package.json");
const CLIENT_PATH = join(ROOT, "client.js");
const HOST_ENTRY_PATH = join(ROOT, "lib", "index.mjs");
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

export function setHostReleaseVersion(source, version) {
  const pattern = /(const RELEASE_VERSION = ")([^"]*)(";)/;
  if (!pattern.test(source)) throw new Error("RELEASE_VERSION declaration not found in lib/index.mjs");
  return source.replace(pattern, `$1${version}$3`);
}

export function tagMatchesVersion(tag, version) {
  return String(tag ?? "").replace(/^v/, "") === String(version ?? "");
}

export function releaseAssetNames(version) {
  return [
    `dsh-super-computer-use-${version}.tgz`,
    "dsh-super-computer-use.tgz",
    "dsh-super-computer-use-standalone.zip",
  ];
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

function gh(args, options = {}) {
  return run("gh", args, { encoding: "utf8", ...options });
}

function ghJson(args) {
  return JSON.parse(gh(args));
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
  const clientSource = readFileSync(CLIENT_PATH, "utf8");
  writeFileSync(CLIENT_PATH, setClientVersion(clientSource, version));
  const hostSource = readFileSync(HOST_ENTRY_PATH, "utf8");
  writeFileSync(HOST_ENTRY_PATH, setHostReleaseVersion(hostSource, version));
}

function parseArgs(argv) {
  const args = {
    kind: null,
    version: null,
    dryRun: false,
    noWatch: false,
    local: false,
    message: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-watch") args.noWatch = true;
    else if (arg === "--local") args.local = true;
    else if (arg === "--version") args.version = argv[++i];
    else if (arg === "--message") args.message = argv[++i];
    else if (["patch", "minor", "major"].includes(arg)) args.kind = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function requireReleaseBranch() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  if (branch !== "main") throw new Error(`release must run on main, not ${branch}`);
  const remotes = git(["remote"], { encoding: "utf8" });
  if (!/^origin$/m.test(remotes)) throw new Error("git remote origin is required");
}

function repoSlug() {
  return gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
}

function releaseRunForTag(tag, { timeoutMs = 60000, intervalMs = 5000, since = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = ghJson([
      "run", "list", "--workflow", RELEASE_WORKFLOW, "--limit", "30",
      "--json", "databaseId,headBranch,status,conclusion,createdAt,url",
    ]);
    const match = runs.find(
      (entry) => entry.headBranch === tag && Date.parse(entry.createdAt) >= since - 10000,
    );
    if (match) return match;
    execFileSync("sleep", ["5"], { cwd: ROOT });
    if (Date.now() + intervalMs > deadline) break;
  }
  return null;
}

function runHasSteps(runId) {
  try {
    const raw = gh([
      "api", `repos/${repoSlug()}/actions/runs/${runId}/jobs`,
      "--jq", "[.jobs[].steps | length] | add // 0",
    ]);
    return Number(String(raw).trim()) > 0;
  } catch {
    return false;
  }
}

function buildLocalAssets(version) {
  console.log("[release] packaging release assets locally");
  run("pnpm", ["pack"]);
  const versioned = join(ROOT, `dsh-super-computer-use-${version}.tgz`);
  if (!existsSync(versioned)) throw new Error(`pnpm pack did not produce ${versioned}`);
  copyFileSync(versioned, join(ROOT, "dsh-super-computer-use.tgz"));
  const dist = join(ROOT, "dist");
  mkdirSync(dist, { recursive: true });
  const standalone = join(dist, "dsh-super-computer-use-standalone.zip");
  rmSync(standalone, { force: true });
  run("zip", [
    "-r", "-q", standalone,
    "bin", "client.js", "lib", "locale", "skill",
    "cordis.patch.yml", "assets", "package.json", "README.md", "LICENSE",
  ]);
  return [versioned, join(ROOT, "dsh-super-computer-use.tgz"), standalone];
}

function releaseExists(tag) {
  try {
    gh(["release", "view", tag, "--json", "tagName"]);
    return true;
  } catch {
    return false;
  }
}

function verifyReleaseAssets(tag, version, label) {
  const release = ghJson(["release", "view", tag, "--json", "tagName,name,url,assets"]);
  const present = new Set((release.assets ?? []).map((asset) => asset.name));
  for (const name of releaseAssetNames(version)) {
    if (!present.has(name)) throw new Error(`release ${tag} is missing asset ${name}`);
  }
  console.log(`[release] RELEASE OK ${release.url}${label ? ` (${label})` : ""}`);
  return release;
}

function ensureRelease(tag, version, { label = "" } = {}) {
  if (!releaseExists(tag)) {
    run("gh", ["release", "create", tag, "--title", `Release ${tag}`, "--generate-notes"], {
      timeout: 120000,
    });
  }
  const assets = buildLocalAssets(version);
  for (const asset of assets) {
    run("gh", ["release", "upload", tag, asset, "--clobber"], { timeout: 10 * 60 * 1000 });
  }
  return verifyReleaseAssets(tag, version, label);
}

function verifyRelease(tag, version, { local = false, since = 0 } = {}) {
  if (local) {
    console.log("[release] --local: skipping GitHub Actions and packaging locally");
    return ensureRelease(tag, version, { label: "local packaging" });
  }

  const runInfo = releaseRunForTag(tag, { since });
  if (!runInfo) {
    console.log("[release] no GitHub Actions run appeared; falling back to local packaging");
    return ensureRelease(tag, version, { label: "local fallback: no workflow run" });
  }
  console.log(`[release] workflow run ${runInfo.databaseId} ${runInfo.url}`);

  if (runInfo.status === "completed" && runInfo.conclusion === "cancelled" && !runHasSteps(runInfo.databaseId)) {
    console.log("[release] GitHub-hosted runner was never assigned (cancelled with zero steps); falling back to local packaging");
    return ensureRelease(tag, version, { label: "local fallback: runner unavailable" });
  }

  try {
    run("gh", ["run", "watch", String(runInfo.databaseId), "--exit-status", "--interval", "10"], {
      timeout: 45 * 60 * 1000,
    });
  } catch (error) {
    if (!runHasSteps(runInfo.databaseId)) {
      console.log("[release] workflow ended before any step ran; falling back to local packaging");
      return ensureRelease(tag, version, { label: "local fallback: runner unavailable" });
    }
    throw new Error(`release workflow failed: ${runInfo.url}\n${error?.message ?? error}`);
  }

  return verifyReleaseAssets(tag, version, "workflow build");
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
      throw new Error("usage: npm run release -- patch|minor|major [--dry-run] [--no-watch] [--local]");
    }
    next = bumpVersion(before, args.kind);
  }

  console.log(`[release] version ${before} -> ${next}`);
  if (args.dryRun) {
    console.log("[release] dry run: no files written, dev:sync, commit, push or release performed");
    return;
  }

  requireReleaseBranch();
  applyVersion(next);

  console.log("[release] running dev:sync (tests -> build -> DSH reload -> runtime identity)");
  run("npm", ["run", "dev:sync"]);

  git(["add", "-A"]);
  git(["commit", "-m", args.message?.trim() || `chore(release): v${next}`]);
  git(["tag", "-a", `v${next}`, "-m", `v${next}`]);
  git(["push", "origin", "HEAD:main"]);
  const tagPushedAt = Date.now();
  git(["push", "origin", `v${next}`]);
  console.log(`[release] pushed main and tag v${next}`);

  if (args.noWatch) {
    console.log(`[release] pushed; GitHub Actions not watched (--no-watch). Tag: v${next}`);
    return;
  }
  verifyRelease(`v${next}`, next, { local: args.local, since: tagPushedAt });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[release] FAILED: ${error?.message ?? error}`);
    process.exit(1);
  });
}
