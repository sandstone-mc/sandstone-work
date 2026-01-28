/**
 * Unlink local packages and restore npm versions.
 * This script restores the original package.json dependencies
 * so the repo is ready for git commit/push.
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
  console.log('🔓 Unlinking local packages...\n')

  // Step 1: Restore sandstone-cli
  const cliDir = join(rootDir, 'sandstone-cli')
  const cliOriginalFile = Bun.file(join(cliDir, '.link-original.json'))

  if (await cliOriginalFile.exists()) {
    console.log('📦 Restoring sandstone-cli...')
    const cliPkg = await readPackageJson(cliDir)
    const cliOriginal = await cliOriginalFile.json()

    cliPkg.peerDependencies = cliOriginal.peerDependencies
    await writePackageJson(cliDir, cliPkg)
    await cliOriginalFile.delete()

    $.cwd(cliDir)
    await $`bun install`
    console.log('✅ sandstone-cli restored\n')
  } else {
    console.log('⏭️  sandstone-cli was not linked, skipping\n')
  }

  // Step 2: Restore sandstone-template
  const templateDir = join(rootDir, 'sandstone-template')
  const templateOriginalFile = Bun.file(join(templateDir, '.link-original.json'))

  if (await templateOriginalFile.exists()) {
    console.log('📦 Restoring sandstone-template...')
    const templatePkg = await readPackageJson(templateDir)
    const templateOriginal = await templateOriginalFile.json()

    templatePkg.dependencies = templateOriginal.dependencies
    templatePkg.devDependencies = templateOriginal.devDependencies
    await writePackageJson(templateDir, templatePkg)
    await templateOriginalFile.delete()

    $.cwd(templateDir)
    await $`bun install`
    console.log('✅ sandstone-template restored\n')
  } else {
    console.log('⏭️  sandstone-template was not linked, skipping\n')
  }

  console.log('🎉 All packages restored to npm versions!')
  console.log('   Ready for git commit/push.')
}

main().catch((err) => {
  console.error('❌ Error:', err)
  process.exit(1)
})
