/**
 * Update the `sandstone` dep in every maintained template branch
 * (pack-X.Y.0 and library-X.Y.0) to match the right channel:
 *
 *   - The template for the LIVE minor (the X.Y that npm's `@latest` is
 *     currently on) gets bumped to `^<@latest version>`. There is no
 *     per-minor dist-tag for the live minor — `@latest` IS its channel.
 *   - Every other template branch gets bumped to the per-minor dist-tag
 *     `sandstone-{X}-{Y}` (e.g. a 1.1 template gets `sandstone-1-1`).
 *     The actual version is resolved from npm so the lockfile pins a
 *     real SemVer, not the tag. If the per-minor tag isn't published
 *     yet, the highest `X.Y.*` version on npm is used as a fallback.
 *     Branches with no published version for that minor are skipped
 *     with a warning (no commit, no push).
 *
 * The script is fully self-contained: it queries npm for all version
 * data and only touches the template repo on disk. It does not read
 * the local `sandstone/` checkout — workspace state is irrelevant.
 *
 * Usage:
 *   bun template:sandstone-update             # interactive: confirm + iterate
 *   bun template:sandstone-update --dry-run   # show what would change
 *
 * Each branch:
 *   1. Inspect origin/<branch> package.json(s) WITHOUT checkout
 *   2. If a needed change is found: checkout detached, write, bun install,
 *      commit "⬆️ Update Sandstone", push
 *
 * Requires a clean `sandstone-template` working directory (refuses to start
 * otherwise). After the loop, the template repo is restored to the branch
 * the user was on when the script started — but only if work was done.
 */

import { $ } from 'bun'
import { access, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const templateDir = join(import.meta.dir, '..', 'sandstone-template')

async function fileExists(path: string): Promise<boolean> {
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
		.sort()
}

/**
 * The X.Y minor of a template branch. Returns null if the branch name
 * doesn't match the maintained shape (caller should have filtered).
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

/**
 * npm package document for `sandstone`. Holds the dist-tags map and the
 * full versions list — everything we need to decide what version each
 * template branch should pin to without ever touching the workspace.
 */
interface NpmSandstone {
	distTags: Record<string, string> // e.g. { latest: "1.2.8", "sandstone-1-0": "1.0.8", ... }
	versions: string[] // every published version, may include prereleases
	latestVersion: string // distTags.latest — the live version
	latestMinor: string // X.Y of latestVersion, e.g. "1.2"
	/** Version to pin a template for the given major.minor to. */
	resolveForMinor(major: number, minor: number): { version: string; via: 'dist-tag' | 'fallback' } | null
}

/**
 * Fetch the full sandstone npm document and wrap it in helpers.
 * The doc is fetched once and reused for every branch decision.
 */
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
	return {
		distTags,
		versions,
		latestVersion,
		latestMinor: latestMinorKey,
		resolveForMinor(major, minor) {
			const tag = `sandstone-${major}-${minor}`
			const tagged = distTags[tag]
			if (tagged) return { version: tagged, via: 'dist-tag' }
			// Fallback: highest published X.Y.* version (stable patches only —
			// prereleases would surprise users on `bun install`).
			const prefix = `${major}.${minor}.`
			const patches = versions
				.filter((v) => v.startsWith(prefix) && !v.includes('-'))
				.map((v) => Number(v.slice(prefix.length)))
				.filter((n) => Number.isFinite(n))
				.sort((a, b) => b - a)
			if (patches.length === 0) return null
			return { version: `${major}.${minor}.${patches[0]}`, via: 'fallback' }
		},
	}
}

interface FileChange {
	path: string // relative to templateDir, e.g. "package.json"
	oldVersion: string | null // null if no sandstone dep was present
	newVersion: string // the version we tried to set (e.g. "^1.2.3")
	via: 'latest' | `dist-tag:${string}` | 'fallback' // provenance for the summary
}

interface BranchResult {
	branch: string
	channel: 'latest' | `dist-tag:${string}` | 'fallback' | 'skipped-no-tag'
	fileChanges: FileChange[]
	committed: boolean
	error?: string
}

/**
 * Overwrite the sandstone dep in a package.json. Caller is responsible
 * for verifying the old version differs from the new version first.
 * Preserves the existing key (dependencies vs devDependencies) when
 * the dep is already present.
 */
