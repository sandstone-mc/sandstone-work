/**
 * Template script to prepare the sandstone-template for development.
 *
 * Usage:
 *   bun scripts/template.ts              - Checkout latest pack template
 *   bun scripts/template.ts --library    - Checkout latest library template
 *   bun scripts/template.ts --help       - Show help
 */

import { $ } from 'bun'
import { access } from 'fs/promises'
import { join } from 'path'

const rootDir = join(import.meta.dir, '..')
const templateDir = join(rootDir, 'sandstone-template')

type TemplateType = 'pack' | 'library'

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function parseVersion(version: string): number[] {
  const [main, prerelease] = version.split('-')
  const mainParts = main.split('.').map(Number)

  if (!prerelease) {
    return [...mainParts, Infinity, Infinity]
  }

  const prereleaseOrder: Record<string, number> = { alpha: 0, beta: 1, rc: 2 }
  const match = prerelease.match(/^(alpha|beta|rc)\.(\d+)$/)
  if (match) {
    const [, type, num] = match
    return [...mainParts, prereleaseOrder[type], Number(num)]
  }

  return [...mainParts, -1, -1]
}

function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a)
  const partsB = parseVersion(b)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] ?? 0
    const partB = partsB[i] ?? 0
    if (partA !== partB) {
      return partA - partB
    }
  }
  return 0
}

async function getRemoteBranches(): Promise<string[]> {
  const result = await $`git -C ${templateDir} branch -r`.quiet().nothrow()
  if (result.exitCode !== 0) {
    return []
  }
  return result.stdout
    .toString()
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.includes('->'))
    .map((b) => b.replace('origin/', ''))
}

async function getCurrentBranch(): Promise<string | null> {
  const result = await $`git -C ${templateDir} branch --show-current`.quiet().nothrow()
  if (result.exitCode === 0) {
    return result.stdout.toString().trim()
  }
  return null
}

function findLatestBranch(branches: string[], prefix: TemplateType): string | null {
  const filtered = branches.filter((b) => b.startsWith(`${prefix}-`))
  if (filtered.length === 0) return null

  return filtered.sort((a, b) => {
    const versionA = a.replace(`${prefix}-`, '')
    const versionB = b.replace(`${prefix}-`, '')
    return compareVersions(versionB, versionA)
  })[0]
}

function parseArgs(): { type: TemplateType; help: boolean } {
  const args = process.argv.slice(2)
  return {
    type: args.includes('--library') ? 'library' : 'pack',
    help: args.includes('--help') || args.includes('-h'),
  }
}

function showHelp() {
  console.log(`Usage: bun scripts/template.ts [options]

Options:
  --library    Use library template instead of pack template
  --help, -h   Show this help message

Examples:
  bun run dev:template              Checkout latest pack template
  bun run dev:template --library    Checkout latest library template`)
}

async function dev() {
  const { type, help } = parseArgs()

  if (help) {
    showHelp()
    process.exit(0)
  }

  if (!(await fileExists(templateDir))) {
    console.error('Error: sandstone-template not found. Run `bun run setup` first.')
    process.exit(1)
  }

  // Fetch latest
  process.stdout.write('Fetching branches... ')
  $.cwd(templateDir)
  await $`git fetch --prune`.quiet().nothrow()
  console.log('done')

  // Find target branch
  const branches = await getRemoteBranches()
  const targetBranch = findLatestBranch(branches, type)

  if (!targetBranch) {
    console.error(`Error: No ${type}-* branches found.`)
    process.exit(1)
  }

  // Checkout if needed
  const currentBranch = await getCurrentBranch()

  if (currentBranch === targetBranch) {
    console.log(`Branch: ${targetBranch} (current)`)
  } else {
    // Clean untracked/ignored files and reset tracked files before switching
    process.stdout.write('Cleaning working directory... ')
    await $`git -C ${templateDir} reset --hard`.quiet().nothrow()
    await $`git -C ${templateDir} clean -fdx`.quiet().nothrow()
    console.log('done')

    process.stdout.write(`Checking out ${targetBranch}... `)
    const result = await $`git -C ${templateDir} checkout ${targetBranch}`.quiet().nothrow()
    if (result.exitCode !== 0) {
      console.log('failed\n')
      console.error(result.stderr.toString().trim())
      process.exit(1)
    }
    console.log('done')
  }

  // Install deps if needed
  const hasBunLock = await fileExists(join(templateDir, 'bun.lock'))
  const hasNodeModules = await fileExists(join(templateDir, 'node_modules'))
  if (hasBunLock && !hasNodeModules) {
    process.stdout.write('Installing dependencies... ')
    $.cwd(templateDir)
    await $`bun install`.quiet()
    await $`bun pm trust --all`.quiet().nothrow()
    console.log('done')
  }

  console.log('Ready!')
}

dev().catch((err) => {
  console.error('Error:', err.message ?? err)
  process.exit(1)
})
