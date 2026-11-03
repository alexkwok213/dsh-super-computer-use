# DSH macOS Computer Use Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and integrate `dsh-mac-computer-use`, a native DeepSeek Harness (Cordis) plugin for macOS desktop control, featuring prebuilt native `cu` binaries, Claude-style visual feedback (window halo, floating status capsule, DSH window concession), hybrid AX/OCR targeting, true background interaction, and full skill injection, ready to test in local DSH and publish to GitHub.

**Architecture:** A TypeScript/Node.js Cordis plugin located at `packages/dsh-mac-computer-use` that interfaces with the precompiled macOS native engine `bin/cu` via stdio child processes. The plugin registers 10 core `mac_cu_*` tools in DSH's tool registry (`ctx.tools.register`), automatically manages window halos and top-right status capsules during automation, injects an embedded `mac-computer-use` skill, and provides `cordis.patch.yml` integration for instant hot-reload in DeepSeek Harness.

**Tech Stack:** Node.js (ESM), TypeScript, Cordis / @deepseek-ai/dsh-tools / @deepseek-ai/schemastery, Swift 6 (Native macOS Accessibility / ScreenCaptureKit / AppKit), Apple Vision OCR, pnpm.

**Spec:** Native macOS Computer Use plugin for DSH with Claude-like floating capsule & window halo indicators, background execution, zero-config binary distribution, and full DSH tool & skill contracts.

## Global Constraints

- Must run natively on macOS 14+ (Apple Silicon arm64 & Intel x86_64).
- Must bundle precompiled `bin/cu` so end users do not need Xcode or compiler tools.
- All coordinate values returned to models must be normalized global logical points (top-left origin).
- Must strictly follow DSH Cordis bundle packaging (`package.json`, `cordis.patch.yml`, `dsh.bundle.patch`).
- Every tool call must adhere to DSH's `defineTool` schema and include localized descriptions (zh & en).
- Halo and Capsule UI must be completely click-through (except the Stop button) to avoid freezing user input.

## Review Focus

- **Permission missing behavior**: When Accessibility or Screen Recording is not granted, tool execution must not crash or hang; it must return a structured error with exact macOS Settings URL guidance.
- **DSH self-occlusion**: If DSH is fullscreen or covering the target window, capturing or clicking must either minimize DSH or target the background window directly without clicking DSH itself.
- **Process crash / orphan cleanup**: If the DSH session ends or errors mid-operation, background halo and capsule helper processes must be cleanly terminated without lingering overlays.
- **Coordinate scaling on Retina displays**: Screenshots on Retina (scale 2.0) must correctly map pixels back to logical screen coordinates so AI clicks land exactly on buttons.
- **Unicode & Chinese typing**: Typing Chinese/Japanese characters in background mode must preserve characters without mangling or dropping glyphs.

---

### Task 1: Package Scaffolding & Build Configuration

**Files:**
- Create: `packages/dsh-mac-computer-use/package.json`
- Create: `packages/dsh-mac-computer-use/tsconfig.json`
- Create: `packages/dsh-mac-computer-use/cordis.patch.yml`
- Create: `packages/dsh-mac-computer-use/README.md`
- Create: `packages/dsh-mac-computer-use/LICENSE`

**Interfaces:**
- Produces: Standard DSH Cordis plugin bundle structure with `name: "dsh-mac-computer-use"`, `main: "lib/index.mjs"`, and `dsh.bundle.patch: "./cordis.patch.yml"`.

- [ ] **Step 1: Write `package.json`**
Define name, version (0.1.0), type (module), exports, keywords (`dsh-plugin`, `deepseek-harness`, `mac-computer-use`), peerDependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`), and build scripts.

- [ ] **Step 2: Write `tsconfig.json`**
Configure TypeScript compiler options (Target ES2022, Module NodeNext, OutDir `lib`, Declaration true).

- [ ] **Step 3: Write `cordis.patch.yml`**
Define bundle loader insertion entry:
```yaml
- insert:
    - id: mac-computer-use
      name: "dsh-mac-computer-use"
