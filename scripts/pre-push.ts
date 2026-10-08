// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * The fork's merge gate. Git runs this before every push (see `.vite-hooks/pre-push`); there is
 * no CI. It checks the workspaces the pushed commits touch plus the workspaces that depend on
 * them, through `vp run --cache` so an unchanged package replays its last passing result.
 *
 * Bypass once with `git push --no-verify`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Workspaces whose test suite is not gated yet. The server suite takes over half an hour and
 * still has failures from before this gate existed; gate it once it passes.
 */
export const TESTS_NOT_GATED = new Set(["t3"]);

/**
 * Workspaces whose tests run outside `vp run --cache`. Its file tracking runs `/bin/sh` and
 * `/bin/bash` scripts under a bundled `osh` on macOS, which rejects `sh -s`; the SSH runner
 * tests pipe their scripts into `sh -s` exactly as the remote shell receives them.
 */
export const TESTS_NOT_CACHED = new Set(["@t3tools/ssh"]);

/**
 * Test files not gated yet, because they fail on main on a macOS host. Gate each again once it
 * passes:
 * - the mobile app's native Swift checks: the notification fixture does not compile (`Mutex` not
 *   in scope), and ThreadSanitizer reports a race in the permissions registry;
 * - `mobile-native-client`, which expects `/tmp` paths where macOS resolves `/private/tmp`;
 * - `build-desktop-artifact`'s cross-architecture Windows probe case, which fails on arm64;
 * - `knip-schemas`, whose fixture project gets a file finding from the current Knip;
 * - the desktop browser-import `Sources` Firefox Snap profile cases, which time out.
 */
export const TEST_FILES_NOT_GATED = [
  "**/notification-center-manager.test.ts",
  "**/permissions-service.test.ts",
  "**/mobile-native-client.test.ts",
  "**/build-desktop-artifact.test.ts",
  "**/knip-schemas.test.ts",
  "**/BrowserImport/Sources.test.ts",
];

/**
 * Workspaces whose typecheck passes today. The rest still carry errors from before this gate
 * existed; add each one here once it is clean.
 */
export const TYPECHECK_GATED = new Set([
  "@t3tools/client-runtime",
  "@t3tools/contracts",
  "@t3tools/desktop",
  "@t3tools/marketing",
  "@t3tools/oxlint-plugin-t3code",
  "@t3tools/scripts",
  "@t3tools/shared",
  "@t3tools/ssh",
  "@t3tools/tailscale",
  "effect-acp",
  "effect-codex-app-server",
  "t3code-relay",
]);

/** Root files every workspace builds or installs through. */
const GLOBAL_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "vite.config.ts",
]);
const GLOBAL_DIRECTORIES = ["patches/"];
const WORKSPACE_GLOBS = ["apps", "infra", "packages"];
const SINGLE_WORKSPACES = ["oxlint-plugin-t3code", "scripts"];
const LINTABLE = /\.(?:[cm]?[jt]sx?)$/;

export interface Workspace {
  readonly name: string;
  readonly directory: string;
  readonly workspaceDependencies: ReadonlyArray<string>;
}

export interface PrePushPlan {
  readonly affected: ReadonlyArray<string>;
  readonly typecheck: ReadonlyArray<string>;
  readonly tests: ReadonlyArray<string>;
  readonly lintFiles: ReadonlyArray<string>;
}

function owningWorkspace(file: string, workspaces: ReadonlyArray<Workspace>) {
  let owner: Workspace | undefined;
  for (const workspace of workspaces) {
    if (!file.startsWith(`${workspace.directory}/`)) continue;
    if (!owner || workspace.directory.length > owner.directory.length) owner = workspace;
  }
  return owner;
}

/** Decides what to check from the files a push changes. Pure, so it is tested directly. */
export function planPrePush(input: {
  readonly changedFiles: ReadonlyArray<string>;
  readonly workspaces: ReadonlyArray<Workspace>;
}): PrePushPlan {
  const files = input.changedFiles.filter((file) => !file.endsWith(".md"));
  const global = files.some(
    (file) =>
      GLOBAL_FILES.has(file) || GLOBAL_DIRECTORIES.some((directory) => file.startsWith(directory)),
  );
  const changed = new Set<string>();
  for (const file of files) {
    const owner = owningWorkspace(file, input.workspaces);
    if (owner) changed.add(owner.name);
  }

  const affected = new Set(global ? input.workspaces.map((workspace) => workspace.name) : changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const workspace of input.workspaces) {
      if (affected.has(workspace.name)) continue;
      if (workspace.workspaceDependencies.some((dependency) => affected.has(dependency))) {
        affected.add(workspace.name);
        grew = true;
      }
    }
  }

  const names = [...affected].toSorted();
  return {
    affected: names,
    typecheck: names.filter((name) => TYPECHECK_GATED.has(name)),
    tests: names.filter((name) => !TESTS_NOT_GATED.has(name)),
    lintFiles: files.filter((file) => LINTABLE.test(file)),
  };
}

