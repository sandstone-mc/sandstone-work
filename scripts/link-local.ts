/**
 * Link local packages for development.
 * This script:
 * 1. Builds sandstone
 * 2. Adds file: protocol dependencies to sandstone-cli and sandstone-template
 * 3. Runs bun install in each project
 */

import { $ } from 'bun'
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

async function main() {
  console.log('🔧 Linking local packages for development...\n')

  // Step 1: Build sandstone
  console.log('📦 Building sandstone...')
  $.cwd(join(rootDir, 'sandstone'))
  await $`bun run build`
  console.log('✅ Sandstone built\n')

  // Step 2: Update sandstone-cli to use local sandstone
  console.log('🔗 Linking sandstone-cli to local sandstone...')
  const cliDir = join(rootDir, 'sandstone-cli')
  const cliPkg = await readPackageJson(cliDir)

  // Store original values for unlink
  const cliOriginal = {
    peerDependencies: { ...cliPkg.peerDependencies },
  }
  await Bun.write(join(cliDir, '.link-original.json'), JSON.stringify(cliOriginal, null, 2))

  // Update to file: reference
  cliPkg.peerDependencies = cliPkg.peerDependencies || {}
  cliPkg.peerDependencies.sandstone = 'file:../sandstone'
  await writePackageJson(cliDir, cliPkg)

  $.cwd(cliDir)
  await $`bun install`
  console.log('✅ sandstone-cli linked\n')

  // Step 3: Update sandstone-template to use local packages
  console.log('🔗 Linking sandstone-template to local packages...')
  const templateDir = join(rootDir, 'sandstone-template')
  const templatePkg = await readPackageJson(templateDir)

  // Store original values
  const templateOriginal = {
    dependencies: { ...templatePkg.dependencies },
    devDependencies: { ...templatePkg.devDependencies },
  }
  await Bun.write(join(templateDir, '.link-original.json'), JSON.stringify(templateOriginal, null, 2))

  // Update to file: references
  templatePkg.dependencies = templatePkg.dependencies || {}
  templatePkg.dependencies.sandstone = 'file:../sandstone'

  templatePkg.devDependencies = templatePkg.devDependencies || {}
  templatePkg.devDependencies['sandstone-cli'] = 'file:../sandstone-cli'

  await writePackageJson(templateDir, templatePkg)

  $.cwd(templateDir)
  await $`bun install`
  console.log('✅ sandstone-template linked\n')

  console.log('🎉 All packages linked for local development!')
  console.log('')
  console.log('You can now:')
  console.log('  cd sandstone-template && bun run build')
  console.log('')
  console.log('To restore npm versions before committing:')
  console.log('  bun run dev:unlink')
}

main().catch((err) => {
  console.error('❌ Error:', err)
  process.exit(1)
})
