# Sandstone Workspace

Multi-package monorepo for the Sandstone ecosystem — a TypeScript library for creating Minecraft datapacks and resource packs.

## Agent Rules
1. Before launching an "Explore" process with sub-agent(s) and lots of token intake, get manual confirmation from the user that they want you to do that.
2. Be mindful of your CWD and form your `cd` calls accordingly
3. If you are getting errors from an IDE MCP Diagnostics call and they don't make any sense (or should have been fixed by changes you made), dont revert changes, just ask the user to restart the offending language server.
4. When the user has an IDE connected to you, always pay attention to what file they have open and what text they have selected.
5. Do not use `timeout` parameter in your Bash MCP, its buggy and breaks stuff. Let the user build if needed.
6. When you create a new source code file and you want to check it with IDE MCP, ask the user to open the file first, because usually vscode won't generate errors until the file is opened.
7. Do not use IDE MCP on Markdown files
8. Always check what operating system and shell you are running inside of and remember it.

## Projects

| Short Name | Folder | Purpose | Package Manager |
|------------|--------|---------|-----------------|
| `sandstone` | `sandstone/` | Core library for datapacks/resource packs | bun |
| `mcdoc-ts-generator` | `mcdoc-ts-generator/` | Generates TypeScript types from Minecraft mcdoc schemas | bun |
| `cli` | `sandstone-cli/` | CLI tool (`sand`, `create-sandstone` commands) | bun |
| `documentation` | `sandstone-documentation/` | Docusaurus documentation site (migrating to bun) | npm |
| `libraries` | `sandstone-libraries/` | Official add-on libraries (migrating to bun) | pnpm |
| `playground` | `sandstone-playground/` | Browser-based interactive playground | bun |
| `template` | `sandstone-template/` | Starter templates (each template is a branch) | bun |

All repos are under the `sandstone-mc` GitHub organization.

## Workspace Structure

- Each project is an independent git repository with its own versioning
- Root `sandstone.code-workspace` ties them together for VS Code multi-root workspaces
- Root bun setup is for development scripts and workspace setup utilities only
- `manifest.json` defines shortName-to-folder mappings for all repos
- `manifest.contribute.json` (gitignored) stores local contributor preferences

## Development Scripts

### `bun run setup` — Initial Setup

Clones/pulls all repos and installs dependencies.

```bash
bun run setup                          # Default: clone all from sandstone-mc
bun run setup --org MulverineX         # Use a different GitHub user/org (for forks)
bun run setup --skip documentation,playground  # Skip specific repos
bun run setup --only sandstone,cli,template    # Only include specific repos
```

What it does:
1. Pulls latest changes in root workspace
2. Updates `.gitignore` to exclude cloned repos
3. Updates `sandstone.code-workspace` with folder entries
4. Clones missing repos or pulls existing ones (skips if not on main/master or if using fork)
5. Runs `bun install` where `bun.lock` exists but `node_modules/` doesn't

### `bun dev:template` — Template Checkout

Prepares the template repo for development by checking out the latest versioned branch.

```bash
bun dev:template              # Checkout latest pack template (e.g., pack-0.9.0)
bun dev:template --library    # Checkout latest library template
```

Template branches are always `pack-X.Y.0` or `library-X.Y.0` (one branch per minor, the patch slot is always `0` — the template tracks the sandstone minor, not individual patches). The script finds the highest version and checks it out.

### `bun dev:minor` — Switch Minor Version

Switch sandstone + template to a different minor (current master or an archived `v{X}.x` branch). CLI / generator / libraries stay on master regardless.

```bash
bun dev:minor                # Interactive: pick a minor
bun dev:minor 1.0            # Switch to archived 1.0.x + pack-1.0.0
bun dev:minor 1.0 --library  # Switch to 1.0.x + library-1.0.0
```

