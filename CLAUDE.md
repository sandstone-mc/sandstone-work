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
| `hot-hook` | `hot-hook/` | Fork of hot-hook with Bun support for HMR during dev | bun |
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

Template branches follow semver: `pack-X.Y.Z` or `library-X.Y.Z`. The script finds the highest version and checks it out.

### `bun dev:link` / `bun dev:unlink` — Local Package Linking

Links local packages together for development so changes propagate without publishing.

```bash
bun dev:link      # Link local packages for development
bun dev:unlink    # Restore npm versions (fetches latest from registry)
```

**Link chain:**
```
mcdoc-ts-generator → sandstone (devDependency)
sandstone → sandstone-cli (devDependency)
hot-hook → sandstone-cli (dependency)
sandstone + sandstone-cli → sandstone-template (dependencies)
```

When linked:
- Builds each package if not already built (`dist/`, `lib/`, or `build/` missing)
- Registers packages globally with `bun link`
- Links dependencies between packages with `bun link <package> --save`

Always run `bun dev:unlink` before committing changes to any package.json files.

### `bun dev:build-lib` — Build Core Library

Quick shortcut to rebuild the sandstone library:

```bash
bun dev:build-lib    # Equivalent to: cd sandstone && bun dev:build
```

## Development Workflow

### Iterating on the Core Library

1. Run `bun run setup` to clone all repos
2. Run `bun dev:template` to checkout a template branch
3. Run `bun dev:link` to link packages locally
4. Make changes in `sandstone/src/`
5. Rebuild with `bun dev:build-lib`
6. Test in `sandstone-template/` with `bun dev:build`
7. Before committing: `bun dev:unlink` in workspace root

### Iterating on the CLI

1. Make changes in `sandstone-cli/src/`
2. Rebuild with `cd sandstone-cli && bun dev:build`
3. Test in `sandstone-template/` in the background with `bun dev:watch` (uses the CLI's watch mode)

### Iterating on Type Generation

1. Make changes in `mcdoc-ts-generator/src/`
2. (Optional) Run `bun compile` in mcdoc-ts-generator to verify changes in local `types/` directory
3. Build the generator: `cd mcdoc-ts-generator && bun dev:build`
4. Update sandstone types: `cd sandstone && bun update-from-mcdoc`
5. Rebuild sandstone: `bun dev:build-lib`

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
- `hot-hook` → npm `@sandstone-mc/hot-hook`
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
