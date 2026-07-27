#!/usr/bin/env bun
/**
 * Release script for sandstone-mc packages
 *
 * Interactive mode (no arguments):
 *   bun scripts/release.ts
 *
 * CLI mode:
 *   bun scripts/release.ts <package> <title> [body]
 *
 * Examples:
 *   bun scripts/release.ts sandstone "Fix entity selectors"
 *   bun scripts/release.ts cli "Add new command" "This adds the foo command for bar"
 */

import { $ } from 'bun'
import { existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { select, input, editor, confirm } from '@inquirer/prompts'
import { sandstoneMinorToMC } from './sandstoneToMC.ts'

interface PackageConfig {
    dir: string
    versionPath?: string
}

interface PackageInfo {
    name: string
    config: PackageConfig
    dir: string
    version: string
    latestTag: string | null
    commitsSinceTag: number
    hasUncommittedChanges: boolean
}

const PACKAGES: Record<string, PackageConfig> = {
    sandstone: { dir: 'sandstone' },
    cli: { dir: 'sandstone-cli' },
    mcdoc: { dir: 'mcdoc-ts-generator' },
    'hot-hook': { dir: 'hot-hook', versionPath: 'packages/hot_hook/package.json' },
    playground: { dir: 'sandstone-playground' },
}

/**
 * Get GitHub repo URL from git remote (SSH format: git@github.com:org/repo.git)
 */
async function getGitHubRepoUrl(dir: string): Promise<string | null> {
    const remote = await $`git -C ${dir} remote get-url origin 2>/dev/null || echo ""`.text()
    const match = remote.trim().match(/git@github\.com:(.+?)(?:\.git)?$/)
    return match ? `https://github.com/${match[1]}` : null
}

/**
 * Update CHANGELOG.md with new release entry (if it exists)
 */
async function updateChangelog(
    dir: string,
    version: string,
    title: string,
    body?: string,
    previousTag?: string | null
): Promise<boolean> {
    const changelogPath = resolve(dir, 'CHANGELOG.md')
    if (!existsSync(changelogPath)) {
        return false
    }

    const repoUrl = await getGitHubRepoUrl(dir)
    if (!repoUrl) {
        console.log('⚠️  Could not determine GitHub repo URL, skipping changelog update')
        return false
    }

    const tag = `v${version}`
    const date = new Date().toISOString().split('T')[0]

    // Build the new entry
    let entry = `## [${tag}](${repoUrl}/releases/tag/${tag}) - ${date}\n\n`
    entry += `### ${title}\n\n`
    if (body) {
        entry += `${body}\n\n`
    }
    if (previousTag) {
        entry += `**Full Changelog**: [${previousTag}...${tag}](${repoUrl}/compare/${previousTag}...${tag})\n`
    }
    entry += '\n\n'

    // Read existing changelog
    const changelog = await Bun.file(changelogPath).text()

    // Find where to insert (after the header line "# Changelog" and any following blank lines/description)
    const headerMatch = changelog.match(/^# Changelog\n+(?:.*\n+)?(?=## |\z)/m)
    if (headerMatch) {
        const insertPos = headerMatch.index! + headerMatch[0].length
        const newChangelog = changelog.slice(0, insertPos) + entry + changelog.slice(insertPos)
        await Bun.write(changelogPath, newChangelog)
    } else {
        // No header found, prepend to file
        await Bun.write(changelogPath, `# Changelog\n\n${entry}${changelog}`)
    }

    return true
}

/**
 * Increment version string
 * - `1.0.0` → `1.0.1`
 *
 * Prereleases are no longer used (no alpha/beta/rc — major 1 has shipped).
 * If a tag ever lands as a prerelease form it would not be touched here.
 */
function incrementVersion(version: string): string {
    const parts = version.split('.')
    const last = parseInt(parts[parts.length - 1])
    parts[parts.length - 1] = String(last + 1)
    return parts.join('.')
}

type ReleaseKind = 'patch' | 'minor'

/**
 * Decide whether this is a patch or a minor release for the given package.
 *
 * Only prompts when the user is on master and has NOT touched package.json
 * (still matches the latest released tag). Otherwise the choice is implicit:
 * - On an archived v*.x branch: always patch.
 * - User edited package.json to X.Y.Z (Z > 0): patch.
 * - User edited package.json to X.Y.0 with a different minor: minor.
 * Returns `null` if user picked Cancel.
 */
async function askReleaseKind(info: PackageInfo): Promise<ReleaseKind | null> {
    // Only meaningful for sandstone — other packages don't have archival branches.
    if (info.name !== 'sandstone') return 'patch'

    const branchResult = await $`git -C ${info.dir} rev-parse --abbrev-ref HEAD`.quiet().nothrow()
    const currentBranch = branchResult.stdout.toString().trim()
    const archivedBranch = /^v\d+\.\d+\.x$/.test(currentBranch)

    if (archivedBranch) {
        // V*.x branches only support patches within that minor.
        return 'patch'
    }

    // Check if user changed package.json: pkgVer vs latestVer
    const latestVerMatch = info.latestTag?.match(/^v(\d+)\.(\d+)\.(\d+)$/)
    const pkgMatch = info.version.match(/^(\d+)\.(\d+)\.(\d+)$/)
    if (!latestVerMatch || !pkgMatch) return 'patch'

    const [, latestMaj, latestMin] = latestVerMatch
    const [, pkgMaj, pkgMin, pkgPatch] = pkgMatch
    const userChangedVersion = info.version !== info.latestTag?.replace(/^v/, '')

    if (userChangedVersion) {
        // User has expressed intent in package.json — respect it.
        if (pkgPatch === '0' && pkgMaj === latestMaj && pkgMin !== latestMin) {
            return 'minor'
        }
        return 'patch'
    }

    // User hasn't touched package.json and is on master — prompt.
    const choices: Array<{ name: string; value: ReleaseKind | 'cancel' }> = [
        {
            name: `Patch release in current minor (${info.version} → ${pkgMaj}.${pkgMin}.${parseInt(pkgPatch ?? '0') + 1})`,
            value: 'patch',
        },
        {
            name: `New minor release (${info.version} → ${pkgMaj}.${parseInt(pkgMin ?? '0') + 1}.0; creates v${latestMaj}.${latestMin}.x archival branch + pack/library ${pkgMaj}.${parseInt(pkgMin ?? '0') + 1}.0 template branches)`,
            value: 'minor',
        },
        { name: 'Cancel', value: 'cancel' },
    ]
    const choice = await select({
        message: 'What kind of release is this?',
        choices,
        default: 'patch',
    })
    return choice === 'cancel' ? null : choice
}

/**
 * After a successful sandstone minor release, create the previous-minor
 * archival branch on sandstone (e.g. v1.1.x) and matching pack/library
 * template branches (pack-1.2.0, library-1.2.0).
 *
 * Silent on errors and on existing branches — never fails the release.
 */
async function createMinorBranches(packageDir: string, prevMinor: string, newMinor: string): Promise<void> {
    const templateDir = resolve(import.meta.dir, '..', 'sandstone-template')

    // 1. Sandstone: create v{prevMinor}.x from the previous tag's commit.
    try {
        const prevTagResult = await $`git -C ${packageDir} tag --sort=-v:refname | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | head -n2 | tail -n1`.quiet().nothrow()
        const prevTag = prevTagResult.stdout.toString().trim()
        if (!prevTag) {
            console.log(`⚠️  Could not determine previous tag; skipping v${prevMinor}.x`)
        } else {
            const existsCheck = await $`git -C ${packageDir} ls-remote --heads origin v${prevMinor}.x`.quiet().nothrow()
            if (existsCheck.stdout.toString().trim().length > 0) {
                console.log(`ℹ️  v${prevMinor}.x already exists on remote; skipping creation`)
            } else {
                console.log(`🌿 Creating v${prevMinor}.x from ${prevTag}...`)
                const branchCreate = await $`git -C ${packageDir} branch v${prevMinor}.x ${prevTag}`.quiet().nothrow()
                if (branchCreate.exitCode === 0) {
                    await $`git -C ${packageDir} push -u origin v${prevMinor}.x`.quiet().nothrow()
                    console.log(`✅ Pushed v${prevMinor}.x`)
                } else {
                    console.log(`⚠️  Failed to create v${prevMinor}.x branch: ${branchCreate.stderr.toString().trim()}`)
                }
            }
        }
    } catch (e) {
        console.log(`⚠️  v${prevMinor}.x creation failed: ${(e as Error).message ?? e}`)
    }

    // 2. Template: create pack-{newMinor}.0 and library-{newMinor}.0.
    if (!existsSync(templateDir)) {
        console.log('ℹ️  Template repo not found; skipping template branch creation')
        return
    }
    for (const type of ['pack', 'library'] as const) {
        const target = `${type}-${newMinor}.0`
        const source = `${type}-${prevMinor}.0`
        try {
            const sourceExists = await $`git -C ${templateDir} ls-remote --heads origin ${source}`.quiet().nothrow()
            if (sourceExists.stdout.toString().trim().length === 0) {
                console.log(`⚠️  ${source} does not exist on template remote; skipping ${target}`)
                continue
            }
            const targetExists = await $`git -C ${templateDir} ls-remote --heads origin ${target}`.quiet().nothrow()
            if (targetExists.stdout.toString().trim().length > 0) {
                console.log(`ℹ️  ${target} already exists on remote; skipping`)
                continue
            }
            console.log(`🌿 Creating template ${target} from ${source}...`)
            const fetch = await $`git -C ${templateDir} fetch origin ${source}`.quiet().nothrow()
            if (fetch.exitCode !== 0) {
                console.log(`⚠️  Failed to fetch ${source}: ${fetch.stderr.toString().trim()}`)
                continue
            }
            const branchCreate = await $`git -C ${templateDir} branch ${target} origin/${source}`.quiet().nothrow()
            if (branchCreate.exitCode === 0) {
                await $`git -C ${templateDir} push -u origin ${target}`.quiet().nothrow()
                console.log(`✅ Pushed ${target}`)
            } else {
                console.log(`⚠️  Failed to create ${target} branch: ${branchCreate.stderr.toString().trim()}`)
            }
        } catch (e) {
            console.log(`⚠️  ${target} creation failed: ${(e as Error).message ?? e}`)
        }
    }

    // 3. Template repo's main-branch README gets a new section pointing at
    // the new pack-/library-X.Y.0 branches. Newest section goes on top.
    await updateTemplateReadme(newMinor, prevMinor)
}

/**
 * Append a new "### X.Y.0 Templates (MC X.Y)" section to the sandstone-template
 * repo's main-branch README, pointing at the new pack-/library-X.Y.0 branches.
 * Newest section at the top (after the intro paragraph).
 *
 * Best-effort: any failure logs a warning but does NOT fail the release.
 * Restores the template repo to the branch the user was on at the start.
 */
async function updateTemplateReadme(newMinor: string, prevMinor: string) {
    const templateDir = resolve(import.meta.dir, '..', 'sandstone-template')
    if (!existsSync(templateDir)) {
        console.log('ℹ️  Template repo not found locally; skipping README update')
        return
    }

    // Remember the branch the user was on; restore at the end.
    const originalRef = (await $`git -C ${templateDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim()
    const originalBranch = originalRef === 'HEAD' ? null : originalRef

    const minorNum = parseInt(newMinor.split('.')[1] ?? '0', 10)
    const { mcMajor, mcMinor } = sandstoneMinorToMC(minorNum)
    const mcVersion = `${mcMajor}.${mcMinor}`

    const checkout = await $`git -C ${templateDir} checkout main`.quiet().nothrow()
    if (checkout.exitCode !== 0) {
        console.log(`⚠️  Could not checkout main on template (exit ${checkout.exitCode}); skipping README update`)
        return
    }

    const readmePath = resolve(templateDir, 'README.md')
    let readme: string
    try {
        readme = await Bun.file(readmePath).text()
    } catch {
        console.log('⚠️  No README.md on template main; skipping')
        if (originalBranch) await $`git -C ${templateDir} checkout ${originalBranch}`.quiet().nothrow()
        return
    }

    const heading = `### ${newMinor}.0 Templates (MC ${mcVersion})`
    if (readme.includes(heading)) {
        console.log(`ℹ️  Template README already has section for ${newMinor}.0; skipping`)
        if (originalBranch) await $`git -C ${templateDir} checkout ${originalBranch}`.quiet().nothrow()
        return
    }

    const newSection =
        `${heading}\n` +
        `- [Pack](https://github.com/sandstone-mc/sandstone-template/tree/pack-${newMinor}.0) \`pack-${newMinor}.0\`\n` +
        `- [Library](https://github.com/sandstone-mc/sandstone-template/tree/library-${newMinor}.0) \`library-${newMinor}.0\`\n` +
        `\n`

    // Insert after the intro paragraph (heading line + 1-2 intro lines + blank line).
    const introMatch = readme.match(/^# [^\n]*\n+(?:[^\n]*\n)*?\n/)
    const updated =
        introMatch != null
            ? readme.slice(0, introMatch.index! + introMatch[0].length) +
              newSection +
              readme.slice(introMatch.index! + introMatch[0].length)
            : readme + newSection

    await Bun.write(readmePath, updated)

    await $`git -C ${templateDir} add -A`.quiet().nothrow()
    const commit = await $`git -C ${templateDir} commit -m ${`⬆️ Add ${newMinor}.0 templates to README`}`.quiet().nothrow()
    if (commit.exitCode !== 0) {
        console.log(`⚠️  Template README commit failed: ${commit.stderr.toString().trim()}`)
        if (originalBranch) await $`git -C ${templateDir} checkout ${originalBranch}`.quiet().nothrow()
        return
    }
    const push = await $`git -C ${templateDir} push`.quiet().nothrow()
    if (push.exitCode !== 0) {
        console.log(`⚠️  Template README push failed: ${push.stderr.toString().trim()}`)
        if (originalBranch) await $`git -C ${templateDir} checkout ${originalBranch}`.quiet().nothrow()
        return
    }
    console.log(`✅ Updated template README on main (added ${newMinor}.0 / MC ${mcVersion})`)

    // Restore the template repo to whatever branch the user was on before
    // we checked out main for the README edit.
    if (originalBranch && originalBranch !== 'main') {
        const restore = await $`git -C ${templateDir} checkout ${originalBranch}`.quiet().nothrow()
        if (restore.exitCode === 0) {
            console.log(`ℹ️  Restored template repo to ${originalBranch}`)
        } else {
            console.log(`⚠️  Could not restore template to ${originalBranch}: ${restore.stderr.toString().trim()}`)
        }
    }
}

async function getPackageInfo(name: string, config: PackageConfig): Promise<PackageInfo | null> {
    const dir = resolve(import.meta.dir, '..', config.dir)
    if (!existsSync(dir)) {
        return null
    }

    const packageJsonPath = resolve(dir, config.versionPath ?? 'package.json')
    const packageJson = await Bun.file(packageJsonPath).json()
    const version = packageJson.version

    // Get latest tag
    const latestTagResult = await $`git -C ${dir} describe --tags --abbrev=0 2>/dev/null || echo ""`.text()
    const latestTag = latestTagResult.trim() || null

    // Count commits since tag
    let commitsSinceTag = 0
    if (latestTag) {
        const countResult = await $`git -C ${dir} rev-list ${latestTag}..HEAD --count`.text()
        commitsSinceTag = parseInt(countResult.trim()) || 0
    } else {
        const countResult = await $`git -C ${dir} rev-list HEAD --count`.text()
        commitsSinceTag = parseInt(countResult.trim()) || 0
    }

    // Check for uncommitted changes
    const status = await $`git -C ${dir} status --porcelain`.text()
    const hasUncommittedChanges = status.trim().length > 0

    return {
        name,
        config,
        dir,
        version,
        latestTag,
        commitsSinceTag,
        hasUncommittedChanges,
    }
}

async function interactiveMode() {
    console.log('🔍 Scanning packages for changes...\n')

    // Gather info for all packages
    const packageInfos: PackageInfo[] = []
    for (const [name, config] of Object.entries(PACKAGES)) {
        const info = await getPackageInfo(name, config)
        if (info) {
            packageInfos.push(info)
        }
    }

    // Filter to packages with pending changes
    const packagesWithChanges = packageInfos.filter(
        (p) => p.commitsSinceTag > 0 || p.hasUncommittedChanges
    )

    if (packagesWithChanges.length === 0) {
        console.log('✨ All packages are up to date with their latest tags.')
        return
    }

    // Build choices for select
    const choices = packagesWithChanges.map((p) => {
        let description = ''
        if (p.commitsSinceTag > 0) {
            description += `${p.commitsSinceTag} commit${p.commitsSinceTag > 1 ? 's' : ''} since ${p.latestTag ?? 'start'}`
        }
        if (p.hasUncommittedChanges) {
            description += description ? ' + uncommitted changes' : 'uncommitted changes'
        }
        return {
            name: `${p.name} (v${p.version}) - ${description}`,
            value: p,
        }
    })

    // Select package
    const selectedPackage = await select({
        message: 'Select a package to release:',
        choices,
    })

    // Show recent commits for context
    if (selectedPackage.latestTag && selectedPackage.commitsSinceTag > 0) {
        console.log(`\n📜 Recent commits since ${selectedPackage.latestTag}:`)
        const commits = await $`git -C ${selectedPackage.dir} log ${selectedPackage.latestTag}..HEAD --oneline --no-decorate`.text()
        console.log(commits.trim().split('\n').map(c => `   ${c}`).join('\n'))
        console.log('')
    }

    // Get title
    const title = await input({
        message: 'Release title:',
        validate: (value) => value.trim().length > 0 || 'Title is required',
    })

    // Ask if user wants to add a body
    const wantsBody = await confirm({
        message: 'Add a release body/description?',
        default: false,
    })

    let body: string | undefined
    if (wantsBody) {
        const isVsCode = !!process.env.VSCODE_INJECTION || !!process.env.TERM_PROGRAM?.includes('vsc')
        
        if (isVsCode) {
            const tempFile = `/tmp/sandstone-release-body-${Date.now()}.md`
            await Bun.write(tempFile, '')
            
            console.log('\n📝 Opening in VS Code (use Alt+Shift+V for markdown preview)...')
            console.log('   Edit the file, save (Ctrl+S), then close the tab to continue.')
            await $`code --reuse-window --wait ${tempFile}`
            
            body = await Bun.file(tempFile).text()
            body = body?.trim() || undefined
            
            unlinkSync(tempFile)
        } else {
            body = await editor({
                message: 'Release body (save and close editor when done):',
            })
            body = body?.trim() || undefined
        }
    }

    // Confirm
    console.log('')
    console.log(`📦 Package: ${selectedPackage.name}`)
    console.log(`📝 Title: ${title}`)
    if (body) {
        console.log(`📄 Body: ${body.split('\n')[0]}${body.includes('\n') ? '...' : ''}`)
    }

    const kind = await askReleaseKind(selectedPackage)
    if (kind === null) {
        console.log('❌ Release cancelled.')
        return
    }

    const confirmed = await confirm({
        message: 'Proceed with release?',
        default: true,
    })

    if (!confirmed) {
        console.log('❌ Release cancelled.')
        return
    }

    console.log('')
    await release(selectedPackage.name, selectedPackage.config, title, body, kind)
}

async function release(packageName: string, pkg: PackageConfig, title: string, body?: string, kind: ReleaseKind = 'patch') {
    const packageDir = resolve(import.meta.dir, '..', pkg.dir)
    if (!existsSync(packageDir)) {
        console.error(`Package directory not found: ${packageDir}`)
        process.exit(1)
    }

    // Read version from package.json
    const packageJsonPath = resolve(packageDir, pkg.versionPath ?? 'package.json')
    const packageJson = await Bun.file(packageJsonPath).json()
    let version: string = packageJson.version

    // For 'patch' kinds, auto-increment if a tag with the same version already
    // exists. For 'minor', respect the user-set version as-is — they have
    // already edited package.json to the new minor release.
    let tag = `v${version}`
    if (kind === 'patch') {
        let existingTag = await $`git -C ${packageDir} tag -l ${tag}`.text()
        while (existingTag.trim()) {
            console.log(`⚠️  Tag ${tag} already exists, incrementing version...`)
            version = incrementVersion(version)
            tag = `v${version}`
            existingTag = await $`git -C ${packageDir} tag -l ${tag}`.text()
        }
    } else {
        // minor kind: tag must not already exist; abort if it does
        const existingTag = (await $`git -C ${packageDir} tag -l ${tag}`.text()).trim()
        if (existingTag) {
            console.error(`❌ Tag ${tag} already exists. Cannot release as a new minor without bumping version.`)
            console.error(`   Edit package.json to a new X.Y.0 version and try again.`)
            process.exit(1)
        }
    }

    // Update package.json if version changed (only happens for patch mode)
    if (version !== packageJson.version) {
        packageJson.version = version
        await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')
        console.log(`📝 Updated package.json to version ${version}`)
    }

    // Get latest tag for changelog compare link
    const latestTagResult = await $`git -C ${packageDir} describe --tags --abbrev=0 2>/dev/null || echo ""`.text()
    const previousTag = latestTagResult.trim() || null

    // Update changelog if it exists
    const changelogUpdated = await updateChangelog(packageDir, version, title, body, previousTag)
    if (changelogUpdated) {
        console.log('📋 Updated CHANGELOG.md')
    }

    console.log(`📦 Package: ${packageName} (${pkg.dir})`)
    console.log(`📌 Version: ${version}`)
    console.log(`🏷️  Tag: ${tag}`)
    console.log('')

    // Build commit message with release emoji prefix
    let commitMessage = `🔖 ${title}`
    if (body) {
        commitMessage += `\n\n${body}`
    }

    // Stage all changes
    console.log('📥 Staging changes...')
    await $`git -C ${packageDir} add -A`

    // Create commit
    console.log('💾 Creating commit...')
    await $`git -C ${packageDir} commit -m ${commitMessage}`

    // Create tag
    console.log(`🏷️  Creating tag ${tag}...`)
    await $`git -C ${packageDir} tag ${tag}`

    // Push commit and tag
    console.log('🚀 Pushing to remote...')
    await $`git -C ${packageDir} push`
    await $`git -C ${packageDir} push origin ${tag}`

    console.log('')
    console.log(`✅ Released ${packageName} ${tag}`)
    console.log(`   GitHub Actions will now build and publish to npm.`)

    // After a CLI release, remind the user to bump the CLI in all maintained
    // template branches — the template's CLI dep is pinned at create-time
    // and needs updating outside of this release script's scope.
    if (packageName === 'cli') {
        console.log('')
        console.log(`💡 Don't forget to bump the CLI in maintained template branches:`)
        console.log(`   bun template:cli-update`)
    }

    // For sandstone minor releases: create archival branch + template branches.
    if (packageName === 'sandstone' && kind === 'minor') {
        const versionMatch = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
        if (versionMatch) {
            const newMinor = `${versionMatch[1]}.${versionMatch[2]}`
            // previous minor in the form X.(Y-1) — fall back to direct lookup
            // of the highest tagged version BEFORE the just-released tag.
            const allTags = (await $`git -C ${packageDir} tag --sort=-v:refname | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$'`.text())
                .split('\n').map((t) => t.trim()).filter(Boolean)
            const prevTag = allTags.find((t) => t !== tag)
            if (prevTag) {
                const prevMatch = prevTag.match(/^v(\d+)\.(\d+)\./)
                if (prevMatch) {
                    const prevMinor = `${prevMatch[1]}.${prevMatch[2]}`
                    await createMinorBranches(packageDir, prevMinor, newMinor)
                }
            }
        }
    }
}

async function cliMode(args: string[]) {
    if (args.length < 2) {
        console.error('Usage: bun scripts/release.ts <package> <title> [body] [--minor]')
        console.error('')
        console.error('Packages:', Object.keys(PACKAGES).join(', '))
        console.error('')
        console.error('Flags:')
        console.error('  --minor   Release as a new minor (triggers archival branch creation)')
        console.error('')
        console.error('Or run without arguments for interactive mode.')
        process.exit(1)
    }

    const kind: ReleaseKind = args.includes('--minor') ? 'minor' : 'patch'
    const filtered = args.filter((a) => a !== '--minor')
    const [packageName, title, body] = filtered

    const pkg = PACKAGES[packageName]
    if (!pkg) {
        console.error(`Unknown package: ${packageName}`)
        console.error('Available packages:', Object.keys(PACKAGES).join(', '))
        process.exit(1)
    }

    await release(packageName, pkg, title, body, kind)
}

async function main() {
    const args = process.argv.slice(2)

    if (args.length === 0) {
        await interactiveMode()
    } else {
        await cliMode(args)
    }
}

main().catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
})
