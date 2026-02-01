/**
 * Setup script for the Sandstone monorepo.
 *
 * Usage:
 *   bun scripts/setup.ts                     - Run setup with default settings
 *   bun scripts/setup.ts --org <name>        - Use a different git org/user
 *   bun scripts/setup.ts --skip <repos>      - Skip specific repos (comma-separated)
 *   bun scripts/setup.ts --only <repos>      - Only include specific repos (comma-separated)
 *
 * Examples:
 *   bun scripts/setup.ts --org MulverineX
 *   bun scripts/setup.ts --skip documentation,playground
 *   bun scripts/setup.ts --only sandstone,cli,template
 */

import { $ } from 'bun'
import { access } from 'fs/promises'
import { join } from 'path'

const rootDir = join(import.meta.dir, '..')
const DEFAULT_ORG = 'sandstone-mc'

interface Manifest {
  [shortName: string]: string // shortName -> folderName
}

interface ContributeManifest {
  'git-user': string
  'skip-repos': string[]
  'only-repos'?: string[]
}

interface WorkspaceFolder {
  name: string
  path: string
}

interface Workspace {
  folders: WorkspaceFolder[]
  settings: Record<string, unknown>
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T> {
  return await Bun.file(path).json()
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2) + '\n')
}

async function getGitOriginUrl(repoDir: string): Promise<string | null> {
  try {
    const result = await $`git -C ${repoDir} remote get-url origin`.quiet().nothrow()
    if (result.exitCode === 0) {
      return result.stdout.toString().trim()
    }
  } catch {
    // Ignore errors
  }
  return null
}

async function getGitBranch(repoDir: string): Promise<string | null> {
  try {
    const result = await $`git -C ${repoDir} branch --show-current`.quiet().nothrow()
    if (result.exitCode === 0) {
      return result.stdout.toString().trim()
    }
  } catch {
    // Ignore errors
  }
  return null
}

function parseArgs(): { org?: string; skip?: string[]; only?: string[] } {
  const args = process.argv.slice(2)
  const result: { org?: string; skip?: string[]; only?: string[] } = {}

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--org' && args[i + 1]) {
      result.org = args[++i]
    } else if (args[i] === '--skip' && args[i + 1]) {
      result.skip = args[++i].split(',').map((s) => s.trim())
    } else if (args[i] === '--only' && args[i + 1]) {
      result.only = args[++i].split(',').map((s) => s.trim())
    }
  }

  return result
}

function shouldIncludeRepo(
  shortName: string,
  config: ContributeManifest
): boolean {
  if (config['only-repos'] && config['only-repos'].length > 0) {
    return config['only-repos'].includes(shortName)
  }
  return !config['skip-repos'].includes(shortName)
}