export interface LintDiagnostic {
  readonly message: string;
  readonly code: string;
  readonly severity: string;
  readonly filename: string;
  readonly labels: ReadonlyArray<{ readonly span: { readonly line: number } }>;
}

/** Line numbers each file gains in a zero-context `git diff -U0`. */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const file = line.slice(4);
      lines = file === "/dev/null" ? undefined : new Set();
      if (lines) added.set(file.replace(/^b\//, ""), lines);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !lines) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let offset = 0; offset < count; offset++) lines.add(start + offset);
  }
  return added;
}

/**
 * Lint errors on lines the push adds. Files already carry errors from before the gate existed,
 * so only new ones block a push.
 */
export function newLintErrors(
  diagnostics: ReadonlyArray<LintDiagnostic>,
  addedLines: ReadonlyMap<string, ReadonlySet<number>>,
): Array<LintDiagnostic> {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      diagnostic.labels.some((label) => addedLines.get(diagnostic.filename)?.has(label.span.line)),
  );
}

const ZERO_SHA = /^0+$/;

/** Splits long file lists so a large push stays under the OS argument-length limit. */
function chunks<A>(items: ReadonlyArray<A>, size = 400): Array<ReadonlyArray<A>> {
  const out: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

function git(repoRoot: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  }).trim();
}

function gitSucceeds(repoRoot: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, stdio: "ignore" }).status === 0;
}

