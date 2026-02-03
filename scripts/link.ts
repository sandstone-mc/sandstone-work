/**
 * Link/unlink local packages for development using bun link.
 *
 * Usage:
 *   bun scripts/link.ts link    - Link local packages for development
 *   bun scripts/link.ts unlink  - Restore npm versions (fetches latest from registry)
 */

import { $ } from 'bun'
import { access } from 'fs/promises'
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

async function link() {
  const sandstoneDir = join(rootDir, 'sandstone')
  const cliDir = join(rootDir, 'sandstone-cli')
  const templateDir = join(rootDir, 'sandstone-template')
  const hotHookDir = join(rootDir, 'hot-hook', 'packages', 'hot_hook')

  // Check if already linked
  const cliPkg = await readPackageJson(cliDir)
  const templatePkg = await readPackageJson(templateDir)

  const cliSandstoneLinked = isLinked(cliPkg.devDependencies?.sandstone)
  const cliHotHookLinked = isLinked(cliPkg.dependencies?.['@sandstone-mc/hot-hook'])
  const cliLinked = cliSandstoneLinked && cliHotHookLinked
  const templateLinked =
    isLinked(templatePkg.dependencies?.sandstone) &&
    isLinked(templatePkg.devDependencies?.['sandstone-cli'])

  if (cliLinked && templateLinked) {
    console.log('Packages are already linked.')
    return
  }

  console.log('Linking local packages for development...\n')

  // Step 1: Build sandstone (only if dist doesn't exist)
  if (await directoryExists(join(sandstoneDir, 'dist'))) {
    console.log('Sandstone already built, skipping...\n')
  } else {
    console.log('Building sandstone...')
    await $`bun run build`.cwd(sandstoneDir)
    console.log('Sandstone built\n')
  }

  // Step 2: Build sandstone-cli (only if lib doesn't exist)
  if (await directoryExists(join(cliDir, 'lib'))) {
    console.log('sandstone-cli already built, skipping...\n')
  } else {
    console.log('Building sandstone-cli...')
    await $`bun run build`.cwd(cliDir)
    console.log('sandstone-cli built\n')
  }

  // Step 3: Build hot-hook (only if build doesn't exist)
  if (await directoryExists(join(hotHookDir, 'build'))) {
    console.log('hot-hook already built, skipping...\n')
  } else {
    console.log('Building hot-hook...')
    await $`bun run build`.cwd(hotHookDir)
    console.log('hot-hook built\n')
  }

  // Step 4: Register packages globally with bun link
  console.log('Registering sandstone...')
  await $`bun link`.cwd(sandstoneDir)

  console.log('Registering sandstone-cli...')
  await $`bun link`.cwd(cliDir)

  console.log('Registering hot-hook...')
  await $`bun link`.cwd(hotHookDir)

  // Step 5: Link sandstone and hot-hook into sandstone-cli
  if (!cliSandstoneLinked) {
    console.log('\nLinking sandstone into sandstone-cli...')
    await $`bun link sandstone --save`.cwd(cliDir)
  }
  if (!cliHotHookLinked) {
    console.log('\nLinking hot-hook into sandstone-cli...')
    await $`bun link @sandstone-mc/hot-hook --save`.cwd(cliDir)
  }

  // Step 6: Link both packages into sandstone-template
  if (!templateLinked) {
    console.log('\nLinking packages into sandstone-template...')
    await $`bun link sandstone --save`.cwd(templateDir)
    await $`bun link sandstone-cli --save`.cwd(templateDir)
  }

  console.log('\nAll packages linked for local development!')
  console.log('')
  console.log('You can now:')
  console.log('  cd sandstone-template && bun run build')
  console.log('')
  console.log('To restore npm versions before committing:')
  console.log('  bun scripts/link.ts unlink')
}

async function unlink() {
  const sandstoneDir = join(rootDir, 'sandstone')
  const cliDir = join(rootDir, 'sandstone-cli')
  const templateDir = join(rootDir, 'sandstone-template')
  const hotHookDir = join(rootDir, 'hot-hook', 'packages', 'hot_hook')

  // Check if already unlinked
  const cliPkg = await readPackageJson(cliDir)
  const templatePkg = await readPackageJson(templateDir)

  const cliSandstoneLinked = isLinked(cliPkg.devDependencies?.sandstone)
  const cliHotHookLinked = isLinked(cliPkg.dependencies?.['@sandstone-mc/hot-hook'])
  const cliLinked = cliSandstoneLinked || cliHotHookLinked
  const templateLinked =
    isLinked(templatePkg.dependencies?.sandstone) ||
    isLinked(templatePkg.devDependencies?.['sandstone-cli'])

  if (!cliLinked && !templateLinked) {
    console.log('Packages are already unlinked.')
    return
  }

  console.log('Unlinking local packages...\n')

  // Unregister packages globally
  console.log('Unregistering sandstone...')
  await $`bun unlink`.cwd(sandstoneDir).nothrow()

  console.log('Unregistering sandstone-cli...')
  await $`bun unlink`.cwd(cliDir).nothrow()

  console.log('Unregistering hot-hook...')
  await $`bun unlink`.cwd(hotHookDir).nothrow()

  // Fetch latest versions from npm
  console.log('\nFetching latest versions from npm...')
  const [sandstoneVersion, cliVersion] = await Promise.all([
    getLatestNpmVersion('sandstone'),
    getLatestNpmVersion('sandstone-cli'),
    // TODO: Fetch @sandstone-mc/hot-hook once published
  ])
  console.log(`  sandstone: ${sandstoneVersion}`)
  console.log(`  sandstone-cli: ${cliVersion}`)

  // Restore sandstone-cli
  if (cliLinked) {
    console.log('\nRestoring sandstone-cli...')
    if (cliSandstoneLinked) {
      cliPkg.devDependencies!.sandstone = sandstoneVersion
    }
    if (cliHotHookLinked) {
      // TODO: Set to hotHookVersion once @sandstone-mc/hot-hook is published
      delete cliPkg.dependencies!['@sandstone-mc/hot-hook']
    }
    await writePackageJson(cliDir, cliPkg)
    await $`bun install`.cwd(cliDir)
  }

  // Restore sandstone-template
  if (templateLinked) {
    console.log('\nRestoring sandstone-template...')

    if (isLinked(templatePkg.dependencies?.sandstone)) {
      templatePkg.dependencies!.sandstone = sandstoneVersion
    }

    if (isLinked(templatePkg.devDependencies?.['sandstone-cli'])) {
      templatePkg.devDependencies!['sandstone-cli'] = cliVersion
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
    console.log('Usage: bun scripts/link.ts <link|unlink>')
    console.log('')
    console.log('Commands:')
    console.log('  link    - Link local packages for development')
    console.log('  unlink  - Restore npm versions (fetches latest from registry)')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
