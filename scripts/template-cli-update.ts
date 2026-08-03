/**
 * Update sandstone-cli in every maintained template branch (pack-X.Y.0 and
 * library-X.Y.0) to match the workspace's current sandstone-cli version.
 *
 * Usage:
 *   bun template:cli-update            # interactive: confirm + iterate all
 *   bun template:cli-update --dry-run  # show what would change without
 *                                       touching anything
 *
 * Each branch:
 *   1. Check out (detached HEAD) from origin
 *   2. Bump `devDependencies.sandstone-cli` (root) and `dependencies.sandstone-cli`
 *      (test/, for library branches) to `^<workspace-cli-version>`
 *   3. Refresh bun.lock via `bun install`
 *   4. Commit "⬆️ Update CLI" and push (unless --dry-run)
 *
 * Requires a clean `sandstone-template` working directory (refuses to start
 * otherwise to protect any in-progress edits). After the loop, the
 * template repo is restored to the branch the user was on when the script
 * started — but only if work was actually done (skipped if every branch was
 * a no-op).
 */

import { $ } from 'bun'
import { access, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const rootDir = join(import.meta.dir, '..')
const cliDir = join(rootDir, 'sandstone-cli')
const templateDir = join(rootDir, 'sandstone-template')

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function getWorkspaceCLIVersion(): Promise<string> {
	if (!(await fileExists(join(cliDir, 'package.json')))) {
		throw new Error(`sandstone-cli not found at ${cliDir}. Run \`bun run setup\` first.`)
	}
	const pkgRaw = await readFile(join(cliDir, 'package.json'), 'utf8')
	const { version } = JSON.parse(pkgRaw) as { version: string }
	if (!version) throw new Error('sandstone-cli/package.json has no version')
	return `^${version}`
}

async function fetchTemplate(): Promise<void> {
	await $`git -C ${templateDir} fetch --prune`.quiet().nothrow()
}

async function assertTemplateClean(): Promise<void> {
	const status = (await $`git -C ${templateDir} status --porcelain`.quiet().text()).trim()
	if (status.length > 0) {
		throw new Error(`sandstone-template has uncommitted changes. Commit or stash first.`)
	}
}

async function listMaintainedTemplateBranches(): Promise<string[]> {
	const out = await $`git -C ${templateDir} ls-remote --heads origin 'refs/heads/pack-*' 'refs/heads/library-*'`.text()
	const branches = out
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const parts = l.split(/\s+/)
			return parts[1] ?? ''
		})
		.map((ref) => ref.replace('refs/heads/', ''))
		// Maintained branches are pack-X.Y.0 / library-X.Y.0 — the patch slot
		// is always 0 (template tracks sandstone minors, not individual patches).
		.filter((b) => /^(?:pack|library)-\d+\.\d+\.0$/.test(b))
	return branches.sort()
}

interface FileChange {
	path: string // relative to templateDir, e.g. "package.json"
	oldVersion: string | null // null if no sandstone-cli dep was present
	newVersion: string // the version we tried to set
}

interface BranchResult {
	branch: string
	fileChanges: FileChange[]
	committed: boolean
	error?: string
}

/**
 * Overwrite the sandstone-cli dep in a package.json. Caller is responsible
 * for verifying the old version differs from the new version first.
 */