async function writeSandstoneVersion(filePath: string, newVersion: string): Promise<void> {
	const raw = await readFile(filePath, 'utf8')
	const pkg = JSON.parse(raw) as {
		dependencies?: Record<string, string>
		devDependencies?: Record<string, string>
	}
	// Same lookup pattern as the cli-update script: prefer dependencies if
	// sandstone is already there, otherwise devDependencies.
	const targetKey: 'dependencies' | 'devDependencies' = pkg.dependencies?.sandstone != null
		? 'dependencies'
		: 'devDependencies'
	pkg[targetKey] = { ...(pkg[targetKey] ?? {}), sandstone: newVersion }
	await writeFile(filePath, JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * Read both package.json files for a branch WITHOUT checking it out.
 * Uses `git show origin/<branch>:<path>` so the user's working directory
 * is never mutated during inspection (including dry-run passes).
 * `via` is the channel label that produced the target version (for the
 * summary output).
 */
async function inspectBranch(branch: string, newVersion: string, via: FileChange['via']): Promise<FileChange[]> {
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
		const rootCurrent = rootPkg.dependencies?.sandstone ?? rootPkg.devDependencies?.sandstone ?? null
		log(`root sandstone = ${rootCurrent ?? '∅'}`)

		const changes: FileChange[] = []
		if (rootCurrent !== newVersion) {
			changes.push({ path: 'package.json', oldVersion: rootCurrent, newVersion, via })
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
				const testCurrent = testPkg.dependencies?.sandstone ?? testPkg.devDependencies?.sandstone ?? null
				log(`test sandstone = ${testCurrent ?? '∅'}`)
				if (testCurrent !== newVersion) {
					changes.push({ path: 'test/package.json', oldVersion: testCurrent, newVersion, via })
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
			await writeSandstoneVersion(abs, c.newVersion)
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
		await $`git -C ${templateDir} commit -m ${'⬆️ Update Sandstone'}`.quiet()
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
	console.log(`Usage: bun template:sandstone-update [options]

Options:
  --dry-run    Show what would change without touching the template repo
  --help, -h   Show this help

Iterates every maintained pack-X.Y.0 / library-X.Y.0 branch on the template
remote and bumps the \`sandstone\` dep:

  - LIVE minor (the X.Y that npm \`@latest\` is on) →
    \`^<@latest version>\` (e.g. \`^1.2.8\`). There is no per-minor dist-tag
    for the live minor — \`@latest\` is its channel.
  - Every other minor → per-minor dist-tag \`sandstone-{X}-{Y}\` resolved
    to the actual published version (e.g. \`^1.1.5\`). If the tag isn't
    published, the highest \`X.Y.*\` stable version on npm is used as a
    fallback. Branches with no published version for that minor are
    skipped with a warning.

Refreshes bun.lock, commits "⬆️ Update Sandstone" + pushes.`)
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

	const npm = await fetchSandstoneNpm()
	const branches = await listMaintainedTemplateBranches()
	if (branches.length === 0) {
		console.error('Error: no maintained template branches found.')
		process.exit(1)
	}

	console.log(`npm @latest sandstone: ${npm.latestVersion} (live minor ${npm.latestMinor})`)
	console.log(`Maintained template branches (${branches.length}):`)
	for (const b of branches) {
		const parsed = parseMinor(b)
		const channel = parsed?.minorKey === npm.latestMinor
			? 'latest'
			: parsed ? `sandstone-${parsed.major}-${parsed.minor}` : '?'
		console.log(`  - ${b}  [${channel}]`)
	}

	if (!dryRun) {
		const { confirm } = await import('@inquirer/prompts')
		const proceed = await confirm({
			message: `Update sandstone across all ${branches.length} branches and push each?`,
			default: false,
		})
		if (!proceed) {
			console.log('Cancelled.')
			process.exit(0)
		}
	}

	// Resolve target versions up-front so a missing tag doesn't waste a
	// checkout — and the dry-run summary stays accurate.
	interface ResolvedBranch {
		branch: string
		targetVersion: string
		via: FileChange['via']
		skipped: boolean
		skippedReason?: string
	}
	const resolved: ResolvedBranch[] = []
	for (const branch of branches) {
		const parsed = parseMinor(branch)
		if (!parsed) continue
		if (parsed.minorKey === npm.latestMinor) {
			resolved.push({ branch, targetVersion: `^${npm.latestVersion}`, via: 'latest', skipped: false })
			continue
		}
		const tag = `sandstone-${parsed.major}-${parsed.minor}`
		const found = npm.resolveForMinor(parsed.major, parsed.minor)
		if (found === null) {
			resolved.push({ branch, targetVersion: '', via: `dist-tag:${tag}`, skipped: true, skippedReason: `no published version for ${parsed.minorKey}` })
			continue
		}
		resolved.push({ branch, targetVersion: `^${found.version}`, via: found.via === 'dist-tag' ? `dist-tag:${tag}` : 'fallback', skipped: false })
	}

	const results: BranchResult[] = []
	for (const r of resolved) {
		console.log(`\n${r.branch}…`)
		if (r.skipped) {
			console.log(`  ⚠ skipped: ${r.skippedReason}`)
			results.push({ branch: r.branch, channel: r.via, fileChanges: [], committed: false })
			continue
		}

		const fileChanges = await inspectBranch(r.branch, r.targetVersion, r.via)

		if (fileChanges.length === 0) {
			console.log(`  — no change (already at ${r.targetVersion})`)
			results.push({ branch: r.branch, channel: r.via, fileChanges: [], committed: false })
			continue
		}

		if (dryRun) {
			console.log(`  ↻ would change ${fileChanges.map(formatChange).join('; ')}`)
			results.push({ branch: r.branch, channel: r.via, fileChanges, committed: false })
			continue
		}

		// We have changes — checkout, write, install, commit, push.
		const applied = await applyBranch(r.branch, fileChanges, dryRun)
		if (applied.error) {
			console.log(`  ❌ error: ${applied.error}`)
			results.push({ branch: r.branch, channel: r.via, fileChanges, committed: false, error: applied.error })
		} else if (applied.committed) {
			console.log(`  ✅ ${fileChanges.map(formatChange).join('; ')}`)
			results.push({ branch: r.branch, channel: r.via, fileChanges, committed: true })
		} else {
			console.log(`  — no changes after lockfile sync`)
			results.push({ branch: r.branch, channel: r.via, fileChanges, committed: false })
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
