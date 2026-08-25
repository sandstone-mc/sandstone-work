/**
 * Link/unlink local packages for development using bun link.
 *
 * Usage:
 *   bun dev:link    - Link local packages for development
 *   bun dev:unlink  - Restore npm versions (fetches latest from registry)
 */

import { $ } from 'bun'
import { access, lstat, rm, symlink } from 'fs/promises'
import { join } from 'path'

const rootDir = join(import.meta.dir, '..')

interface PackageJson {
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

async function readPackageJson(dir: string): Promise<PackageJson> {
  return await Bun.file(join(dir, 'package.json')).json()
}

async function writePackageJson(dir: string, pkg: PackageJson): Promise<void> {
  await Bun.write(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * Resolve which npm dist-tag to restore against for a given package.
 *
 * - On master → `latest`
 * - On an archived `v{X}.{Y}.x` branch → `<pkg-name>-X-Y` (the per-minor
 *   dist-tag those patches publish to). The full version would be a valid
 *   SemVer range, which npm rejects as a tag name, so we prefix the
 *   package name and drop the dots (e.g. `sandstone-1-0`).
 * - Any other / unknown branch → fall back to `latest`
 */
async function getChannelForBranch(repoDir: string, packageName: string): Promise<'latest' | string> {
  try {
    const branch = (await $`git -C ${repoDir} rev-parse --abbrev-ref HEAD`.text()).trim()
    const m = branch.match(/^v(\d+)\.(\d+)\.x$/)
    if (m) {
      // v{X}.{Y}.x branch — figure out the minor it archives from its first tag.
      const tag = (await $`git -C ${repoDir} describe --tags --abbrev=0`.text()).trim()
      const tagMatch = tag.match(/^v(\d+)\.(\d+)/)
      if (tagMatch) {
        // strip the npm scope so `link:@sandstone-mc/...` resolves to the
        // unscoped dist-tag namespace (npm doesn't preserve scope in tags)
        const unscoped = packageName.replace(/^@[^/]+\//, '')
        return `${unscoped}-${tagMatch[1]}-${tagMatch[2]}`
      }
    }
  } catch {
    // fall through
  }
  return 'latest'
}

/**
 * Ensure a `patches/` symlink exists in the consumer directory, pointing at
 * the patched package's `patches/` directory.
 *
 * Bun resolves `patchedDependencies` paths relative to the install cwd, not
 * the patched package's root. When linking sandstone into a consumer (cli /
 * template), `bun link sandstone --save` runs from the consumer cwd, so
 * `patches/...` resolves there. A symlink makes those paths findable without
 * duplicating files. Idempotent: leaves an existing `patches/` entry alone.
 */
async function ensurePatchesSymlink(consumerDir: string, patchesTarget: string): Promise<void> {
  const linkPath = join(consumerDir, 'patches')
  try {
    await lstat(linkPath)
    return
  } catch {
    // not present
  }
  await symlink(patchesTarget, linkPath)
  console.log(`Linked ${linkPath} -> ${patchesTarget}`)
}

/**
 * Fetch a version from a specific npm dist-tag for the given package.
 * Returns the version prefixed with the given range operator for use in package.json.
 *
 * `~` (not `^`) is intentional for `sandstone` in the template/demo:
 * `^1.1.20` resolves to `>=1.1.20 <2.0.0`, so a fresh install on an archived
 * branch (e.g. v1.1.x) would pull whatever's latest in the major — currently
 * 1.2.x. `~1.1.20` resolves to `>=1.1.20 <1.2.0`, keeping the install on the
 * archived minor until the next template:update pass advances the spec.
 * Everything else (cli, mcdoc-ts-generator, etc.) gets `^`.
 *
 * Returns null when the dist-tag is missing (e.g. a per-minor tag like
 * `sandstone-1-0` that hasn't been published yet), so the caller can
 * fall back to `latest` instead of erroring.
 */
async function getNpmVersionForChannel(packageName: string, channel: string, prefix: '~' | '^' = '^'): Promise<string | null> {
  // The shortcut endpoint `/-/v1/tags/<tag>/package/<pkg>` returns 404
  // even for tags that exist on the registry, so look up the package
  // directly and pull the dist-tags map.
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch package metadata for ${packageName}: ${response.statusText}`)
  }
  const data = await response.json() as { 'dist-tags'?: Record<string, string> }
  const version = data['dist-tags']?.[channel]
  return version === undefined ? null : `${prefix}${version}`
}

/**
 * Restore a package.json dep to the version published on the channel that
 * matches the current git branch of that repo (master → latest, v*.x →
 * per-minor dist-tag). Falls back to `latest` if the per-minor tag hasn't
 * been published yet. `prefix` controls the SemVer range operator (`^` by
 * default, `~` for the `sandstone` dep in the template/demo).
 */
async function getRestoreVersion(repoDir: string, packageName: string, prefix: '~' | '^' = '^'): Promise<string> {
  const channel = await getChannelForBranch(repoDir, packageName)
  const versioned = await getNpmVersionForChannel(packageName, channel, prefix)
  if (versioned !== null) return versioned
  const fallback = await getNpmVersionForChannel(packageName, 'latest', prefix)
  if (fallback === null) {
    throw new Error(`Neither '${channel}' nor 'latest' dist-tag exists for ${packageName}`)
  }
  console.warn(`⚠️  ${packageName} has no '${channel}' dist-tag yet; falling back to 'latest' (${fallback})`)
  return fallback
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isLinked(version: string | undefined): boolean {
  return version?.startsWith('link:') || version?.startsWith('file:') || false
}

async function deleteNodeModule(packageDir: string, moduleName: string): Promise<void> {
  const modulePath = join(packageDir, 'node_modules', moduleName)
  if (await directoryExists(modulePath)) {
    await rm(modulePath, { recursive: true, force: true })
  }
}

function getDirs() {
  return {
    sandstoneDir: join(rootDir, 'sandstone'),
    cliDir: join(rootDir, 'sandstone-cli'),
    templateDir: join(rootDir, 'sandstone-template'),
    demoDir: join(rootDir, 'sandstone-demo'),
    mcdocTsGenDir: join(rootDir, 'mcdoc-ts-generator'),
  }
}

async function getLinkState() {
  const { sandstoneDir, cliDir, templateDir, demoDir } = getDirs()

  const [sandstonePkg, cliPkg, templatePkg, demoPkg] = await Promise.all([
    readPackageJson(sandstoneDir),
    readPackageJson(cliDir),
    readPackageJson(templateDir),
    readPackageJson(demoDir),
  ])

  const sandstoneMcdocLinked = isLinked(sandstonePkg.devDependencies?.['@sandstone-mc/mcdoc-ts-generator'])
  const cliSandstoneLinked = isLinked(cliPkg.devDependencies?.sandstone)
  const templateSandstoneLinked = isLinked(templatePkg.dependencies?.sandstone)
  const templateCliLinked = isLinked(templatePkg.devDependencies?.['sandstone-cli'])
  const demoSandstoneLinked = isLinked(demoPkg.dependencies?.sandstone)

  return {
    sandstonePkg,
    cliPkg,
    templatePkg,
    demoPkg,
    sandstoneMcdocLinked,
    cliSandstoneLinked,
    templateSandstoneLinked,
    templateCliLinked,
    demoSandstoneLinked,
    cliLinked: cliSandstoneLinked,
    templateLinked: templateSandstoneLinked || templateCliLinked,
    demoLinked: demoSandstoneLinked,
  }
}

async function link() {
  const { sandstoneDir, cliDir, templateDir, mcdocTsGenDir } = getDirs()
  const state = await getLinkState()
  const { sandstoneMcdocLinked, cliSandstoneLinked, cliLinked, templateLinked } = state

  if (cliLinked && templateLinked && sandstoneMcdocLinked) {
    console.log('Packages are already linked.')
    return
  }

  console.log('Linking local packages for development...\n')

  // Build packages if not already built
  const builds: Array<{ dir: string; outDir: string; label: string; cmd: string }> = [
    { dir: sandstoneDir, outDir: 'dist', label: 'sandstone', cmd: 'bun dev:build' },
    { dir: cliDir, outDir: 'lib', label: 'sandstone-cli', cmd: 'bun dev:build' },
    { dir: mcdocTsGenDir, outDir: 'dist', label: 'mcdoc-ts-generator', cmd: 'bun dev:build' },
  ]

  for (const { dir, outDir, label, cmd } of builds) {
    if (await directoryExists(join(dir, outDir))) {
      console.log(`${label} already built, skipping...\n`)
    } else {
      console.log(`Building ${label}...`)
      await $`${cmd.split(' ')}`.cwd(dir)
      console.log(`${label} built\n`)
    }
  }

  // Register packages globally with bun link
  for (const { dir, label } of builds) {
    console.log(`Registering ${label}...`)
    await $`bun link`.cwd(dir)
  }

  // Link dependencies
  if (!sandstoneMcdocLinked) {
    console.log('\nLinking mcdoc-ts-generator into sandstone...')
    await $`bun link @sandstone-mc/mcdoc-ts-generator --save`.cwd(sandstoneDir)
  }

  if (!cliSandstoneLinked) {
    console.log('\nLinking sandstone into sandstone-cli...')
    await ensurePatchesSymlink(cliDir, '../sandstone/patches')
    await $`bun link sandstone --save`.cwd(cliDir)
  }

  if (!state.templateSandstoneLinked || !state.templateCliLinked) {
    console.log('\nLinking packages into sandstone-template...')
    if (!state.templateSandstoneLinked) {
      await ensurePatchesSymlink(templateDir, '../sandstone/patches')
      await $`bun link sandstone --save`.cwd(templateDir)
    }
    if (!state.templateCliLinked) await $`bun link sandstone-cli --save`.cwd(templateDir)
  }

  console.log('\nAll packages linked for local development!')
  console.log('')
  console.log('You can now:')
  console.log('  cd sandstone-template && bun dev:build')
  console.log('')
  console.log('To restore npm versions before committing:')
  console.log('  bun dev:unlink')
}

async function unlink() {
  const { sandstoneDir, cliDir, templateDir, demoDir, mcdocTsGenDir } = getDirs()
  const state = await getLinkState()
  const { sandstonePkg, cliPkg, templatePkg, demoPkg, sandstoneMcdocLinked, cliSandstoneLinked, cliLinked, templateLinked, templateSandstoneLinked, templateCliLinked, demoLinked, demoSandstoneLinked } = state

  if (!cliLinked && !templateLinked && !sandstoneMcdocLinked && !demoLinked) {
    console.log('Packages are already unlinked.')
    return
  }

  console.log('Unlinking local packages...\n')

  // Unregister packages globally
  for (const [label, dir] of [
    ['sandstone', sandstoneDir],
    ['sandstone-cli', cliDir],
    ['mcdoc-ts-generator', mcdocTsGenDir],
  ] as const) {
    console.log(`Unregistering ${label}...`)
    await $`bun unlink`.cwd(dir).nothrow()
  }

  // Fetch restore versions from npm (branch-aware: master → latest, v*.x → per-minor dist-tag).
  // `~` only for `sandstone` in the template/demo (keeps archived-minor installs on the
  // archived minor). Everything else gets `^`.
  console.log('\nFetching versions from npm (channel depends on current branch)...')
  const [sandstoneVersionForCli, sandstoneVersionForTemplate, sandstoneVersionForDemo, cliVersion, mcdocTsGenVersion] = await Promise.all([
    getRestoreVersion(sandstoneDir, 'sandstone', '^'),
    getRestoreVersion(sandstoneDir, 'sandstone', '~'),
    getRestoreVersion(sandstoneDir, 'sandstone', '~'),
    getRestoreVersion(cliDir, 'sandstone-cli', '^'),
    getRestoreVersion(mcdocTsGenDir, '@sandstone-mc/mcdoc-ts-generator', '^')
  ])
  console.log(`  sandstone (cli):       ${sandstoneVersionForCli}`)
  console.log(`  sandstone (template):  ${sandstoneVersionForTemplate}`)
  console.log(`  sandstone (demo):      ${sandstoneVersionForDemo}`)
  console.log(`  sandstone-cli:         ${cliVersion}`)
  console.log(`  @sandstone-mc/mcdoc-ts-generator: ${mcdocTsGenVersion}`)

  // Restore sandstone
  if (sandstoneMcdocLinked) {
    console.log('\nRestoring sandstone...')
    sandstonePkg.devDependencies!['@sandstone-mc/mcdoc-ts-generator'] = mcdocTsGenVersion
    await writePackageJson(sandstoneDir, sandstonePkg)
    await deleteNodeModule(sandstoneDir, '@sandstone-mc/mcdoc-ts-generator')
    await $`bun install`.cwd(sandstoneDir)
  }

  // Restore sandstone-cli
  if (cliLinked) {
    console.log('\nRestoring sandstone-cli...')
    if (cliSandstoneLinked) {
      cliPkg.devDependencies!.sandstone = sandstoneVersionForCli
      await deleteNodeModule(cliDir, 'sandstone')
    }
    await writePackageJson(cliDir, cliPkg)
    await $`bun install`.cwd(cliDir)
  }

  // Restore sandstone-template
  if (templateLinked) {
    console.log('\nRestoring sandstone-template...')
    if (templateSandstoneLinked) {
      templatePkg.dependencies!.sandstone = sandstoneVersionForTemplate
      await deleteNodeModule(templateDir, 'sandstone')
    }
    if (templateCliLinked) {
      templatePkg.devDependencies!['sandstone-cli'] = cliVersion
      await deleteNodeModule(templateDir, 'sandstone-cli')
    }
    await writePackageJson(templateDir, templatePkg)
    await $`bun install`.cwd(templateDir)
  }

  // Restore sandstone-demo
  if (demoLinked) {
    console.log('\nRestoring sandstone-demo...')
    if (demoSandstoneLinked) {
      demoPkg.dependencies!.sandstone = sandstoneVersionForDemo
      await deleteNodeModule(demoDir, 'sandstone')
    }
    await writePackageJson(demoDir, demoPkg)
    await $`bun install`.cwd(demoDir)
  }

  console.log('\nAll packages restored to npm versions!')
  console.log('Ready for git commit/push.')
}

async function main() {
  const command = process.argv[2]

  if (command === 'link') {
    await link()
  } else if (command === 'unlink') {
    await unlink()
  } else {
    console.log('Usage: bun dev:link|unlink')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
