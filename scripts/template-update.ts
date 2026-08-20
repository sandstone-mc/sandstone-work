/**
 * Update template branches (pack-X.Y.0 / library-X.Y.0) to the right
 * version of every sandstone ecosystem dep we track — currently
 * `sandstone` and `sandstone-cli` — in a single pass.
 *
 *   bun template:update             # interactive: confirm + iterate all
 *   bun template:update --dry-run   # show what would change
 *
 * For each maintained branch:
 *   1. Resolve target versions for both deps
 *      - `sandstone`: npm registry. Live minor uses `@latest`; archived
 *        minors use the `sandstone-{X}-{Y}` dist-tag (falls back to highest
 *        X.Y.* stable version when the tag isn't published).
 *      - `sandstone-cli`: `^<workspace sandstone-cli/package.json version>`.
 *   2. Inspect root + test/package.json WITHOUT checkout (git show).
 *   3. If any dep actually changed, detached-checkout + write + clear
 *      node_modules + bun install + commit + push.
 *
 * Branches with no changes are skipped (no CWD mutation). After the loop,
 * the template repo is restored to the branch the user was on when the
 * script started — but only if work was done. After restoring, the script
 * wipes node_modules and runs the template's own `bun run setup` (= `bun
 * link && bun i`) against the restored branch.
 *
 * Commit message is dynamic:
 *   - both deps changed   → "⬆️ Update Sandstone + CLI"
 *   - only sandstone      → "⬆️ Update Sandstone"
 *   - only sandstone-cli  → "⬆️ Update CLI"
 *
 * Requires a clean `sandstone-template` working directory.
 */

import { $ } from 'bun'
import { access, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const rootDir = join(import.meta.dir, '..')
const templateDir = join(rootDir, 'sandstone-template')
const cliDir = join(rootDir, 'sandstone-cli')

const SANDSTONE = 'sandstone' as const
const SANDSTONE_CLI = 'sandstone-cli' as const
type DepName = typeof SANDSTONE | typeof SANDSTONE_CLI

interface FileChange {
	path: string // relative to templateDir, e.g. "package.json"
	dep: DepName
	oldVersion: string | null
	newVersion: string
}

interface BranchPlan {
	branch: string
	sandstoneTarget: string // "~1.2.8" — empty if branch should be skipped for sandstone
	sandstoneVia: string
	sandstoneSkipReason?: string
	cliTarget: string // "^2.6.2"
	fileChanges: FileChange[]
	committed: boolean
	error?: string
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
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
	return out
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const parts = l.split(/\s+/)
			return parts[1] ?? ''
		})
		.map((ref) => ref.replace('refs/heads/', ''))
		// Maintained branches are pack-X.Y.0 / library-X.Y.0 — patch slot is
		// always 0 (template tracks sandstone minors, not individual patches).
		.filter((b) => /^(?:pack|library)-(\d+)\.(\d+)\.0$/.test(b))
		// Numeric sort by (major, minor) — `.sort()` is alphabetic and would
		// put `pack-1.10.0` before `pack-1.2.0`. Tiebreak alphabetically so
		// the iteration order is stable when pack/library share a minor.
		.sort((a, b) => {
			const pa = parseMinor(a)
			const pb = parseMinor(b)
			if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0
			if (pa.major !== pb.major) return pa.major - pb.major
			if (pa.minor !== pb.minor) return pa.minor - pb.minor
			return a < b ? -1 : a > b ? 1 : 0
		})
}

/**
 * X.Y minor of a maintained branch name. Returns null if the branch doesn't
 * match the `pack-X.Y.0` / `library-X.Y.0` shape.
 */
function parseMinor(branch: string): { major: number; minor: number; minorKey: string } | null {
	const m = branch.match(/^(?:pack|library)-(\d+)\.(\d+)\.0$/)
	if (!m) return null
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		minorKey: `${m[1]}.${m[2]}`,
	}
}

/**
 * X.Y minor of a SemVer version (e.g. "1.0" for "1.0.8"). Returns null
 * if the string isn't a recognisable version.
 */
function minorOf(version: string): string | null {
	const m = version.match(/^(\d+)\.(\d+)(?:\.\d+)?/)
	if (!m) return null
	return `${m[1]}.${m[2]}`
}

// ---------- target resolution ----------

