# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts) and
[Tailwind plugin](../../apps/web/vite/tailwind.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Use `vp run lint:mobile` for native mobile changes.

### Pre-push gate

The fork runs no CI; its test workflows are disabled in GitHub. Instead
[pre-push.ts](../../scripts/pre-push.ts) runs on every `git push` for the workspaces the pushed
commits change and the workspaces that depend on them: format on the changed files, lint on the
changed lines, typecheck, and tests. Unchanged packages replay their last passing result from the
`vp run --cache` task cache in `node_modules/.vite/task-cache`, so it stays fast after the first
run in a checkout. The cache is per checkout; a new worktree warms its own.

- Server tests are not gated yet: the suite takes over half an hour and still has failures
  from before the gate. Run `vp test run <files>` for what you touch.
- Lint blocks only errors on lines the push adds, because many files still carry older
  errors.
- Typecheck covers the workspaces listed in `TYPECHECK_GATED`; add a workspace there once it
  typechecks cleanly.
- Checks run against the working tree, so push the checked-out branch.
- A test that writes files inside its own package can't be cached; keep test scratch files in
  the OS temp directory.
- `git push --no-verify` bypasses the gate for one push.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. The pre-push gate does not run it yet; knip still has findings on `main`.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Shared Android build caches

A cold Android build takes about an hour, almost all of it compiling NDK C++. Maintainers run many
worktrees at once, and pnpm gives each one its own `node_modules`, so without shared caches every
worktree pays that hour again. Two host-level caches avoid it, and they solve different halves of
the problem:

- **Gradle's local build cache** reuses JVM, resource, and dex task outputs. It lives in the Gradle
  user home, not the project, so it is shared across worktrees as soon as it is enabled.
  `withAndroidBuildCache.cjs` sets `org.gradle.caching` in the generated `gradle.properties`.
- **ccache** reuses the compiled NDK objects, which Gradle cannot: `externalNativeBuild` tasks are
  not cacheable. Install it once per machine (`sudo apt install ccache`, or Homebrew on macOS).
  `mobile-native-client.ts` detects it and warns when it is absent.

ccache only shares across worktrees because the build sets `CCACHE_BASEDIR` to the checkout root,
which rewrites checkout-absolute paths to be relative before hashing, and relaxes the timestamp
comparisons that differ between two pnpm copies of the same dependency. The Android NDK lives
outside any checkout, so a toolchain change stays a miss, which is what you want. Precompiled
headers are the exception to that path rewriting: they live under AGP's `.cxx/<variant>/<hash>`
directory, whose hash derives from the absolute project path, so the same plugin turns PCH off for
ccache builds. Leaving it on drops cross-worktree hits to about half. Those settings are only read
when CMake configures, so a worktree that already configured `.cxx` before ccache was installed
keeps missing until the next prebuild regenerates its native project.

Do not try to share anything else. The generated `apps/mobile/android/` tree and its `.gradle`,
`build`, and `.cxx` directories record absolute paths; symlinking or copying them between worktrees
produces builds that fail in confusing ways. Keep them per-worktree and let the content-addressed
caches carry the work across.

Inspect effectiveness with `ccache -s`. Cleaning is a last resort, not routine hygiene: see the
incremental-build rule in [AGENTS.md](../../AGENTS.md).

## Machine-local worktree setup

Set `t3.beforeWorktreeCreate` with `git config --local` to a shell command that prepares the
source checkout before T3 creates a worktree, and `t3.afterWorktreeCreate` to initialize the new
checkout after submodules are populated. They run at the corresponding checkout root using Git's
shell-alias execution. T3 waits for each command, with a ten-minute timeout, before proceeding.
A nonzero exit fails creation; the thread launch flow owns rollback once the new checkout has
been claimed. Linked checkouts share the repository's local Git configuration, so the hooks
apply to every checkout without committing machine-specific commands. Keep dependency installs
in these hooks or in a project action, rather than running the same setup in both.

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