async function writeSandstoneCliVersion(filePath: string, newVersion: string): Promise<void> {
	const raw = await readFile(filePath, 'utf8')
	const pkg = JSON.parse(raw) as {
		dependencies?: Record<string, string>
		devDependencies?: Record<string, string>
	}
	const targetKey: 'dependencies' | 'devDependencies' = pkg.dependencies?.['sandstone-cli'] != null
		? 'dependencies'
		: 'devDependencies'
	pkg[targetKey] = { ...(pkg[targetKey] ?? {}), 'sandstone-cli': newVersion }
	await writeFile(filePath, JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * Read both package.json files for a branch WITHOUT checking it out.
 * Uses `git show origin/<branch>:<path>` so the user's working directory
 * is never mutated during inspection (including dry-run passes).
 */
async function inspectBranch(branch: string, newVersion: string): Promise<FileChange[]> {
	const debug = process.env.DEBUG_TPL_UPDATE === '1'
	const log = (msg: string) => { if (debug) console.error(`  [debug] ${msg}`) }
	try {
		log(`reading origin/${branch}:package.json`)
		const rootShow = await $`git -C ${templateDir} show origin/${branch}:package.json`.quiet()
		if (rootShow.exitCode !== 0) {
			log(`could not read package.json (exit ${rootShow.exitCode}); treating as no-op`)
			return []
		}
		const rootPkg = JSON.parse(rootShow.stdout.toString()) as {
			dependencies?: Record<string, string>
			devDependencies?: Record<string, string>
		}
		const rootCurrent = rootPkg.dependencies?.['sandstone-cli'] ?? rootPkg.devDependencies?.['sandstone-cli'] ?? null
		log(`root sandstone-cli = ${rootCurrent ?? '∅'}`)

		const changes: FileChange[] = []
		if (rootCurrent !== newVersion) {
			changes.push({ path: 'package.json', oldVersion: rootCurrent, newVersion })
		}

		// Check whether test/package.json exists via ls-tree (no checkout).
		log(`checking for origin/${branch}:test/package.json`)
		const testLs = await $`git -C ${templateDir} ls-tree origin/${branch} -- test/package.json`.quiet()
		const hasTest = testLs.stdout.toString().trim().length > 0
		if (hasTest) {
			log(`reading origin/${branch}:test/package.json`)
			const testShow = await $`git -C ${templateDir} show origin/${branch}:test/package.json`.quiet()
			if (testShow.exitCode === 0) {
				const testPkg = JSON.parse(testShow.stdout.toString()) as {
					dependencies?: Record<string, string>
					devDependencies?: Record<string, string>
				}
				const testCurrent = testPkg.dependencies?.['sandstone-cli'] ?? testPkg.devDependencies?.['sandstone-cli'] ?? null
				log(`test sandstone-cli = ${testCurrent ?? '∅'}`)
				if (testCurrent !== newVersion) {
					changes.push({ path: 'test/package.json', oldVersion: testCurrent, newVersion })
				}
			}
		} else {
			log(`no test/package.json on this branch`)
		}
		return changes
	} catch (e) {
		log(`inspect error: ${(e as Error).message ?? e}`)
		return []
	}
}

/**
 * Apply pre-computed changes to a branch. Checks out, writes files, runs
 * bun install, commits, pushes. Only called for branches where `inspectBranch`
 * found actual differences — so a no-op branch never mutates the CWD.
 */
async function applyBranch(branch: string, changes: FileChange[], dryRun: boolean): Promise<{ committed: boolean; error?: string }> {
	try {
		// Detached HEAD so the user's tracked branch isn't disturbed mid-iteration.
		console.log(`  ↻ git checkout --detach origin/${branch}…`)
		await $`git -C ${templateDir} checkout --detach origin/${branch}`.quiet().nothrow()

		const rootPkgPath = join(templateDir, 'package.json')
		const testPkgPath = join(templateDir, 'test', 'package.json')

		for (const c of changes) {
			const abs = c.path === 'test/package.json' ? testPkgPath : rootPkgPath
			if (dryRun) continue
			await writeSandstoneCliVersion(abs, c.newVersion)
		}

		if (dryRun) {
			return { committed: false }
		}

		console.log(`  ↻ bun install…`)
		await $`bun install`.cwd(templateDir).quiet().nothrow()

		await $`git -C ${templateDir} add -A`.quiet()
		const status = (await $`git -C ${templateDir} status --porcelain`.quiet().text()).trim()
		if (!status) {
			// bun install didn't bump anything — surprising given we passed
			// inspection; surface but don't fail.
			return { committed: false }
		}

		console.log(`  ↻ committing…`)
		await $`git -C ${templateDir} commit -m ${'⬆️ Update CLI'}`.quiet()
		console.log(`  ↻ pushing to origin/${branch}…`)
		await $`git -C ${templateDir} push origin HEAD:refs/heads/${branch}`.quiet().nothrow()
		return { committed: true }
	} catch (e) {
		return { committed: false, error: (e as Error).message ?? String(e) }
	}
}

function parseArgs(): { dryRun: boolean; help: boolean } {
	const args = process.argv.slice(2)
	return {
		dryRun: args.includes('--dry-run'),
		help: args.includes('--help') || args.includes('-h'),
	}
}

function showHelp(): void {
	console.log(`Usage: bun template:cli-update [options]

Options:
  --dry-run    Show what would change without touching the template repo
  --help, -h   Show this help

Iterates every maintained pack-X.Y.0 / library-X.Y.0 branch on the template
remote, bumps the \`sandstone-cli\` dep to ^<workspace-cli-version> in both
the root and (for library branches) test/ package.json, refreshes bun.lock,
and commits "⬆️ Update CLI" + pushes.`)
}

function formatChange(c: FileChange): string {
	const from = c.oldVersion ?? '∅'
	return `${c.path}: ${from} → ${c.newVersion}`
}

async function main(): Promise<void> {
	const { dryRun, help } = parseArgs()
	if (help) {
		showHelp()
		process.exit(0)
	}
	if (!(await fileExists(templateDir))) {
		console.error('Error: sandstone-template not found. Run `bun run setup` first.')
		process.exit(1)
	}

	console.log('Fetching template branches…')
	await fetchTemplate()

	try {
		await assertTemplateClean()
	} catch (e) {
		console.error(`Error: ${(e as Error).message}`)
		process.exit(1)
	}

	// Remember the branch the user was on; restored only if we actually do
	// work (a no-op dry-run shouldn't disturb their CWD).
	const originalRef = (await $`git -C ${templateDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim()
	const originalBranch = originalRef === 'HEAD' ? null : originalRef
	if (originalBranch) {
		console.log(`Currently on: ${originalBranch} (will restore after changes)\n`)
	}

	const newVersion = await getWorkspaceCLIVersion()
	const branches = await listMaintainedTemplateBranches()
	if (branches.length === 0) {
		console.error('Error: no maintained template branches found.')
		process.exit(1)
	}

	console.log(`Workspace sandstone-cli version: ${newVersion}`)
	console.log(`Maintained template branches (${branches.length}):`)
	for (const b of branches) console.log(`  - ${b}`)

	if (!dryRun) {
		const { confirm } = await import('@inquirer/prompts')
		const proceed = await confirm({
			message: `Update CLI to ${newVersion} across all ${branches.length} branches and push each?`,
			default: false,
		})
		if (!proceed) {
			console.log('Cancelled.')
			process.exit(0)
		}
	}

	const results: BranchResult[] = []
	for (const branch of branches) {
		console.log(`\n${branch}…`)
		const fileChanges = await inspectBranch(branch, newVersion)

		if (fileChanges.length === 0) {
			console.log(`  — no change (already at ${newVersion})`)
			results.push({ branch, fileChanges: [], committed: false })
			continue
		}

		if (dryRun) {
			console.log(`  ↻ would change ${fileChanges.map(formatChange).join('; ')}`)
			results.push({ branch, fileChanges, committed: false })
			continue
		}

		// We have changes — checkout, write, install, commit, push.
		const r = await applyBranch(branch, fileChanges, dryRun)
		if (r.error) {
			console.log(`  ❌ error: ${r.error}`)
			results.push({ branch, fileChanges, committed: false, error: r.error })
		} else if (r.committed) {
			console.log(`  ✅ ${fileChanges.map(formatChange).join('; ')}`)
			results.push({ branch, fileChanges, committed: true })
		} else {
			console.log(`  — no changes after lockfile sync`)
			results.push({ branch, fileChanges, committed: false })
		}
	}

	const changed = results.filter((r) => r.committed).length
	const skipped = results.filter((r) => !r.committed && !r.error).length
	const failed = results.filter((r) => r.error).length
	console.log(`\nSummary: ${changed} updated · ${skipped} skipped · ${failed} failed`)

	if (changed > 0) {
		console.log(`\nFetching updated template branches…`)
		await fetchTemplate()
	}

	// Only restore the user's original branch if work was actually done. A
	// pure dry-run / no-op run leaves their CWD alone.
	const didWork = changed > 0
	if (didWork && originalBranch) {
		console.log(`\nRestoring template repo to ${originalBranch}…`)
		const result = await $`git -C ${templateDir} checkout ${originalBranch}`.quiet().nothrow()
		if (result.exitCode === 0) {
			console.log(`  ✅ on ${originalBranch}`)
			// Pull in any new commits — the script may have just pushed an
			// updated commit to this same branch (or to a remote that
			// advanced), so the local checkout is likely behind.
			console.log(`  ↻ git pull…`)
			const pullResult = await $`git -C ${templateDir} pull --ff-only`.quiet().nothrow()
			if (pullResult.exitCode === 0) {
				const pullOut = pullResult.stdout.toString().trim()
				if (pullOut) console.log(`  ✅ ${pullOut.split('\n').join(' · ')}`)
				else console.log(`  ✅ already up to date`)
			} else {
				console.log(`  ⚠ git pull failed: ${pullResult.stderr.toString().trim()}`)
				console.log(`  You may need to merge or rebase manually.`)
			}
		} else {
			console.log(`  ⚠ git checkout failed: ${result.stderr.toString().trim()}`)
			console.log(`  You may need to manually run: cd ${templateDir} && git checkout ${originalBranch}`)
		}
	} else if (!didWork && originalBranch) {
		console.log(`\nNo work done; left template repo on ${originalBranch}.`)
	} else if (!originalBranch) {
		console.log(`\nStarted on detached HEAD; left template repo on detached HEAD.`)
	}

	if (failed > 0) process.exit(1)
}

main().catch((err: Error) => {
	console.error('Error:', err.message ?? err)
	process.exit(1)
})