interface NpmSandstone {
	distTags: Record<string, string>
	versions: string[]
	latestVersion: string
	latestMinor: string
}

async function fetchSandstoneNpm(): Promise<NpmSandstone> {
	const response = await fetch('https://registry.npmjs.org/sandstone')
	if (!response.ok) {
		throw new Error(`Failed to fetch sandstone metadata: ${response.statusText}`)
	}
	const data = await response.json() as { 'dist-tags'?: Record<string, string>; versions?: Record<string, unknown> }
	const distTags = data['dist-tags'] ?? {}
	const versions = Object.keys(data.versions ?? {})
	const latestVersion = distTags.latest
	if (!latestVersion) {
		throw new Error('sandstone npm doc has no `latest` dist-tag — refusing to proceed')
	}
	const latestMinorKey = minorOf(latestVersion)
	if (latestMinorKey === null) {
		throw new Error(`sandstone @latest version "${latestVersion}" is not a recognisable SemVer`)
	}
	return { distTags, versions, latestVersion, latestMinor: latestMinorKey }
}

interface SandstoneTarget {
	target: string // "^1.2.8"
	via: string // 'latest' | `dist-tag:sandstone-1-1` | 'fallback'
	skipReason?: string
}

function resolveSandstoneForMinor(npm: NpmSandstone, branch: string): SandstoneTarget {
	const parsed = parseMinor(branch)
	if (!parsed) {
		// Should never happen — caller filtered branches by the maintained shape.
		return { target: '', via: '?', skipReason: 'unparseable branch name' }
	}
	if (parsed.minorKey === npm.latestMinor) {
		return { target: `~${npm.latestVersion}`, via: 'latest' }
	}
	const tag = `sandstone-${parsed.major}-${parsed.minor}`
	const tagged = npm.distTags[tag]
	if (tagged) {
		return { target: `~${tagged}`, via: `dist-tag:${tag}` }
	}
	// Fallback: highest published X.Y.* stable version (prereleases would
	// surprise users on `bun install`).
	const prefix = `${parsed.major}.${parsed.minor}.`
	const patches = npm.versions
		.filter((v) => v.startsWith(prefix) && !v.includes('-'))
		.map((v) => Number(v.slice(prefix.length)))
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => b - a)
	if (patches.length === 0) {
		return { target: '', via: `dist-tag:${tag}`, skipReason: `no published version for ${parsed.minorKey}` }
	}
	return { target: `~${parsed.major}.${parsed.minor}.${patches[0]}`, via: 'fallback' }
}

async function getWorkspaceCliVersion(): Promise<string> {
	if (!(await pathExists(join(cliDir, 'package.json')))) {
		throw new Error(`sandstone-cli not found at ${cliDir}. Run \`bun run setup\` first.`)
	}
	const pkgRaw = await readFile(join(cliDir, 'package.json'), 'utf8')
	const { version } = JSON.parse(pkgRaw) as { version: string }
	if (!version) throw new Error('sandstone-cli/package.json has no version')
	return `^${version}`
}

// ---------- inspection & writing ----------

interface PackageJsonShape {
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

function readDep(pkg: PackageJsonShape, dep: DepName): string | null {
	return pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep] ?? null
}

/**
 * Overwrite a dep in a package.json. Preserves the existing key (dependencies
 * vs devDependencies) when the dep is already present, otherwise prefers
 * devDependencies.
 */
