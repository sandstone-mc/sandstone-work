# Old Sandstone Pipeline

Documentation of the legacy build pipeline (for sandstone@1.0.0-beta.0) used prior to the upcoming refactor.

## Overview

The old pipeline uses a three-package architecture:
- **sandstone** — Core library that defines resources and compiles them
- **sandstone-cli** — Command-line interface (`sand build`, `sand watch`)
- **sandstone-build** — Build orchestration spawned as a subprocess by the CLI

## Template Structure

```
project/
├── src/
│   ├── index.ts          # Entry point, exports sandstonePack
│   └── *.ts              # User's pack code
├── resources/            # Static assets copied to output
│   └── .exists
├── sandstone.config.ts   # Pack configuration
├── tsconfig.json
├── package.json
└── pnpm-lock.yaml
```

## Dependencies

```json
{
  "devDependencies": {
    "@types/node": "^20.8.6",
    "sandstone-build": "^1.0.8",
    "sandstone-cli": "^1.1.11",
    "ts-node": "^10.9.1",
    "typescript": "^5.2.2"
  },
  "dependencies": {
    "sandstone": "1.0.0-beta.0"
  }
}
```

## Configuration

### sandstone.config.ts

```typescript
import type { DatapackConfig, ResourcePackConfig, SandstoneConfig } from 'sandstone'

export default {
  name: 'template',
  packs: {
    datapack: {
      description: [ 'A ', { text: 'Sandstone', color: 'gold' }, ' datapack.' ],
      packFormat: 19,
    } as DatapackConfig,
    resourcepack: {
      description: [ 'A ', { text: 'Sandstone', color: 'gold' }, ' resource pack.' ],
      packFormat: 18,
    } as ResourcePackConfig
  },
  onConflict: {
    default: 'warn',
  },
  namespace: 'default',
  packUid: 'kZZpDK67',
  mcmeta: 'latest',
  saveOptions: {},
} as SandstoneConfig
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "declaration": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ESNext",
    "lib": ["ESNext"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "noEmit": true,
    "skipLibCheck": true,
    "outDir": "lib",
    "forceConsistentCasingInFileNames": true,
    "allowImportingTsExtensions": true
  },
  "ts-node": {
    "esm": true
  },
  "include": ["sandstone.config.ts", "src"]
}
```

## Entry Point Pattern

### src/index.ts

```typescript
import { sandstonePack } from 'sandstone'
import './display.ts'

export default sandstonePack
```

The entry point:
1. Imports the singleton `sandstonePack` from sandstone
2. Imports all user code (side-effect imports that register resources)
3. Re-exports `sandstonePack` for the build system to call `.save()`

## Build Flow

### 1. CLI Invocation

```
sand build [options]
sand watch [options]
```

**Options:**
- `--dry` — Don't write files
- `--verbose` — Extra logging
- `--root` — Save to `.minecraft/datapacks` instead of a world
- `--production` — Production build (no client/server export)
- `--path <path>` — Project path
- `--name <name>` — Override pack name
- `--namespace <ns>` — Override default namespace
- `--world <world>` — Target world name
- `--clientPath <path>` — Custom .minecraft path
- `--serverPath <path>` — Server export path

### 2. CLI → Build Handoff

The CLI (`sandstone-cli`) spawns `sandstone-build` as a child process:

```typescript
const build = fork(
  path.join(folders.rootFolder, 'node_modules', 'sandstone-build', 'lib', 'index.js'),
  process.argv.slice(2),
  {
    stdio: 'pipe',
    env: {
      NODE_OPTIONS: "--loader ts-node/esm",
      CLI_OPTIONS: JSON.stringify(opts),
      PROJECT_FOLDERS: JSON.stringify(folders),
    }
  }
)
```

### 3. Build Process

`sandstone-build` performs these steps:

1. **Register ts-node** for TypeScript execution
2. **Load sandstone.config.ts** to get pack configuration
3. **Set environment variables** used by the sandstone library:
   - `SANDSTONE_ENV` — 'production' or 'development'
   - `WORKING_DIR` — Absolute project path
   - `PACK_UID` — Unique pack identifier
   - `NAMESPACE` — Default namespace
   - `PACK_OPTIONS` — JSON-serialized pack configs
   - `INDENTATION` — JSON indentation setting
   - `*_CONFLICT_STRATEGY` — Per-resource conflict handling