```

- [ ] **Step 4: Write `README.md` and `LICENSE`**
Document installation via DSH market, manual install via `pnpm`, permissions setup, and feature highlights (Halo, Capsule, Background click/type, AX+OCR).

- [ ] **Step 5: Verify build configuration**
Run `pnpm -v` and verify directory structure.

---

### Task 2: Native Engine Runner & Process Lifecycle Manager

**Files:**
- Create: `packages/dsh-mac-computer-use/src/runner.ts`
- Create: `packages/dsh-mac-computer-use/src/types.ts`
- Test: `packages/dsh-mac-computer-use/test/runner.test.ts`

**Interfaces:**
- Consumes: Native binary `bin/cu` located at bundled path or workspace root.
- Produces: `CuRunner` class with methods `exec(args: string[], options?: RunOptions): Promise<CuResult>`, `doctor(): Promise<DoctorStatus>`, `showHalo(windowId: number, label: string): Promise<void>`, `showCapsule(label: string): Promise<void>`, `dismissVisuals(): Promise<void>`.

- [ ] **Step 1: Define types in `src/types.ts`**
Define `DoctorStatus`, `WindowInfo`, `SnapshotNode`, `ScreenshotResult`, `ClickOptions`, `TypeOptions`, `FindResult`.

- [ ] **Step 2: Implement `CuRunner` in `src/runner.ts`**
Implement binary resolution (checks `./bin/cu` inside plugin bundle, falls back to parent directory or `/usr/local/bin/cu`), spawn execution, JSON stdout parsing, timeout handling, and PID tracking for halo/capsule overlays.

- [ ] **Step 3: Implement Visuals Lifecycle in `CuRunner`**
Add `showHalo(windowId, label)` and `showCapsule(label)` that invoke `cu halo` and `cu capsule` as detached accessory panels, and `dismissVisuals()` that safely terminates any active halo/capsule PIDs.

- [ ] **Step 4: Write automated tests in `test/runner.test.ts`**
Test `runner.doctor()`, `runner.exec(["perms"])`, and verify JSON output parsing.

- [ ] **Step 5: Run tests**
Run: `node --test test/runner.test.ts` (or tsx/node test runner) to verify pass.

---

### Task 3: DSH Tools Definition & Registration

**Files:**
- Create: `packages/dsh-mac-computer-use/src/tools.ts`
- Modify: `packages/dsh-mac-computer-use/src/index.ts`
- Test: `packages/dsh-mac-computer-use/test/tools.test.ts`

**Interfaces:**
- Consumes: `CuRunner`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`.
- Produces: `registerMacCuTools(ctx: Context, runner: CuRunner): () => void` registering 10 core tools:
  1. `mac_cu_doctor`: Diagnostic & permission checks with settings launch.
  2. `mac_cu_windows`: List running applications and visible windows.
  3. `mac_cu_snapshot`: AX semantic tree with `k0.3.2` path refs & delta diffing.
  4. `mac_cu_screenshot`: Window/screen capture with JPEG compression and region crop.
  5. `mac_cu_click`: Background or foreground click by ref or coordinate.
  6. `mac_cu_type`: Background text typing with Unicode / Chinese support.
  7. `mac_cu_key`: Keyboard keys & shortcuts (Cmd, Shift, Enter, etc.).
  8. `mac_cu_scroll`: Scroll wheel interaction on target window.
  9. `mac_cu_find`: Hybrid search (AX tree first, OCR fallback).
  10. `mac_cu_launch`: Launch or bring app to focus.

- [ ] **Step 1: Implement tool definitions in `src/tools.ts`**
Map each tool to `defineTool({ name, description, parameters, execute })`.
Add automatic `runner.showHalo(...)` and `runner.showCapsule(...)` around execution steps so visual feedback is displayed dynamically when tools are called.

- [ ] **Step 2: Implement image attachment formatting in `mac_cu_screenshot`**
Ensure screenshot output returns image data compatible with DSH LLM context (e.g. image block or base64 data URL).

- [ ] **Step 3: Implement `src/index.ts` entry point**
Export `name`, `Config` (Schema), and `apply(ctx, config)` hook. Wire `CuRunner` instantiation and tool registration.

