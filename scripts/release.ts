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
 * Increment version string
 * - `1.0.0` → `1.0.1`
 * - `1.0.0-beta.3` → `1.0.0-beta.4`
 * - `1.0.0-alpha.5` → `1.0.0-alpha.6`
 */
function incrementVersion(version: string): string {
    const prereleaseMatch = version.match(/^(.+)-([a-z]+)\.(\d+)$/i)
    if (prereleaseMatch) {
        const [, base, prerelease, num] = prereleaseMatch
        return `${base}-${prerelease}.${parseInt(num) + 1}`
    }

    const parts = version.split('.')
    const last = parseInt(parts[parts.length - 1])
    parts[parts.length - 1] = String(last + 1)
    return parts.join('.')
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

    const confirmed = await confirm({
        message: 'Proceed with release?',
        default: true,
    })

    if (!confirmed) {
        console.log('❌ Release cancelled.')
        return
    }

    console.log('')
    await release(selectedPackage.name, selectedPackage.config, title, body)
}

async function release(packageName: string, pkg: PackageConfig, title: string, body?: string) {
    const packageDir = resolve(import.meta.dir, '..', pkg.dir)
    if (!existsSync(packageDir)) {
        console.error(`Package directory not found: ${packageDir}`)
        process.exit(1)
    }

    // Read version from package.json
    const packageJsonPath = resolve(packageDir, pkg.versionPath ?? 'package.json')
    const packageJson = await Bun.file(packageJsonPath).json()
    let version: string = packageJson.version

    // Check if tag already exists, auto-increment if needed
    let tag = `v${version}`
    let existingTag = await $`git -C ${packageDir} tag -l ${tag}`.text()

    while (existingTag.trim()) {
        console.log(`⚠️  Tag ${tag} already exists, incrementing version...`)
        version = incrementVersion(version)
        tag = `v${version}`
        existingTag = await $`git -C ${packageDir} tag -l ${tag}`.text()
    }

    // Update package.json if version changed
    if (version !== packageJson.version) {
        packageJson.version = version
        await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')
        console.log(`📝 Updated package.json to version ${version}`)
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
}

async function cliMode(args: string[]) {
    if (args.length < 2) {
        console.error('Usage: bun scripts/release.ts <package> <title> [body]')
        console.error('')
        console.error('Packages:', Object.keys(PACKAGES).join(', '))
        console.error('')
        console.error('Or run without arguments for interactive mode.')
        process.exit(1)
    }

    const [packageName, title, body] = args

    const pkg = PACKAGES[packageName]
    if (!pkg) {
        console.error(`Unknown package: ${packageName}`)
        console.error('Available packages:', Object.keys(PACKAGES).join(', '))
        process.exit(1)
    }

    await release(packageName, pkg, title, body)
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