4. **Run beforeAll script** (if defined in config)
5. **Import src/index.ts** — This executes all user code and registers resources
6. **Run beforeSave script** (if defined)
7. **Call sandstonePack.save()** with file handler

### 4. Save Process

`sandstonePack.save()` in the sandstone library:

```typescript
save = async (cliOptions) => {
  await this.core.save(cliOptions, {
    visitors: [
      // Initialization visitors
      new InitObjectivesVisitor(this),
      new InitConstantsVisitor(this),
      new GenerateLazyMCFunction(this),

      // Transformation visitors
      new LoopTransformationVisitor(this),
      new IfElseTransformationVisitor(this),
      new ContainerCommandsToMCFunctionVisitor(this),

      // Special visitors
      new AwaitBodyVisitor(this),

      // Optimization
      new InlineFunctionCallVisitor(this),
      new UnifyChainedExecutesVisitor(this),
      new SimplifyExecuteFunctionVisitor(this),
      new SimplifyReturnRunFunctionVisitor(this),
    ],
  })
  return this.packTypes
}
```

The visitors transform the AST:
- Initialize objectives and constants
- Generate lazy MCFunctions
- Transform loops and if/else to MCFunction calls
- Handle async/await patterns
- Inline simple function calls
- Optimize execute chains

### 5. Output Handling

Build outputs to `.sandstone/output/`:
```
.sandstone/
├── output/
│   ├── datapack/
│   │   ├── pack.mcmeta
│   │   └── data/
│   │       └── <namespace>/
│   │           └── function/
│   │               └── *.mcfunction
│   └── resourcepack/
│       ├── pack.mcmeta
│       └── assets/
└── cache.json           # File hash cache for incremental builds
```

### 6. Export Destinations

**Development mode:**
- **World:** `<.minecraft>/saves/<world>/datapacks/<packName>`
- **Root:** `<.minecraft>/datapacks/<packName>`
- **Server:** Custom server path

**Production mode:**
- Only writes to `.sandstone/output/`
- Creates ZIP archives

### 7. Caching

Uses MD5 hashes to skip unchanged files:
```typescript
const hashValue = hash(content + relativePath)
newCache[relativePath] = hashValue

if (cache[relativePath] === hashValue) {
  return // Skip - unchanged
}
```

### 8. Watch Mode

Uses chokidar to watch for changes:
- `src/**/*`
- `sandstone.config.ts`
- `package.json`
- `tsconfig.json`

Debounces changes (200ms) and rebuilds.

## Lantern Load Integration

The pack automatically integrates with Lantern Load for load ordering:

```typescript
setupLantern = () => {
  const loadStatus = this.Objective.create('load.status')

  const privateInit = this.Tag('functions', 'load:_private/init', [...])
  const privateLoad = this.Tag('functions', 'load:_private/load', [
    privateInit,
    { id: this.loadTags.preLoad, required: false },
    { id: this.loadTags.load, required: false },
    { id: this.loadTags.postLoad, required: false },
  ])

  this.Tag('functions', 'minecraft:load', [privateLoad])
}
```

## GitHub Actions (Optional)

The template includes a disabled workflow that builds and pushes to a `generated` branch:

```yaml
name: Build Sandstone pack
on: push

jobs:
  build_pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - run: |
          npm i
          npm run build
      - run: |
          git worktree add gen generated
          rm -rf gen/*
          mv ./.sandstone/* gen
          cd gen
          git add -A ./output
          git commit -m 'Updated Pack files'
      - uses: ad-m/github-push-action@master
        with:
          directory: gen
          branch: generated
```

## Key Characteristics

1. **Singleton pattern** — `sandstonePack` is a global singleton
2. **Side-effect imports** — User code runs on import, registering resources
3. **Environment-based config** — Heavy use of `process.env` for configuration
4. **Subprocess architecture** — CLI spawns build process with ts-node loader
5. **Visitor-based compilation** — AST transformation through visitor pattern
6. **Incremental builds** — Hash-based caching for unchanged files
7. **Symlink support** — Unix systems use symlinks for faster exports
