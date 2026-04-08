/**
 * Link/unlink local packages for development using bun link.
 *
 * Usage:
 *   bun dev:link    - Link local packages for development
 *   bun dev:unlink  - Restore npm versions (fetches latest from registry)
 */

import { $ } from 'bun'
import { access, rm } from 'fs/promises'
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

async function getLatestNpmVersion(packageName: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`)
  if (!response.ok) {
    throw new Error(`Failed to fetch latest version for ${packageName}: ${response.statusText}`)
  }
  const data = await response.json() as { version: string }
  return `^${data.version}`
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
    hotHookDir: join(rootDir, 'hot-hook', 'packages', 'hot_hook'),
    mcdocTsGenDir: join(rootDir, 'mcdoc-ts-generator'),
  }
}

async function getLinkState() {
  const { sandstoneDir, cliDir, templateDir } = getDirs()

  const [sandstonePkg, cliPkg, templatePkg] = await Promise.all([
    readPackageJson(sandstoneDir),
    readPackageJson(cliDir),
    readPackageJson(templateDir),
  ])

  const sandstoneMcdocLinked = isLinked(sandstonePkg.devDependencies?.['@sandstone-mc/mcdoc-ts-generator'])
  const cliSandstoneLinked = isLinked(cliPkg.devDependencies?.sandstone)
  const cliHotHookLinked = isLinked(cliPkg.dependencies?.['@sandstone-mc/hot-hook'])
  const templateSandstoneLinked = isLinked(templatePkg.dependencies?.sandstone)
  const templateCliLinked = isLinked(templatePkg.devDependencies?.['sandstone-cli'])

  return {
    sandstonePkg,
    cliPkg,
    templatePkg,
    sandstoneMcdocLinked,
    cliSandstoneLinked,
    cliHotHookLinked,
    templateSandstoneLinked,
    templateCliLinked,
    cliLinked: cliSandstoneLinked || cliHotHookLinked,
    templateLinked: templateSandstoneLinked || templateCliLinked,
  }
}

async function link() {
  const { sandstoneDir, cliDir, templateDir, hotHookDir, mcdocTsGenDir } = getDirs()
  const state = await getLinkState()
  const { sandstoneMcdocLinked, cliSandstoneLinked, cliHotHookLinked, cliLinked, templateLinked } = state

  if (cliLinked && templateLinked && sandstoneMcdocLinked) {
    console.log('Packages are already linked.')
    return
  }

  console.log('Linking local packages for development...\n')

  // Build packages if not already built
  const builds: Array<{ dir: string; outDir: string; label: string; cmd: string }> = [
    { dir: sandstoneDir, outDir: 'dist', label: 'sandstone', cmd: 'bun dev:build' },
    { dir: cliDir, outDir: 'lib', label: 'sandstone-cli', cmd: 'bun dev:build' },
    { dir: hotHookDir, outDir: 'build', label: 'hot-hook', cmd: 'bun run build' },
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
    await $`bun link sandstone --save`.cwd(cliDir)
  }
  if (!cliHotHookLinked) {
    console.log('\nLinking hot-hook into sandstone-cli...')
    await $`bun link @sandstone-mc/hot-hook --save`.cwd(cliDir)
  }

  if (!state.templateSandstoneLinked || !state.templateCliLinked) {
    console.log('\nLinking packages into sandstone-template...')
    if (!state.templateSandstoneLinked) await $`bun link sandstone --save`.cwd(templateDir)
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
  const { sandstoneDir, cliDir, templateDir, hotHookDir, mcdocTsGenDir } = getDirs()
  const state = await getLinkState()
  const { sandstonePkg, cliPkg, templatePkg, sandstoneMcdocLinked, cliSandstoneLinked, cliHotHookLinked, cliLinked, templateLinked, templateSandstoneLinked, templateCliLinked } = state

  if (!cliLinked && !templateLinked && !sandstoneMcdocLinked) {
    console.log('Packages are already unlinked.')
    return
  }

  console.log('Unlinking local packages...\n')

  // Unregister packages globally
  for (const [label, dir] of [
    ['sandstone', sandstoneDir],
    ['sandstone-cli', cliDir],
    ['hot-hook', hotHookDir],
    ['mcdoc-ts-generator', mcdocTsGenDir],
  ] as const) {
    console.log(`Unregistering ${label}...`)
    await $`bun unlink`.cwd(dir).nothrow()
  }

  // Fetch latest versions from npm
  console.log('\nFetching latest versions from npm...')
  const [sandstoneVersion, cliVersion, hotHookVersion, mcdocTsGenVersion] = await Promise.all([
    new Promise<string>((res) => res('^1.0.0-beta.3')), // TODO: Once we're out of beta this can use getLatestNpmVersion again
    getLatestNpmVersion('sandstone-cli'),
    getLatestNpmVersion('@sandstone-mc/hot-hook'),
    getLatestNpmVersion('@sandstone-mc/mcdoc-ts-generator')
  ])
  console.log(`  sandstone: ${sandstoneVersion}`)
  console.log(`  sandstone-cli: ${cliVersion}`)
  console.log(`  @sandstone-mc/hot-hook: ${hotHookVersion}`)
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
      cliPkg.devDependencies!.sandstone = sandstoneVersion
      await deleteNodeModule(cliDir, 'sandstone')
    }
    if (cliHotHookLinked) {
      cliPkg.dependencies!['@sandstone-mc/hot-hook'] = hotHookVersion
      await deleteNodeModule(cliDir, '@sandstone-mc/hot-hook')
    }
    await writePackageJson(cliDir, cliPkg)
    await $`bun install`.cwd(cliDir)
  }

  // Restore sandstone-template
  if (templateLinked) {
    console.log('\nRestoring sandstone-template...')
    if (templateSandstoneLinked) {
      templatePkg.dependencies!.sandstone = sandstoneVersion
      await deleteNodeModule(templateDir, 'sandstone')
    }
    if (templateCliLinked) {
      templatePkg.devDependencies!['sandstone-cli'] = cliVersion
      await deleteNodeModule(templateDir, 'sandstone-cli')
    }
    await writePackageJson(templateDir, templatePkg)
    await $`bun install`.cwd(templateDir)
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