async function writeDepVersion(filePath: string, dep: DepName, newVersion: string): Promise<void> {
	const raw = await readFile(filePath, 'utf8')
	const pkg = JSON.parse(raw) as PackageJsonShape
	const targetKey: 'dependencies' | 'devDependencies' =
		pkg.dependencies?.[dep] != null ? 'dependencies' : 'devDependencies'
	pkg[targetKey] = { ...(pkg[targetKey] ?? {}), [dep]: newVersion }
	await writeFile(filePath, JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * Read both package.json files for a branch WITHOUT checking it out.
 * Uses `git show origin/<branch>:<path>` so the user's working directory
 * is never mutated during inspection (including dry-run passes).
 * Returns the changes that WOULD be made (empty = already up to date).
 */
async function inspectBranch(
	branch: string,
	sandstoneTarget: string,
	cliTarget: string,
): Promise<FileChange[]> {
	const debug = process.env.DEBUG_TPL_UPDATE === '1'
	const log = (msg: string) => { if (debug) console.error(`  [debug] ${msg}`) }
	try {
		log(`reading origin/${branch}:package.json`)
		const rootShow = await $`git -C ${templateDir} show origin/${branch}:package.json`.quiet()
		if (rootShow.exitCode !== 0) {
			log(`could not read package.json (exit ${rootShow.exitCode}); treating as no-op`)
			return []
		}
		const rootPkg = JSON.parse(rootShow.stdout.toString()) as PackageJsonShape
		const rootSandstone = readDep(rootPkg, SANDSTONE)
		const rootCli = readDep(rootPkg, SANDSTONE_CLI)
		log(`root sandstone = ${rootSandstone ?? '∅'}; sandstone-cli = ${rootCli ?? '∅'}`)

		const changes: FileChange[] = []
		if (rootSandstone !== sandstoneTarget) {
			changes.push({ path: 'package.json', dep: SANDSTONE, oldVersion: rootSandstone, newVersion: sandstoneTarget })
		}
		if (rootCli !== cliTarget) {
			changes.push({ path: 'package.json', dep: SANDSTONE_CLI, oldVersion: rootCli, newVersion: cliTarget })
		}

		// Check whether test/package.json exists via ls-tree (no checkout).
		log(`checking for origin/${branch}:test/package.json`)
		const testLs = await $`git -C ${templateDir} ls-tree origin/${branch} -- test/package.json`.quiet()
		const hasTest = testLs.stdout.toString().trim().length > 0
		if (hasTest) {
			log(`reading origin/${branch}:test/package.json`)
			const testShow = await $`git -C ${templateDir} show origin/${branch}:test/package.json`.quiet()
			if (testShow.exitCode === 0) {
				const testPkg = JSON.parse(testShow.stdout.toString()) as PackageJsonShape
				const testSandstone = readDep(testPkg, SANDSTONE)
				const testCli = readDep(testPkg, SANDSTONE_CLI)
				log(`test sandstone = ${testSandstone ?? '∅'}; sandstone-cli = ${testCli ?? '∅'}`)
				if (testSandstone !== sandstoneTarget) {
					changes.push({ path: 'test/package.json', dep: SANDSTONE, oldVersion: testSandstone, newVersion: sandstoneTarget })
				}
				if (testCli !== cliTarget) {
					changes.push({ path: 'test/package.json', dep: SANDSTONE_CLI, oldVersion: testCli, newVersion: cliTarget })
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

// ---------- apply ----------

function commitMessageFor(changes: FileChange[]): string {
	const hasSandstone = changes.some((c) => c.dep === SANDSTONE)
	const hasCli = changes.some((c) => c.dep === SANDSTONE_CLI)
	if (hasSandstone && hasCli) return '⬆️ Update Sandstone + CLI'
	if (hasSandstone) return '⬆️ Update Sandstone'
	return '⬆️ Update CLI'
}

/**
 * Apply pre-computed changes to a branch. Checks out, writes files, clears
 * node_modules, runs bun install, commits, pushes, then pulls to update the
 * local tracking ref. Only called for branches where `inspectBranch` found
 * actual differences — so a no-op branch never mutates the CWD.
 *
 * Branches are checked out directly (not detached) — iterating the script
 * moves the user's CWD from branch to branch. The final restore step in
 * `restoreTemplateBranch` puts them back on the branch they started on.
 */
async function applyBranch(
	branch: string,
	changes: FileChange[],
	dryRun: boolean,
): Promise<{ committed: boolean; error?: string }> {
	try {
		console.log(`  ↻ git checkout ${branch}…`)
		await $`git -C ${templateDir} checkout ${branch}`.quiet().nothrow()

		const rootPkgPath = join(templateDir, 'package.json')
		const testPkgPath = join(templateDir, 'test', 'package.json')

		for (const c of changes) {
			const abs = c.path === 'test/package.json' ? testPkgPath : rootPkgPath
			if (dryRun) continue
			await writeDepVersion(abs, c.dep, c.newVersion)
		}

		if (dryRun) {
			return { committed: false }
		}

		// Clear node_modules so bun install regenerates from scratch — a stale
		// install can leave bun.lock out of sync with the new package.json.
		// `test/node_modules` only exists on library branches (bun workspaces
		// sometimes create it during `bun run setup`), so check before rm.
		console.log(`  ↻ clearing node_modules…`)
		await $`rm -rf ${join(templateDir, 'node_modules')}`.quiet().nothrow()
		const testNodeModules = join(templateDir, 'test', 'node_modules')
		if (await pathExists(testNodeModules)) {
			await $`rm -rf ${testNodeModules}`.quiet().nothrow()
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

		const message = commitMessageFor(changes)
		console.log(`  ↻ committing (${message})…`)
		await $`git -C ${templateDir} commit -m ${message}`.quiet()
		console.log(`  ↻ pushing to origin/${branch}…`)
		await $`git -C ${templateDir} push origin ${branch}`.quiet().nothrow()
		// Pull to update the local tracking ref. We pushed via `<local>:<remote>`
		// which doesn't sync origin/<branch> back into the local tracking ref —
		// without this, subsequent iterations on this branch see stale refs.
		console.log(`  ↻ git pull…`)
		const pullResult = await $`git -C ${templateDir} pull --ff-only`.quiet().nothrow()
		if (pullResult.exitCode !== 0) {
			const stderr = pullResult.stderr.toString().trim()
			return { committed: true, error: `pull after push failed: ${stderr}` }
		}
		return { committed: true }
	} catch (e) {
		return { committed: false, error: (e as Error).message ?? String(e) }
	}
}

// ---------- main ----------

interface ParsedArgs {
	dryRun: boolean
	help: boolean
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2)
	return {
		dryRun: args.includes('--dry-run'),
		help: args.includes('--help') || args.includes('-h'),
	}
}

function showHelp(): void {
	console.log(`Usage: bun template:update [options]

Updates both \`sandstone\` and \`sandstone-cli\` across every maintained
pack-X.Y.0 / library-X.Y.0 branch on the template remote in a single pass.

  - \`sandstone\`        → npm registry. Live minor = \`@latest\`; archived
                          minors = \`sandstone-{X}-{Y}\` dist-tag (falls back
                          to highest X.Y.* stable version).
  - \`sandstone-cli\`    → \`^<workspace sandstone-cli/package.json version>\`.

One commit per branch, even if both deps change — commit message reflects
which deps actually moved ("⬆️ Update Sandstone", "⬆️ Update CLI", or
"⬆️ Update Sandstone + CLI"). Branches with no changes are skipped.

Options:
  --dry-run    Show what would change without touching the template repo
  --help, -h   Show this help`)
}

function formatChange(c: FileChange): string {
	const from = c.oldVersion ?? '∅'
	return `${c.path} (${c.dep}): ${from} → ${c.newVersion}`
}

async function restoreTemplateBranch(originalBranch: string | null, didWork: boolean): Promise<void> {
	if (!originalBranch) {
		if (didWork) console.log('\nStarted on detached HEAD; left template repo on detached HEAD.')
		return
	}
	if (!didWork) {
		console.log(`\nNo work done; left template repo on ${originalBranch}.`)
		return
	}
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
			return
		}

		// Wipe node_modules so `bun run setup` (= `bun link && bun i`) gets
		// a clean install against the restored branch's deps. `test/node_modules`
		// only exists on library branches (workspaces create it during setup).
		console.log(`  ↻ clearing node_modules…`)
		await $`rm -rf ${join(templateDir, 'node_modules')}`.quiet().nothrow()
		const testNodeModules = join(templateDir, 'test', 'node_modules')
		if (await pathExists(testNodeModules)) {
			await $`rm -rf ${testNodeModules}`.quiet().nothrow()
		}
		console.log(`  ↻ bun run setup…`)
		const setupResult = await $`bun run setup`.cwd(templateDir).nothrow()
		if (setupResult.exitCode === 0) {
			console.log(`  ✅ setup complete`)
		} else {
			console.log(`  ⚠ bun run setup failed: ${setupResult.stderr.toString().trim() || setupResult.stdout.toString().trim()}`)
		}
	} else {
		console.log(`  ⚠ git checkout failed: ${result.stderr.toString().trim()}`)
		console.log(`  You may need to manually run: cd ${templateDir} && git checkout ${originalBranch}`)
	}
}

async function main(): Promise<void> {
	const { dryRun, help } = parseArgs()
	if (help) {
		showHelp()
		process.exit(0)
	}
	if (!(await pathExists(templateDir))) {
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

	const branches = await listMaintainedTemplateBranches()
	if (branches.length === 0) {
		console.error('Error: no maintained template branches found.')
		process.exit(1)
	}

	// Resolve both dep targets up-front so a missing npm tag doesn't waste
	// a checkout, and the dry-run summary stays accurate.
	const [npm, cliVersion] = await Promise.all([fetchSandstoneNpm(), getWorkspaceCliVersion()])
	console.log(`npm @latest sandstone: ${npm.latestVersion} (live minor ${npm.latestMinor})`)
	console.log(`Workspace sandstone-cli version: ${cliVersion}`)
	console.log(`Maintained template branches (${branches.length}):`)
	for (const b of branches) {
		const ss = resolveSandstoneForMinor(npm, b)
		const ssLabel = ss.target ? `${ss.target} (via ${ss.via})` : `${ss.via}${ss.skipReason ? ` (skip: ${ss.skipReason})` : ''}`
		console.log(`  - ${b}  [sandstone: ${ssLabel}, cli: ${cliVersion}]`)
	}

	if (!dryRun) {
		const { confirm } = await import('@inquirer/prompts')
		const proceed = await confirm({
			message: `Update sandstone + sandstone-cli across all ${branches.length} branches and push each?`,
			default: false,
		})
		if (!proceed) {
			console.log('Cancelled.')
			process.exit(0)
		}
	}

	const plans: BranchPlan[] = []
	for (const branch of branches) {
		console.log(`\n${branch}…`)
		const ss = resolveSandstoneForMinor(npm, branch)
		if (ss.skipReason) {
			console.log(`  ⚠ sandstone: ${ss.skipReason}`)
		}

		const fileChanges = await inspectBranch(branch, ss.target, cliVersion)
		if (fileChanges.length === 0) {
			console.log(`  — no change (already up to date)`)
			plans.push({
				branch,
				sandstoneTarget: ss.target,
				sandstoneVia: ss.via,
				sandstoneSkipReason: ss.skipReason,
				cliTarget: cliVersion,
				fileChanges: [],
				committed: false,
			})
			continue
		}

		if (dryRun) {
			console.log(`  ↻ would change ${fileChanges.map(formatChange).join('; ')}`)
			plans.push({
				branch,
				sandstoneTarget: ss.target,
				sandstoneVia: ss.via,
				sandstoneSkipReason: ss.skipReason,
				cliTarget: cliVersion,
				fileChanges,
				committed: false,
			})
			continue
		}

		const applied = await applyBranch(branch, fileChanges, dryRun)
		if (applied.error) {
			console.log(`  ❌ error: ${applied.error}`)
			plans.push({
				branch,
				sandstoneTarget: ss.target,
				sandstoneVia: ss.via,
				sandstoneSkipReason: ss.skipReason,
				cliTarget: cliVersion,
				fileChanges,
				committed: false,
				error: applied.error,
			})
		} else if (applied.committed) {
			console.log(`  ✅ ${fileChanges.map(formatChange).join('; ')}`)
			plans.push({
				branch,
				sandstoneTarget: ss.target,
				sandstoneVia: ss.via,
				sandstoneSkipReason: ss.skipReason,
				cliTarget: cliVersion,
				fileChanges,
				committed: true,
			})
		} else {
			console.log(`  — no changes after lockfile sync`)
			plans.push({
				branch,
				sandstoneTarget: ss.target,
				sandstoneVia: ss.via,
				sandstoneSkipReason: ss.skipReason,
				cliTarget: cliVersion,
				fileChanges,
				committed: false,
			})
		}
	}

	const changed = plans.filter((p) => p.committed).length
	const skipped = plans.filter((p) => !p.committed && !p.error).length
	const failed = plans.filter((p) => p.error).length
	console.log(`\nSummary: ${changed} updated · ${skipped} skipped · ${failed} failed`)

	if (changed > 0) {
		console.log(`\nFetching updated template branches…`)
		await fetchTemplate()
	}

	await restoreTemplateBranch(originalBranch, changed > 0)

	if (failed > 0) process.exit(1)
}

main().catch((err: Error) => {
	console.error('Error:', err.message ?? err)
	process.exit(1)
})