Each candidate is listed **exactly once**. The currently-active minor in master appears as `Latest (master) → MC 26.{n}`; every remote `v{X}.x` branch appears as `{X} → MC 26.{m}`. The two never collide — a minor's `v*.x` branch only exists after that minor leaves master.

Just checks out + bun-installs; doesn't build or link. Run `bun dev:link` separately if needed.

### Branching & npm dist-tag Model

| Branch | npm dist-tag | Resolves to |
|--------|--------------|-------------|
| `master` (sandstone) | `latest` | Highest master version |
| `v1.0.x` (sandstone) | `v1.0` | Highest 1.0.x patch |
| `v1.1.x` (sandstone) | `v1.1` | Highest 1.1.x patch |
| future `v*.x` | `v{X}.{Y}` | Per-minor channel |

This keeps `sandstone@latest` pristine regardless of activity on archived branches. CLI (`sandstone-cli`) and generator (`@sandstone-mc/mcdoc-ts-generator`) are minor-agnostic — they only publish to `latest`.

### MC Version Correlation

Sandstone `1.{minor}.*` ↔ MC `(26 + floor(minor/4)).((minor % 4) + 1)`:

- `1.0.x` → MC 26.1
- `1.1.x` → MC 26.2
- `1.2.x` → MC 26.3
- `1.3.x` → MC 26.4
- `1.4.x` → MC 27.1
- `1.5.x` → MC 27.2
- … (4 MC bases per year)

Implemented inline in `scripts/sandstoneToMC.ts` (workspace) and `sandstone-cli/src/utils/sandstoneToMC.ts` (CLI). Major 2 is out of scope and will be added when shipped.

### Patch Auto-Increment + Minor Decision

Patches are auto-incremented within the current minor (the release script does this on tag collision). To cut a new minor:

1. Edit package.json to the next `X.Y.0` version
2. Run `bun release` and pick **"New minor release"** in the prompt (or pass `--minor` in CLI mode)
3. The release script also creates the previous-minor's archival branch (`v{X-1}.x`) and matching `pack/library-{X}.0` template branches

There are no prereleases (no alpha/beta/rc) — major 1 has shipped. Snapshots are ignored: even when MC is mid-snapshot-cycle, the next MC base is treated as already-released in sandstone's master.

### `bun dev:link` / `bun dev:unlink` — Local Package Linking

Links local packages together for development so changes propagate without publishing.

```bash
bun dev:link      # Link local packages for development
bun dev:unlink    # Restore npm versions (branch-aware: master → latest, v{X}.x → v{X}.{Y} dist-tag)
```

**Link chain:**
```
mcdoc-ts-generator → sandstone (devDependency)
sandstone → sandstone-cli (devDependency)
sandstone + sandstone-cli → sandstone-template (dependencies)
```

When linked:
- Builds each package if not already built (`dist/`, `lib/`, or `build/` missing)
- Registers packages globally with `bun link`
- Links dependencies between packages with `bun link <package> --save`

`bun dev:unlink` is **branch-aware**: when run on master it restores to npm `latest`; when run on an archived `v{X}.x` branch it restores each package to its `v{X}.{Y}` dist-tag (the per-minor channel those patches publish to). So `bun dev:link` / `bun dev:unlink` works correctly regardless of which minor branch you're on.

Always run `bun dev:unlink` before committing changes to any package.json files.

### Build Core Library

From the workspace root:

```bash
bun dev:build:library    # Equivalent to: cd sandstone && bun dev:build
```

From `sandstone/`:

```bash
bun dev:build
```

For the full inner-build → template-rebuild cycle (when iterating on
`sandstone/` against a template), the canonical command is the
`&&`-chained one-liner — chaining across `cd` works because each
command runs to completion before the next:

```bash
cd /var/home/mulverine/Workspaces/sandstone-work/sandstone && bun dev:build --silent && cd ../sandstone-template && bun dev:build
```