function readWorkspaces(repoRoot: string): Array<Workspace> {
  const directories = [
    ...WORKSPACE_GLOBS.flatMap((parent) =>
      NodeFS.readdirSync(NodePath.join(repoRoot, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`),
    ),
    ...SINGLE_WORKSPACES,
  ].filter((directory) => NodeFS.existsSync(NodePath.join(repoRoot, directory, "package.json")));
  const manifests = directories.map((directory) => ({
    directory,
    manifest: JSON.parse(
      NodeFS.readFileSync(NodePath.join(repoRoot, directory, "package.json"), "utf8"),
    ) as {
      readonly name: string;
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
    },
  }));
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  return manifests.map(({ directory, manifest }) => ({
    name: manifest.name,
    directory,
    workspaceDependencies: Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).filter((dependency) => names.has(dependency)),
  }));
}

/** The commit each pushed branch is compared against: what the remote has, else the fork point. */
function pushBase(repoRoot: string, remote: string, localSha: string, remoteSha: string) {
  if (!ZERO_SHA.test(remoteSha) && gitSucceeds(repoRoot, ["cat-file", "-e", remoteSha])) {
    return git(repoRoot, ["merge-base", localSha, remoteSha]);
  }
  for (const ref of [`refs/remotes/${remote}/main`, "refs/remotes/origin/main"]) {
    if (gitSucceeds(repoRoot, ["rev-parse", "--verify", "--quiet", ref])) {
      return git(repoRoot, ["merge-base", localSha, ref]);
    }
  }
  return undefined;
}

function run(repoRoot: string, label: string, args: ReadonlyArray<string>) {
  const command = NodePath.join(repoRoot, "node_modules", ".bin", "vp");
  console.log(`\npre-push: ${label}`);
  const result = NodeChildProcess.spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    console.error(`\npre-push: ${label} failed. Fix it, or bypass once with git push --no-verify.`);
    process.exit(result.status ?? 1);
  }
}

function lintAddedLines(
  repoRoot: string,
  base: string,
  head: string,
  files: ReadonlyArray<string>,
) {
  console.log("\npre-push: lint (changed lines)");
  const diagnostics: Array<LintDiagnostic> = [];
  const added = new Map<string, Set<number>>();
  for (const batch of chunks(files)) {
    const result = NodeChildProcess.spawnSync(
      NodePath.join(repoRoot, "node_modules", ".bin", "vp"),
      ["lint", "--format", "json", ...batch],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    try {
      diagnostics.push(
        // A batch of only ignored files prints a notice before the JSON report.
        ...(
          JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
            diagnostics: ReadonlyArray<LintDiagnostic>;
          }
        ).diagnostics,
      );
    } catch {
      console.error(result.error?.message ?? "", result.stdout, result.stderr);
      console.error(
        "\npre-push: lint did not run. Fix it, or bypass once with git push --no-verify.",
      );
      process.exit(1);
    }
    for (const [file, lines] of parseAddedLines(
      git(repoRoot, ["diff", "-U0", `${base}...${head}`, "--", ...batch]),
    )) {
      added.set(file, lines);
    }
  }
  const errors = newLintErrors(diagnostics, added);
  for (const error of errors) {
    console.error(
      `${error.filename}:${error.labels[0]?.span.line}: ${error.code} ${error.message}`,
    );
  }
  if (errors.length > 0) {
    console.error(
      `\npre-push: ${errors.length} lint error(s) on changed lines. Fix them, or bypass once with git push --no-verify.`,
    );
    process.exit(1);
  }
}

function main() {
  // Git runs hooks with GIT_DIR and friends pointing at this repository. Checks inherit them,
  // so a test that runs git in a scratch directory would otherwise commit, branch and set config
  // here instead. Our own git calls find the repository from the working directory.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) delete process.env[key];
  }
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const remote = process.argv[2] ?? "origin";
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const pushes = NodeFS.readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (fields): fields is [string, string, string, string] =>
        fields.length === 4 && !ZERO_SHA.test(fields[1]!) && fields[2]!.startsWith("refs/heads/"),
    );
  if (pushes.length === 0) return;

  const changedFiles = new Set<string>();
  let base: string | undefined;
  for (const [localRef, localSha, , remoteSha] of pushes) {
    if (localSha !== head) {
      console.error(
        `pre-push: ${localRef} is not the checked-out commit, and checks run against the working tree. Check it out first, or push with --no-verify.`,
      );
      process.exit(1);
    }
    const pushBaseSha = pushBase(repoRoot, remote, localSha, remoteSha);
    if (!pushBaseSha) {
      console.error(
        `pre-push: could not find what ${localRef} is based on; fetch ${remote} first.`,
      );
      process.exit(1);
    }
    base ??= pushBaseSha;
    for (const file of git(repoRoot, ["diff", "--name-only", `${pushBaseSha}...${localSha}`])
      .split("\n")
      .filter(Boolean)) {
      changedFiles.add(file);
    }
  }
  if (!gitSucceeds(repoRoot, ["diff", "--quiet", "HEAD"])) {
    console.warn("pre-push: uncommitted changes are included in these checks.");
  }

  const plan = planPrePush({
    changedFiles: [...changedFiles],
    workspaces: readWorkspaces(repoRoot),
  });
  if (plan.affected.length === 0 && plan.lintFiles.length === 0) {
    console.log("pre-push: no workspace changes to check.");
    return;
  }
  console.log(`pre-push: checking ${plan.affected.join(", ") || "changed files"}`);

  const existingLintFiles = plan.lintFiles.filter((file) =>
    NodeFS.existsSync(NodePath.join(repoRoot, file)),
  );
  if (existingLintFiles.length > 0) {
    for (const batch of chunks(existingLintFiles)) {
      run(repoRoot, "format", ["fmt", "--check", "--no-error-on-unmatched-pattern", ...batch]);
    }
    lintAddedLines(repoRoot, base!, head, existingLintFiles);
  }
  const filters = (names: ReadonlyArray<string>) => names.flatMap((name) => ["--filter", name]);
  if (plan.typecheck.length > 0) {
    run(repoRoot, "typecheck", ["run", "--cache", ...filters(plan.typecheck), "typecheck"]);
  }
  const runTests = (names: ReadonlyArray<string>, cache: boolean) => {
    if (names.length === 0) return;
    // One package at a time, so suites do not compete for cores.
    run(repoRoot, "tests", [
      "run",
      ...(cache ? ["--cache"] : []),
      "--concurrency-limit",
      "1",
      ...filters(names),
      "test",
      // Workers share one Vite transform server; past half the cores, cold imports queue up
      // behind each other and trip hook timeouts in large suites such as web's.
      "--maxWorkers=50%",
      ...TEST_FILES_NOT_GATED.flatMap((pattern) => ["--exclude", pattern]),
    ]);
  };
  runTests(
    plan.tests.filter((name) => !TESTS_NOT_CACHED.has(name)),
    true,
  );
  runTests(
    plan.tests.filter((name) => TESTS_NOT_CACHED.has(name)),
    false,
  );
  console.log("\npre-push: all checks passed.");
}

if (import.meta.main) main();
