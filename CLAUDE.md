# Sandstone Workspace

Multi-package monorepo for the Sandstone ecosystem — a TypeScript library for creating Minecraft datapacks and resource packs.

## Projects

| Project | Purpose | Package Manager |
|---------|---------|-----------------|
| `sandstone` | Core library for datapacks/resource packs | bun |
| `mcdoc-ts-generator` | Generates TypeScript types from Minecraft mcdoc schemas | bun |
| `sandstone-cli` | CLI tool (`sand`, `create-sandstone` commands) | bun |
| `sandstone-build` | Build component for the CLI - being phased out | pnpm |
| `sandstone-documentation` | Docusaurus documentation site - to be migrated to bun | npm |
| `sandstone-libraries` | Official add-on libraries (pnpm workspace, to be migrated to bun) | pnpm |
| `sandstone-playground` | Browser-based interactive playground - to be migrated to bun | pnpm |
| `sandstone-template` | Starter templates (each template is a branch) | — |

## Workspace Structure

- Each project is an independent git repository with its own versioning
- Root `sandstone.code-workspace` ties them together for VS Code
- Root bun setup is for development scripts and workspace setup utilities

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

## Type Generation Pipeline

`mcdoc-ts-generator` produces auto-generated types consumed by the main `sandstone` library:
```
Minecraft mcdoc schemas → mcdoc-ts-generator → sandstone/src/arguments/generated/
```

When Minecraft updates, regenerate types before updating the core library.

## Node Requirements

- Main library: Node >= 22.13.1
- Documentation: Node >= 18.0
- All projects: TypeScript 5.x