**`--silent` produces zero output on success.** No "Build completed" line, no summary, nothing. An empty result is the success signal. If you only see `$ bun run scripts/build.ts --silent` and a prompt, the build passed. Run without `--silent` to see the full pipeline log.

The `--silent` flag is for `sandstone`'s build (matches what the
project's own CLAUDE.md in `sandstone/` recommends); the template build
runs without it because its build output is useful to see (visitor
warnings, etc.).

## Development Workflow

### Iterating on the Core Library

1. Run `bun run setup` to clone all repos
2. Run `bun dev:template` to checkout a template branch (defaults to latest minor — e.g., `pack-1.1.0`)
3. Run `bun dev:link` to link packages locally
4. Make changes in `sandstone/src/`
5. From the workspace root, rebuild with `bun dev:build:library`
6. Test in `sandstone-template/` with `bun dev:build`
7. Before committing: `bun dev:unlink` in workspace root

**To iterate against an archived minor** (e.g., to patch v1.0.x): run `bun dev:minor 1.0` *before* `bun dev:link`. The link/unlink scripts are branch-aware — they restore to `sandstone@v1.0` (and friends) when checked out to that branch.

### Iterating on the CLI

1. Make changes in `sandstone-cli/src/`
2. Rebuild with `cd sandstone-cli && bun dev:build`
3. Test in `sandstone-template/` in the background with `bun dev:watch` (uses the CLI's watch mode)

### Iterating on Type Generation

1. Make changes in `mcdoc-ts-generator/src/`
2. (Optional) Run `bun compile` in mcdoc-ts-generator to verify changes in local `types/` directory
3. Build the generator: `cd mcdoc-ts-generator && bun dev:build`
4. Update sandstone types: `cd sandstone && bun update-from-mcdoc`
5. Rebuild sandstone from `sandstone/` with `bun dev:build` (or from the workspace root with `bun dev:build:library`)

**Tip:** Use `bun compile` to quickly inspect generated output in `types/` before committing to rebuild sandstone.

## Type Generation Pipeline

`mcdoc-ts-generator` produces auto-generated types consumed by the main `sandstone` library:

```
Minecraft mcdoc schemas (vanilla-mcdoc)
         ↓
    mcdoc-ts-generator
         ↓
    sandstone/src/arguments/generated/
```

Two output modes:
- **`bun compile`** (in mcdoc-ts-generator) → outputs to `types/` for inspection
- **`bun update-from-mcdoc`** (in sandstone) → outputs directly to sandstone's generated types

When Minecraft updates, regenerate types before updating the core library.

## Common Conventions

### TypeScript
- Strict mode enabled across all projects
- Target: ESNext with bundler module resolution
- Declaration files generated separately from bundles

### Linting
- OxLint (Rust-based, faster than ESLint)
- Config: `.oxlintrc.json` in each project
- Plugins: `@stylistic`, `typescript`, `unicorn`, `oxc`

### Package Publishing
- `sandstone` → npm `sandstone`
- `sandstone-cli` → npm `sandstone-cli`
- `mcdoc-ts-generator` → npm `@sandstone-mc/mcdoc-ts-generator`
- `sandstone-playground` → npm `@sandstone-mc/playground`
- `sandstone-libraries/*` → npm `@sandstone/*`

## VS Code Workspace

Open `sandstone.code-workspace` for multi-root workspace support. The workspace is configured to:
- Show each repo as a separate root folder in the explorer
- Hide repo folders from the "work" root (via `.vscode/settings.json`) to avoid duplication

## Individual Project Details

Each project has its own `CLAUDE.md` with project-specific guidance:
- `sandstone/CLAUDE.md` — Core library architecture, AST system, command implementation patterns
- `mcdoc-ts-generator/CLAUDE.md` — Type generation architecture, mcdoc handlers
- `sandstone-cli/CLAUDE.md` — CLI commands, launcher detection, test harness for interactive testing

## TODOs
- Migrate remaining projects (documentation, libraries) to bun