async function setup() {
  const args = parseArgs()

  // Load manifests
  const manifest = await readJson<Manifest>(join(rootDir, 'manifest.json'))
  let contribute: ContributeManifest

  if (await fileExists(join(rootDir, 'manifest.contribute.json'))) {
    contribute = await readJson<ContributeManifest>(
      join(rootDir, 'manifest.contribute.json')
    )
  } else {
    contribute = {
      'git-user': DEFAULT_ORG,
      'skip-repos': [],
    }
  }

  // Update contribute manifest if CLI args provided
  let contributeModified = false
  if (args.org && args.org !== contribute['git-user']) {
    contribute['git-user'] = args.org
    contributeModified = true
  }
  if (args.skip) {
    contribute['skip-repos'] = args.skip
    delete contribute['only-repos']
    contributeModified = true
  }
  if (args.only) {
    contribute['only-repos'] = args.only
    contribute['skip-repos'] = []
    contributeModified = true
  }

  if (contributeModified) {
    await writeJson(join(rootDir, 'manifest.contribute.json'), contribute)
    console.log('Updated manifest.contribute.json\n')
  }

  if (!contributeModified && (contribute['git-user'] !== 'sandstone-mc' || contribute['only-repos'] || contribute['skip-repos'].length !== 0)) {
    // from this point on the variable tells the CLI to not modify the workspace nor gitignore
    contributeModified = true
  }

  const gitUser = contribute['git-user']

  // Step 1: Git pull in root
  console.log('Pulling latest changes in root...')
  $.cwd(rootDir)
  await $`git pull`.nothrow()
  console.log('')

  // Build list of repos to process
  const reposToProcess: { shortName: string; folderName: string }[] = []
  for (const [shortName, folderName] of Object.entries(manifest)) {
    if (shouldIncludeRepo(shortName, contribute)) {
      reposToProcess.push({ shortName, folderName })
    }
  }

  // Step 2: Update .gitignore
  if (!contributeModified) {
    console.log('Updating .gitignore...')
    const gitignoreLines = ['manifest.contribute.json', '', 'node_modules/', '']
    for (const { folderName } of reposToProcess) {
      gitignoreLines.push(`${folderName}/`)
    }
    await Bun.write(join(rootDir, '.gitignore'), gitignoreLines.join('\n') + '\n')
    console.log('')
  }

  // Step 3: Update VS Code workspace
  if (!contributeModified) {
    console.log('Updating sandstone.code-workspace...')
    const workspace: Workspace = {
      folders: [{ name: 'work', path: './' }],
      settings: {},
    }
    for (const { shortName, folderName } of reposToProcess) {
      workspace.folders.push({ name: shortName, path: folderName })
    }
    await Bun.write(
      join(rootDir, 'sandstone.code-workspace'),
      JSON.stringify(workspace, null, '\t') + '\n'
    )
    console.log('')
  }

  // Step 4: Clone/pull repos
  for (const { shortName, folderName } of reposToProcess) {
    const repoDir = join(rootDir, folderName)
    const repoUrl = `https://github.com/${gitUser}/${folderName}.git`

    if (await fileExists(repoDir)) {
      // Repo exists - check if we should pull
      const branch = await getGitBranch(repoDir)
      const originUrl = await getGitOriginUrl(repoDir)

      if (shortName === 'template' || ((branch === 'main' || branch === 'master') && originUrl?.includes(`${DEFAULT_ORG}/`))) {
        console.log(`Pulling ${shortName}...`)
        $.cwd(repoDir)
        await $`git pull`.nothrow()
      } else {
        console.log(
          `Skipping pull for ${shortName} (branch: ${branch}, not on main or not ${DEFAULT_ORG})`
        )
      }
    } else {
      // Clone the repo
      console.log(`Cloning ${shortName} from ${gitUser}...`)
      $.cwd(rootDir)
      await $`git clone ${repoUrl} ${folderName}`.nothrow()
    }
  }
  console.log('')

  // Step 5: Run bun install where needed
  console.log('Installing dependencies...')
  for (const { shortName, folderName } of reposToProcess) {
    const repoDir = join(rootDir, folderName)

    if (!(await fileExists(repoDir))) {
      continue
    }

    const hasBunLock = await fileExists(join(repoDir, 'bun.lock'))
    const hasNodeModules = await fileExists(join(repoDir, 'node_modules'))

    if (hasBunLock && !hasNodeModules) {
      console.log(`Installing dependencies for ${shortName}...`)
      $.cwd(repoDir)
      await $`bun install`.nothrow()
      await $`bun pm trust --all`.nothrow()
    }
  }

  console.log('\nSetup complete!')
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun scripts/setup.ts [options]')
    console.log('')
    console.log('Options:')
    console.log('  --org <name>     Use a different git org/user (default: sandstone-mc)')
    console.log('  --skip <repos>   Skip specific repos (comma-separated short names)')
    console.log('  --only <repos>   Only include specific repos (comma-separated short names)')
    console.log('  --help, -h       Show this help message')
    console.log('')
    console.log('Examples:')
    console.log('  bun scripts/setup.ts --org MulverineX')
    console.log('  bun scripts/setup.ts --skip documentation,playground')
    console.log('  bun scripts/setup.ts --only sandstone,cli,template')
    process.exit(0)
  }

  await setup()
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