- [ ] **Step 4: Run unit test on tool schema registration**
Verify all 10 tools have valid schemas and descriptions.

---

### Task 4: Embedded Skill & Claude-style Agent Guidance

**Files:**
- Create: `packages/dsh-mac-computer-use/skill/SKILL.md`
- Create: `packages/dsh-mac-computer-use/skill/references/workflow.md`
- Modify: `packages/dsh-mac-computer-use/src/skill.ts`

**Interfaces:**
- Consumes: DSH `skills` service (`ctx.get("skills")`).
- Produces: `mac-computer-use` skill registered into agent context, instructing models on:
  - When to use AX snapshot (`k0.3.2`) vs screenshot vs OCR find.
  - Background click preference (does not interrupt human user).
  - How to handle permissions failure.
  - Best practices for multi-step GUI workflows.

- [ ] **Step 1: Write `skill/SKILL.md` and reference guides**
Write bilingual, concise, highly actionable system skill documentation for the agent.

- [ ] **Step 2: Implement `registerMacCuSkill(ctx)` in `src/skill.ts`**
Hook into `ctx.skills.register` and `agent/created` event so every active agent in DSH immediately acquires the skill.

- [ ] **Step 3: Connect skill registration in `apply()` in `src/index.ts`**

---

### Task 5: DSH Window Concession & UX Integration

**Files:**
- Create: `packages/dsh-mac-computer-use/src/concession.ts`
- Modify: `packages/dsh-mac-computer-use/src/tools.ts`

**Interfaces:**
- Consumes: `bin/cu movewindow`, `bin/cu activate`.
- Produces: `dshConcession` helper that momentarily minimizes or repositions DSH Desktop window when taking fullscreen screenshots or foreground clicks, then restores when the batch is finished.

- [ ] **Step 1: Implement DSH window detection**
Find DSH window by PID / process name (`DeepSeek Harness`).

- [ ] **Step 2: Implement concession logic**
If target app is not DSH and foreground interaction is required, lower DSH window or shrink DSH to side so target app is fully unblocked.

- [ ] **Step 3: Test concession in real macOS environment**

---

### Task 6: Build Binary Bundling, Local DSH Link & Live Verification

**Files:**
- Create: `packages/dsh-mac-computer-use/scripts/bundle-bin.mjs`
- Modify: `packages/dsh-mac-computer-use/package.json`
- Integrate: Link into `~/.dsh/profiles/desktop`

**Interfaces:**
- Consumes: Compiled `bin/cu` from root project.
- Produces: Self-contained plugin bundle in `packages/dsh-mac-computer-use/bin/cu`, linked into DSH desktop profile.

- [ ] **Step 1: Write bundling script**
Copy signed `bin/cu` into `packages/dsh-mac-computer-use/bin/cu` and verify executable permissions.

- [ ] **Step 2: Compile plugin TypeScript to `lib/index.mjs`**
Run build script (`pnpm run build` or `tsx / tsup / esbuild`).

- [ ] **Step 3: Link into DSH Desktop Profile**
Install / link `dsh-mac-computer-use` into `~/.dsh/profiles/desktop/node_modules/dsh-mac-computer-use`, and add entry to `cordis.patch.yml` or `package.json`.

- [ ] **Step 4: Verify in live DeepSeek Harness Web GUI**
Verify that the plugin loads, tools appear, and `mac_cu_doctor` runs successfully in DSH.

---

### Task 7: GitHub Repository Preparation & Documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `packages/dsh-mac-computer-use/README.zh.md`
- Create: `packages/dsh-mac-computer-use/CHANGELOG.md`
- Modify: Root `README.md`

**Interfaces:**
- Produces: Clean, open-source ready GitHub repository and npm publishable package with bilingual documentation, screenshots, and CI workflow.

- [ ] **Step 1: Write bilingual READMEs with clear setup instructions & screenshots**
- [ ] **Step 2: Add GitHub Action workflow for CI / release build**
- [ ] **Step 3: Review git status, verify clean diff, ready for `git push origin`**
