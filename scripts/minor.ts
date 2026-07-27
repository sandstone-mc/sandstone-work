/**
 * Switch sandstone + template to a different minor version (live master or
 * an archived v{X}.x branch).
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
 *   - Each remote v{X}.x branch gets one entry labelled "X.Y".
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

async function getRemoteArchivedMinors(cwd: string): Promise<string[]> {
	// Each v<X>.x branch on sandstone represents an archived minor.
	// Unique sorted ascending by minor numeric.
	const branches = await getRemoteBranches(cwd)
	const minors = new Set<number>()
	for (const b of branches) {
		const m = b.match(/^v(\d+)\.x$/)
		if (m) minors.add(parseInt(m[1]!, 10))
	}
	return [...minors].sort((a, b) => a - b).map((n) => `v${n}.x`)
}

async function getMasterMinorFromPackageJson(): Promise<number | null> {
	try {
		const result = await $`git -C ${sandstoneDir} show origin/master:sandstone/package.json`.quiet().nothrow()
		if (result.exitCode !== 0) return null
		const pkg = JSON.parse(result.stdout.toString()) as { version?: string }
		if (!pkg.version) return null
		const m = pkg.version.match(/^\d+\.(\d+)\./)
		if (!m) return null
		return parseInt(m[1]!, 10)
	} catch {
		return null
	}
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
	const checkout = await $`git -C ${cwd} checkout ${branch}`.quiet().nothrow()
	if (checkout.exitCode !== 0) return { ok: false, error: checkout.stderr.toString().trim() }
	return { ok: true }
}

function parseArgs(): { minor?: string; type: TemplateType; help: boolean } {
	const args = process.argv.slice(2)
	// Accept `1.0`, `1.0.0`, `v1.0`, or `1.0.x` as the positional minor arg.
	const minor = args.find((a) => /^(v?\d+)\.(\d+)(\.(x|\d+))?$/.test(a))
	const normalised = minor?.replace(/^v/, '').replace(/\.x$/, '')
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
	const archivedBranches = await getRemoteArchivedMinors(sandstoneDir)

	if (masterMinor == null && archivedBranches.length === 0) {
		console.error('Error: could not determine available minors.')
		process.exit(1)
	}

	// Build candidates
	const candidates: CandidateMinor[] = []

	// Master entry — current minor
	if (masterMinor != null) {
		const mc = sandstoneMinorToMCString(masterMinor)
		candidates.push({
			label: `Latest (master)`,
			value: 'master',
			description: `MC ${mc}`,
		})
	}

	// Archived minors — each remote v*.x branch once. Filter out the one that
	// matches master (the one in master has no v*.x branch yet, so this is just
	// defensive: if for some reason origin/master's package.json lags and a
	// v{masterMinor}.x branch already exists, skip it).
	for (const branch of archivedBranches) {
		const minorNum = parseInt(branch.match(/^v(\d+)\.x$/)![1]!, 10)
		if (masterMinor != null && minorNum === masterMinor) continue
		const exists = await templateBranchExists(type, `${minorNum}.0`)
		const mc = sandstoneMinorToMCString(minorNum)
		const candidate: CandidateMinor = {
			label: `${minorNum}`,
			value: `${minorNum}`,
			description: `MC ${mc}`,
		}
		if (!exists) {
			candidate.disabled = true
			candidate.disabledReason = `no ${type}-${minorNum}.0 template branch yet`
		}
		candidates.push(candidate)
	}

	if (candidates.length === 0) {
		console.error('Error: no selectable minor versions.')
		process.exit(1)
	}

	let chosen: CandidateMinor

	if (requestedMinor) {
		const normalised = requestedMinor.replace(/^v/, '').replace(/\.x$/, '')
		const found = candidates.find((c) => c.value === normalised || c.value === 'master')
		if (!found) {
			console.error(`Error: minor ${requestedMinor} not found in available candidates.`)
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
	const templateTarget = chosen.value === 'master'
		? (() => {
			// Pick the highest template branch matching master's minor
			// (e.g., if master minor is 1.1, template should be pack-1.1.0
			// OR pack-1.1.X if multiple patches exist — pick the highest).
			return `pack-1.${masterMinor}.0` // default; refined below
		})()
		: `${type}-${chosen.value}.0`

	// For master, prefer the highest existing pack/library branch matching the master minor.
	let resolvedTemplateTarget = templateTarget
	if (chosen.value === 'master' && masterMinor != null) {
		const allBranches = await getRemoteBranches(templateDir)
		const matching = allBranches
			.filter((b) => b.startsWith(`${type}-1.${masterMinor}.`) && /^\d+\.\d+\.\d+$/.test(b.split(`${type}-`)[1] ?? ''))
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
	console.log('Ready. CLI / generator / hot-hook / libraries stay on master (independent).')
}

main().catch((err: Error) => {
	console.error('Error:', err.message ?? err)
	process.exit(1)
})
