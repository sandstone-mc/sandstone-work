/**
 * Link/unlink local packages for development.
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

async function removeNodeModulesPackage(projectDir: string, packageName: string): Promise<void> {
  const packagePath = join(projectDir, 'node_modules', packageName)
  await $`rm -rf ${packagePath}`.quiet().nothrow()
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function link() {
  const cliDir = join(rootDir, 'sandstone-cli')
  const templateDir = join(rootDir, 'sandstone-template')

  // Check if already linked
  const cliPkg = await readPackageJson(cliDir)
  const templatePkg = await readPackageJson(templateDir)

  const cliLinked = cliPkg.peerDependencies?.sandstone?.startsWith('file:')
  const templateLinked =
    templatePkg.dependencies?.sandstone?.startsWith('file:') &&
    templatePkg.devDependencies?.['sandstone-cli']?.startsWith('file:')

  if (cliLinked && templateLinked) {
    console.log('Packages are already linked.')
    return
  }

  console.log('Linking local packages for development...\n')

  // Step 1: Build sandstone (only if dist doesn't exist)
  const sandstoneDir = join(rootDir, 'sandstone')
  if (await directoryExists(join(sandstoneDir, 'dist'))) {
    console.log('Sandstone already built, skipping...\n')
  } else {
    console.log('Building sandstone...')
    $.cwd(sandstoneDir)
    await $`bun run build`
    console.log('Sandstone built\n')
  }

  // Step 2: Build sandstone-cli (only if lib doesn't exist)
  if (await directoryExists(join(cliDir, 'lib'))) {
    console.log('sandstone-cli already built, skipping...\n')
  } else {
    console.log('Building sandstone-cli...')
    $.cwd(cliDir)
    await $`bun run build`
    console.log('sandstone-cli built\n')
  }

  // Step 3: Update sandstone-cli to use local sandstone
  console.log('Linking sandstone-cli to local sandstone...')

  cliPkg.peerDependencies = cliPkg.peerDependencies || {}
  cliPkg.peerDependencies.sandstone = 'file:../sandstone'
  await writePackageJson(cliDir, cliPkg)

  // Remove cached package to avoid EEXIST errors
  await removeNodeModulesPackage(cliDir, 'sandstone')

  $.cwd(cliDir)
  await $`bun install`
  console.log('sandstone-cli linked\n')

  // Step 4: Update sandstone-template to use local packages
  console.log('Linking sandstone-template to local packages...')

  templatePkg.dependencies = templatePkg.dependencies || {}
  templatePkg.dependencies.sandstone = 'file:../sandstone'

  templatePkg.devDependencies = templatePkg.devDependencies || {}
  templatePkg.devDependencies['sandstone-cli'] = 'file:../sandstone-cli'

  await writePackageJson(templateDir, templatePkg)

  // Remove cached packages to avoid EEXIST errors
  await removeNodeModulesPackage(templateDir, 'sandstone')
  await removeNodeModulesPackage(templateDir, 'sandstone-cli')

  $.cwd(templateDir)
  await $`bun install`
  console.log('sandstone-template linked\n')

  console.log('All packages linked for local development!')
  console.log('')
  console.log('You can now:')
  console.log('  cd sandstone-template && bun run build')
  console.log('')
  console.log('To restore npm versions before committing:')
  console.log('  bun scripts/link.ts unlink')
}

async function unlink() {
  const cliDir = join(rootDir, 'sandstone-cli')
  const templateDir = join(rootDir, 'sandstone-template')

  // Check if already unlinked
  const cliPkg = await readPackageJson(cliDir)
  const templatePkg = await readPackageJson(templateDir)

  const cliLinked = cliPkg.peerDependencies?.sandstone?.startsWith('file:')
  const templateLinked =
    templatePkg.dependencies?.sandstone?.startsWith('file:') ||
    templatePkg.devDependencies?.['sandstone-cli']?.startsWith('file:')

  if (!cliLinked && !templateLinked) {
    console.log('Packages are already unlinked.')
    return
  }

  console.log('Unlinking local packages...\n')

  // Fetch latest versions from npm
  console.log('Fetching latest versions from npm...')
  const [sandstoneVersion, cliVersion] = await Promise.all([
    getLatestNpmVersion('sandstone'),
    getLatestNpmVersion('sandstone-cli'),
  ])
  console.log(`  sandstone: ${sandstoneVersion}`)
  console.log(`  sandstone-cli: ${cliVersion}`)
  console.log('')

  // Step 1: Restore sandstone-cli
  if (cliLinked) {
    console.log('Restoring sandstone-cli...')
    cliPkg.peerDependencies!.sandstone = sandstoneVersion
    await writePackageJson(cliDir, cliPkg)

    $.cwd(cliDir)
    await $`bun install`
    console.log('sandstone-cli restored\n')
  }

  // Step 2: Restore sandstone-template
  if (templateLinked) {
    console.log('Restoring sandstone-template...')

    if (templatePkg.dependencies?.sandstone?.startsWith('file:')) {
      templatePkg.dependencies.sandstone = sandstoneVersion
    }

    if (templatePkg.devDependencies?.['sandstone-cli']?.startsWith('file:')) {
      templatePkg.devDependencies['sandstone-cli'] = cliVersion
    }

    await writePackageJson(templateDir, templatePkg)

    $.cwd(templateDir)
    await $`bun install`
    console.log('sandstone-template restored\n')
  }

  console.log('All packages restored to npm versions!')
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
