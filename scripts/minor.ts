/**
 * Switch sandstone + template to a different minor version (live master or
 * an archived v{X}.{Y}.x branch).
 *
 * Usage:
 *   bun dev:minor              - interactive
 *   bun dev:minor 1.0          - jump straight to 1.0.x
 *   bun dev:minor --library    - use library template instead of pack
 *   bun dev:minor --help       - show help
 *
 * The script lists each candidate minor EXACTLY ONCE:
 *   - The current master minor (derived from origin/master's package.json
 *     version) gets one entry labelled "Latest (master)".
 *   - Each remote v{X}.{Y}.x branch gets one entry labelled "X.Y".
 * A minor that is currently in master does NOT also appear as a v*.x
 * entry — that branch only exists after the minor is replaced in master.
 */

import { $ } from 'bun'
import { access } from 'fs/promises'
import { join } from 'path'
import { select } from '@inquirer/prompts'

import { sandstoneMinorToMCString } from './sandstoneToMC.ts'

const rootDir = join(import.meta.dir, '..')
const sandstoneDir = join(rootDir, 'sandstone')
const templateDir = join(rootDir, 'sandstone-template')

type TemplateType = 'pack' | 'library'

interface CandidateMinor {
	label: string
	value: string // 'master' or 'X.Y'
	description: string // MC version suffix
	disabled?: boolean
	disabledReason?: string
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function fetchRemote(cwd: string): Promise<void> {
	await $`git -C ${cwd} fetch --prune`.quiet().nothrow()
}

async function getRemoteBranches(cwd: string): Promise<string[]> {
	const result = await $`git -C ${cwd} branch -r`.quiet().nothrow()
	if (result.exitCode !== 0) return []
	return result.stdout
		.toString()
		.split('\n')
		.map((b) => b.trim())
		.filter((b) => b && !b.includes('->'))
		.map((b) => b.replace('origin/', ''))
}

/**
 * Each v{X}.{Y}.x branch on sandstone represents an archived minor (created by
 * scripts/release.ts as `v${prevMinor}.x`, e.g. v1.0.x).
 *
 * Returns the bare `X.Y` minors, sorted ascending.
 */
async function getRemoteArchivedMinors(cwd: string): Promise<string[]> {
	const branches = await getRemoteBranches(cwd)
	const minors = new Set<string>()
	for (const b of branches) {
		const m = b.match(/^v(\d+)\.(\d+)\.x$/)
		if (m) minors.add(`${m[1]}.${m[2]}`)
	}
	return [...minors].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** The `X.Y` minor currently live in sandstone's master, or null. */
async function getMasterMinorFromPackageJson(): Promise<string | null> {
	try {
		const result = await $`git -C ${sandstoneDir} show origin/master:package.json`.quiet().nothrow()
		if (result.exitCode !== 0) return null
		const pkg = JSON.parse(result.stdout.toString()) as { version?: string }
		if (!pkg.version) return null
		const m = pkg.version.match(/^(\d+)\.(\d+)\./)
		if (!m) return null
		return `${m[1]}.${m[2]}`
	} catch {
		return null
	}
}

/** `1.0` -> the MC version string for sandstone minor 0. */
function minorToMC(minor: string): string {
	return sandstoneMinorToMCString(parseInt(minor.split('.')[1] ?? '0', 10))
}

async function templateBranchExists(type: TemplateType, minor: string): Promise<boolean> {
	const branchName = `${type}-${minor}.0`
	try {
		const result = await $`git -C ${templateDir} ls-remote --heads origin ${branchName}`.quiet().nothrow()
		return result.exitCode === 0 && result.stdout.toString().trim().length > 0
	} catch {
		return false
	}
}

async function checkoutBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
	const reset = await $`git -C ${cwd} reset --hard`.quiet().nothrow()
	if (reset.exitCode !== 0) return { ok: false, error: reset.stderr.toString().trim() }
	const clean = await $`git -C ${cwd} clean -fdx`.quiet().nothrow()
	if (clean.exitCode !== 0) return { ok: false, error: clean.stderr.toString().trim() }

	// If the branch doesn't exist locally, create it tracking origin explicitly.
	// A bare `git checkout <branch>` fails outright when more than one remote
	// carries that branch (common when a contributor has a fork remote added).
	const localExists = await $`git -C ${cwd} rev-parse --verify --quiet refs/heads/${branch}`.quiet().nothrow()
	const checkout = localExists.exitCode === 0
		? await $`git -C ${cwd} checkout ${branch}`.quiet().nothrow()
		: await $`git -C ${cwd} checkout -b ${branch} --track origin/${branch}`.quiet().nothrow()
	if (checkout.exitCode !== 0) return { ok: false, error: checkout.stderr.toString().trim() }
	return { ok: true }
}

function parseArgs(): { minor?: string; type: TemplateType; help: boolean } {
	const args = process.argv.slice(2)
	// Accept `1.0`, `1.0.0`, `v1.0`, or `1.0.x` as the positional minor arg.
	const minor = args.find((a) => /^(v?\d+)\.(\d+)(\.(x|\d+))?$/.test(a))
	// Normalise to the bare `X.Y` minor used as the candidate value.
	const normalised = minor?.replace(/^v/, '').split('.').slice(0, 2).join('.')
	return {
		minor: normalised,
		type: args.includes('--library') ? 'library' : 'pack',
		help: args.includes('--help') || args.includes('-h'),
	}
}

function showHelp(): void {
	console.log(`Usage: bun dev:minor [options] [<minor>]

Options:
  --library    Use library template instead of pack template
  --help, -h   Show this help message

Arguments:
  <minor>      Minor version to switch to (e.g. 1.0); skips the prompt

Examples:
  bun dev:minor              Interactive: pick a minor version
  bun dev:minor 1.0          Switch to archived 1.0.x + pack-1.0.0
  bun dev:minor 1.0 --library  Switch to 1.0.x + library-1.0.0`)
}

async function main(): Promise<void> {
	const { minor: requestedMinor, type, help } = parseArgs()

	if (help) {
		showHelp()
		process.exit(0)
	}

	if (!(await fileExists(sandstoneDir))) {
		console.error('Error: sandstone repo not found. Run `bun run setup` first.')
		process.exit(1)
	}
	if (!(await fileExists(templateDir))) {
		console.error('Error: sandstone-template repo not found. Run `bun run setup` first.')
		process.exit(1)
	}

	process.stdout.write('Fetching branches... ')
	await Promise.all([fetchRemote(sandstoneDir), fetchRemote(templateDir)])
	console.log('done')

	const masterMinor = await getMasterMinorFromPackageJson()
	const archivedMinors = await getRemoteArchivedMinors(sandstoneDir)

	if (masterMinor == null && archivedMinors.length === 0) {
		console.error('Error: could not determine available minors.')
		process.exit(1)
	}

	// Build candidates
	const candidates: CandidateMinor[] = []

	// Master entry — current minor
	if (masterMinor != null) {
		candidates.push({
			label: `Latest (master)`,
			value: 'master',
			description: `MC ${minorToMC(masterMinor)}`,
		})
	}

	// Archived minors — each remote v*.x branch once. Filter out the one that
	// matches master (the one in master has no v*.x branch yet, so this is just
	// defensive: if for some reason origin/master's package.json lags and a
	// v{masterMinor}.x branch already exists, skip it).
	for (const minor of archivedMinors) {
		if (minor === masterMinor) continue
		const exists = await templateBranchExists(type, minor)
		const candidate: CandidateMinor = {
			label: minor,
			value: minor,
			description: `MC ${minorToMC(minor)}`,
		}
		if (!exists) {
			candidate.disabled = true
			candidate.disabledReason = `no ${type}-${minor}.0 template branch yet`
		}
		candidates.push(candidate)
	}

	if (candidates.length === 0) {
		console.error('Error: no selectable minor versions.')
		process.exit(1)
	}

	let chosen: CandidateMinor

	if (requestedMinor) {
		const found = candidates.find((c) => c.value === requestedMinor)
		if (!found) {
			const available = candidates.map((c) => c.value).join(', ')
			console.error(`Error: minor ${requestedMinor} not found in available candidates (${available}).`)
			process.exit(1)
		}
		if (found.disabled) {
			console.error(`Error: ${found.label} is not selectable (${found.disabledReason}).`)
			process.exit(1)
		}
		chosen = found
	} else {
		chosen = await select({
			message: `Switch sandstone (and ${type} template) to which minor?`,
			choices: candidates.map((c) => ({
				name: c.label,
				value: c,
				description: c.disabled ? c.disabledReason : c.description,
				disabled: c.disabled,
			})),
		})
	}

	// Resolve target branches
	const sandstoneTarget = chosen.value === 'master' ? 'master' : `v${chosen.value}.x`
	// Baseline: `{type}-{minor}.0`. For master this is refined below to the
	// highest existing `{type}-{masterMinor}.X` branch, if there is more than one.
	const templateTarget = chosen.value === 'master'
		? `${type}-${masterMinor}.0`
		: `${type}-${chosen.value}.0`

	// For master, prefer the highest existing pack/library branch matching the master minor.
	let resolvedTemplateTarget = templateTarget
	if (chosen.value === 'master' && masterMinor != null) {
		const allBranches = await getRemoteBranches(templateDir)
		const matching = allBranches
			.filter((b) => b.startsWith(`${type}-${masterMinor}.`) && /^\d+\.\d+\.\d+$/.test(b.split(`${type}-`)[1] ?? ''))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
		if (matching.length > 0) {
			resolvedTemplateTarget = matching[0]!
		}
	}

	const templatePretty = chosen.value === 'master' ? 'master (default template)' : resolvedTemplateTarget

	console.log('')
	console.log(`Selected: sandstone ${sandstoneTarget}, ${type} template ${templatePretty}`)

	// Confirm unless an explicit minor arg was passed
	if (!requestedMinor) {
		const { confirm } = await import('@inquirer/prompts')
		const proceed = await confirm({ message: 'Proceed?', default: true })
		if (!proceed) {
			console.log('Cancelled.')
			process.exit(0)
		}
	}

	// Checkout sandstone
	process.stdout.write(`Checking out sandstone → ${sandstoneTarget}... `)
	const sand = await checkoutBranch(sandstoneDir, sandstoneTarget)
	if (!sand.ok) {
		console.log('failed')
		console.error(sand.error)
		process.exit(1)
	}
	console.log('done')

	// Checkout template
	process.stdout.write(`Checking out template → ${resolvedTemplateTarget}... `)
	const tpl = await checkoutBranch(templateDir, resolvedTemplateTarget)
	if (!tpl.ok) {
		console.log('failed')
		console.error(tpl.error)
		process.exit(1)
	}
	console.log('done')

	// bun install if needed
	const hasBunLock = await fileExists(join(templateDir, 'bun.lock'))
	const hasNodeModules = await fileExists(join(templateDir, 'node_modules'))
	if (hasBunLock && !hasNodeModules) {
		process.stdout.write('Installing template dependencies... ')
		await $`bun install`.cwd(templateDir).quiet()
		await $`bun pm trust --all`.quiet().nothrow()
		console.log('done')
	}

	console.log('')
	console.log('Ready. CLI / generator / libraries stay on master (independent).')
}

main().catch((err: Error) => {
	console.error('Error:', err.message ?? err)
	process.exit(1)
})
