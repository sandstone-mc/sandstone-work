#!/usr/bin/env bun
/**
 * Recovery script for failed "Publish to npm" workflow runs.
 *
 * The failure mode this handles: npm publish succeeds (package is on npm),
 * but a later step fails — leaving the release unpublished, no GH release,
 * and no Discord notification. Recent cause (Aug 2026): "Prepare release
 * metadata" calls `gh api` without `env: GH_TOKEN`, so it dies on the
 * login-resolution loop and skips the rest of the job.
 *
 * What it does — re-runs every step from "Prepare release metadata"
 * onwards, locally:
 *
 *   1. Generate release_title.txt + release_body.md (mirrors the workflow
 *      step exactly, so the output is identical to what would have shipped).
 *   2. `gh release create` with the same `--latest` / `--latest=false`
 *      logic the workflow uses.
 *   3. Fetch the resulting release via `gh release view` and write the
 *      same name / body / url outputs the workflow would feed into the
 *      Discord action.
 *   4. Echo the exact `gh workflow run` invocation (or the action inputs
 *      verbatim) so the Discord notification can be triggered out-of-band
 *      — SethCohen/github-releases-to-discord@v1 isn't reproducible from
 *      a local CLI without re-implementing its formatting.
 *
 * Usage:
 *   # From anywhere, defaults to ./sandstone relative to this script's repo root.
 *   bun scripts/fix-release.ts v1.1.14
 *
 *   # Dry run (generate metadata + show what would be created, skip gh release).
 *   bun scripts/fix-release.ts v1.1.14 --dry-run
 *
 *   # Use a different repo dir / repo slug.
 *   bun scripts/fix-release.ts v1.1.14 --dir /path/to/sandstone --repo sandstone-mc/sandstone
 *
 *   # Skip the release fetch step (e.g. you only need the body files).
 *   bun scripts/fix-release.ts v1.1.14 --metadata-only
 */

import { $ } from 'bun'
import { existsSync } from 'fs'
import { resolve } from 'path'

const DEFAULT_REPO_DIR = 'sandstone'
const DEFAULT_REPO_SLUG = 'sandstone-mc/sandstone'
const REPO_ROOT = resolve(import.meta.dir, '..')

interface CliArgs {
    tag: string
    repoDir: string
    repoSlug: string
    dryRun: boolean
    metadataOnly: boolean
}

function parseArgs(argv: string[]): CliArgs {
    let tag = ''
    let repoDir = DEFAULT_REPO_DIR
    let repoSlug = DEFAULT_REPO_SLUG
    let dryRun = false
    let metadataOnly = false

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case '--dir':
                repoDir = argv[++i] ?? repoDir
                break
            case '--repo':
                repoSlug = argv[++i] ?? repoSlug
                break
            case '--dry-run':
                dryRun = true
                break
            case '--metadata-only':
                metadataOnly = true
                break
            case '-h':
            case '--help':
                printUsage()
                process.exit(0)
            default:
                if (arg.startsWith('--')) {
                    console.error(`Unknown flag: ${arg}`)
                    printUsage()
                    process.exit(1)
                }
                if (tag) {
                    console.error(`Unexpected positional arg: ${arg}`)
                    printUsage()
                    process.exit(1)
                }
                tag = arg
        }
    }

    if (!tag) {
        printUsage()
        process.exit(1)
    }
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
        console.error(`Tag must look like v1.2.3, got: ${tag}`)
        process.exit(1)
    }

    return { tag, repoDir, repoSlug, dryRun, metadataOnly }
}

function printUsage() {
    console.log(
        [
            'Usage: bun scripts/fix-release.ts <tag> [--dir <repo>] [--repo <slug>] [--dry-run] [--metadata-only]',
            '',
            'Examples:',
            '  bun scripts/fix-release.ts v1.1.14',
            '  bun scripts/fix-release.ts v1.1.14 --dry-run',
            '  bun scripts/fix-release.ts v1.1.14 --dir /var/home/mulverine/Workspaces/sandstone-work/sandstone',
            '',
            'Recovers a failed Publish-to-npm workflow run by re-running the release-creation',
            'steps locally (npm publish already succeeded; this picks up from the metadata step).',
        ].join('\n'),
    )
}

/**
 * Run a command in the target repo dir. Throws with stderr on non-zero exit.
 * Uses `nothrow()` so we can decide whether to surface non-zero exits vs. treat
 * them as missing-value sentinels (matches the workflow's `|| true` pattern).
 */
async function runInRepo(dir: string, cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const proc = await $`${cmd}`.cwd(dir).nothrow().quiet()
    return {
        ok: proc.exitCode === 0,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
    }
}

/**
 * Resolve the commit message body for the tag. The workflow uses
 * `git log -1 --format=%B` — `--format=%B` returns the full body, not just
 * the subject. Need to match that exactly so the recovered title/body
 * matches what the workflow would have produced.
 */
async function getCommitMessage(repoDir: string, tag: string): Promise<string> {
    const res = await runInRepo(repoDir, ['git', 'log', '-1', `--format=%B`, tag])
    if (!res.ok) {
        throw new Error(`Failed to read commit message for ${tag}:\n${res.stderr}`)
    }
    return res.stdout
}

/**
 * Find which (if any) release branch the tag lives on.
 * Mirrors the workflow:
 *   RELEASE_BRANCH=$(git branch -r --contains "$GITHUB_REF_NAME" \
 *     | grep -E 'origin/v[0-9]+\.[0-9]+\.x$' | head -n1 | sed 's|origin/||' || true)
 */
async function getReleaseBranch(repoDir: string, tag: string): Promise<string | null> {
    const res = await runInRepo(repoDir, [
        'git',
        'branch',
        '-r',
        '--contains',
        tag,
    ])
    if (!res.ok) return null
    const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
        const match = line.match(/^origin\/(v\d+\.\d+\.x)$/)
        if (match) return match[1]
    }
    return null
}

/**
 * Pick the most recent stable tag reachable from the release tag's commit.
 * The workflow relies on `--merged` defaulting to HEAD — but in GHA's
 * `actions/checkout@v6` triggered by a tag push, HEAD IS the tag, so the
 * default is effectively `--merged <tag>`. We pass the tag explicitly to
 * avoid relying on CWD's HEAD (which would be master on a dev machine and
 * produce the wrong previous tag for an archived-branch release).
 */
async function getPreviousTag(repoDir: string, tag: string): Promise<string | null> {
    const res = await runInRepo(repoDir, [
        'git',
        'tag',
        '--sort=-v:refname',
        '--merged',
        tag,
    ])
    if (!res.ok) {
        throw new Error(`Failed to list tags:\n${res.stderr}`)
    }
    const candidates = res.stdout
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t && t !== tag && /^v\d+\.\d+\.\d+$/.test(t))
    return candidates[0] ?? null
}

/**
 * Resolve a GitHub login for a commit, the same way the workflow does.
 * First tries the commit's author.login field; falls back to searching by
 * email; falls back to the local git author name (which won't link, but
 * keeps the line readable).
 */
async function resolveCommitAuthor(
    repoSlug: string,
    commit: string,
    workdir: string,
): Promise<string> {
    // 1. Try author.login directly from the commits API.
    const apiRes = await runInRepo(workdir, [
        'gh',
        'api',
        `repos/${repoSlug}/commits/${commit}`,
        '--jq',
        '.author.login // empty',
    ])
    if (apiRes.ok && apiRes.stdout.trim()) {
        return `@${apiRes.stdout.trim()}`
    }

    // 2. Fall back to email lookup via search/users.
    const emailRes = await runInRepo(workdir, ['git', 'log', '-1', '--format=%ae', commit])
    const email = emailRes.stdout.trim()
    if (email) {
        const searchRes = await runInRepo(workdir, [
            'gh',
            'api',
            `search/users?q=${email}+in:email`,
            '--jq',
            '.items[0].login // empty',
        ])
        if (searchRes.ok && searchRes.stdout.trim()) {
            return `@${searchRes.stdout.trim()}`
        }
    }

    // 3. Last resort: local git author name.
    const nameRes = await runInRepo(workdir, ['git', 'log', '-1', '--format=%an', commit])
    const name = nameRes.stdout.trim()
    return name ? `@${name}` : '@unknown'
}

/**
 * Extract co-author names from commit message trailers, the same way the
 * workflow does (sed captures the name before <email>, then prefixes ", @").
 * Note: the workflow's output is appended to AUTHOR with a leading ", @"
 * prefix per trailer, so we mirror that here.
 */
async function getCoAuthors(repoDir: string, commit: string): Promise<string> {
    const res = await runInRepo(repoDir, [
        'git',
        'log',
        '-1',
        '--format=%(trailers:key=Co-authored-by,valueonly)',
        commit,
    ])
    if (!res.ok) return ''
    const trailers = res.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    // Match the workflow's sed pipeline: extract the name before the <email>,
    // then prefix ", @" so the output reads ", @Name1, @Name2".
    const names = trailers
        .map((line) => {
            const m = line.match(/^(.+?)\s*<.*>$/)
            return m ? m[1].trim() : null
        })
        .filter((name): name is string => name !== null)
    if (names.length === 0) return ''
    return ', @' + names.join(', @')
}

/**
 * Build the release body, mirroring the workflow's heredoc.
 *
 * Inputs:
 *   - COMMIT_BODY: the commit message body (everything after the subject +
 *     blank line). Empty for single-line commits.
 *   - PREV_TAG: the previous tag on this branch.
 *   - HEAD: the tag we're releasing.
 *
 * Output: the markdown body for `gh release create --notes-file`.
 */
async function buildReleaseBody(
    repoDir: string,
    repoSlug: string,
    tag: string,
    previousTag: string | null,
    commitBody: string,
): Promise<string> {
    const lines: string[] = []

    if (commitBody.trim()) {
        lines.push(commitBody.trimEnd())
        lines.push('')
    }

    if (previousTag) {
        lines.push('<details>')
        lines.push(`<summary>Commits since ${previousTag}</summary>`)
        lines.push('')

        const range = `${previousTag}..${tag}`
        const hashRes = await runInRepo(repoDir, ['git', 'log', '--format=%H', range])
        if (!hashRes.ok) {
            throw new Error(`Failed to list commits in ${range}:\n${hashRes.stderr}`)
        }
        const hashes = hashRes.stdout.split('\n').map((h) => h.trim()).filter(Boolean)

        for (const commit of hashes) {
            const subjectRes = await runInRepo(repoDir, ['git', 'log', '-1', '--format=%s', commit])
            const subject = subjectRes.stdout.trim()

            const author = await resolveCommitAuthor(repoSlug, commit, repoDir)
            const coAuthors = await getCoAuthors(repoDir, commit)
            lines.push(`- ${commit} ${subject} (${author}${coAuthors})`)
        }

        lines.push('')
        lines.push('</details>')
        lines.push('')
        lines.push(
            `**Full Changelog**: [${previousTag}...${tag}](https://github.com/${repoSlug}/compare/${previousTag}...${tag})`,
        )
    }

    return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

/**
 * Build the release title by stripping the leading emoji prefix from the
 * commit subject, then prefixing the tag. Matches:
 *   CLEAN_TITLE=$(echo "$COMMIT_TITLE" | sed -E 's/^[^ ]+ //')
 *   echo "${TAG} - ${CLEAN_TITLE}" > release_title.txt
 */
function buildReleaseTitle(tag: string, commitSubject: string): string {
    // `[^ ]+` strips the first whitespace-delimited token. Emoji like "🐛"
    // or ":bug:" are single tokens, so either style works. Falls through
    // untouched if there's no leading token.
    const cleaned = commitSubject.replace(/^[^ ]+\s+/, '')
    return `${tag} - ${cleaned}`
}

/**
 * Step 1: write release_title.txt + release_body.md to CWD. Returns the
 * absolute paths so the caller can echo them.
 */
async function generateMetadata(args: CliArgs): Promise<{ titlePath: string; bodyPath: string }> {
    const repoDir = resolve(REPO_ROOT, args.repoDir)
    if (!existsSync(repoDir)) {
        throw new Error(`Repo dir not found: ${repoDir}`)
    }

    console.log(`📂 Repo: ${repoDir}`)
    console.log(`🏷️  Tag: ${args.tag}`)

    // Reject if the tag doesn't exist locally — the workflow uses
    // fetch-depth: 0 so tags are always there; if it's missing here, the
    // user needs a `git fetch --tags` first.
    const tagExists = await runInRepo(repoDir, ['git', 'tag', '-l', args.tag])
    if (!tagExists.ok || !tagExists.stdout.trim()) {
        throw new Error(
            `Tag ${args.tag} not found in ${repoDir}. Run \`git fetch --tags\` and try again.`,
        )
    }

    const releaseBranch = await getReleaseBranch(repoDir, args.tag)
    console.log(
        releaseBranch
            ? `🌿 Tag is on archived branch: ${releaseBranch} (will use --latest=false)`
            : '🌿 Tag is on master (will use --latest)',
    )

    const previousTag = await getPreviousTag(repoDir, args.tag)
    console.log(`🔖 Previous tag: ${previousTag ?? '(none)'}`)

    const commitMessage = await getCommitMessage(repoDir, args.tag)
    const commitLines = commitMessage.split('\n')
    const commitTitle = commitLines[0] ?? ''
    const commitBody = commitLines.slice(2).join('\n')

    const title = buildReleaseTitle(args.tag, commitTitle)
    const body = await buildReleaseBody(repoDir, args.repoSlug, args.tag, previousTag, commitBody)

    const titlePath = resolve(process.cwd(), 'release_title.txt')
    const bodyPath = resolve(process.cwd(), 'release_body.md')
    await Bun.write(titlePath, title + '\n')
    await Bun.write(bodyPath, body)

    console.log('')
    console.log(`📝 Title: ${title}`)
    console.log(`📄 Body written to: ${bodyPath}`)
    console.log('')
    console.log('--- release_body.md ---')
    console.log(body || '(empty)')
    console.log('-----------------------')

    return { titlePath, bodyPath }
}

/**
 * Step 2: create the GitHub release. Mirrors the workflow's
 * `gh release create` call, including the `--latest` / `--latest=false`
 * branch logic.
 */
async function createRelease(args: CliArgs, titlePath: string, bodyPath: string): Promise<void> {
    const repoDir = resolve(REPO_ROOT, args.repoDir)
    const title = (await Bun.file(titlePath).text()).trim()
    if (!title) {
        throw new Error(`release_title.txt is empty; refusing to create release`)
    }

    const releaseBranch = await getReleaseBranch(repoDir, args.tag)
    const latestFlag = releaseBranch ? '--latest=false' : '--latest'

    console.log(`🚀 Creating GitHub release ${args.tag} (${latestFlag})...`)
    const createRes = await runInRepo(repoDir, [
        'gh',
        'release',
        'create',
        args.tag,
        '--repo',
        args.repoSlug,
        '--title',
        title,
        '--notes-file',
        bodyPath,
        latestFlag,
    ])
    if (!createRes.ok) {
        throw new Error(`gh release create failed:\n${createRes.stderr || createRes.stdout}`)
    }
    console.log(`✅ Created release ${args.tag}`)
    if (createRes.stdout.trim()) {
        console.log(createRes.stdout.trim())
    }
}

/**
 * Step 3: fetch the just-created release payload and write the same
 * outputs the workflow feeds into the Discord action. Useful for
 * verifying the release matches what would have shipped.
 */
async function fetchReleasePayload(args: CliArgs): Promise<{ name: string; body: string; url: string }> {
    const repoDir = resolve(REPO_ROOT, args.repoDir)
    console.log(`📥 Fetching release payload for ${args.tag}...`)

    const jsonRes = await runInRepo(repoDir, [
        'gh',
        'release',
        'view',
        args.tag,
        '--repo',
        args.repoSlug,
        '--json',
        'name,body,url',
    ])
    if (!jsonRes.ok) {
        throw new Error(`gh release view failed:\n${jsonRes.stderr}`)
    }

    const json = JSON.parse(jsonRes.stdout) as { name: string; body: string; url: string }
    const payloadPath = resolve(process.cwd(), 'release.json')
    await Bun.write(payloadPath, JSON.stringify(json, null, 2) + '\n')

    console.log(`✅ Release payload written to: ${payloadPath}`)
    console.log(`   name: ${json.name}`)
    console.log(`   url:  ${json.url}`)
    return json
}

/**
 * Step 4: print instructions for re-running the Discord notification.
 * The workflow uses SethCohen/github-releases-to-discord@v1 with these
 * exact inputs — re-running the workflow file (or the publish job) would
 * trigger it, but the publish step is also gated `if: success()` from
 * the previous step which now succeeded. The cleanest path is to
 * re-dispatch the workflow for just this tag.
 */
function printDiscordInstructions(args: CliArgs): void {
    const tagSlug = args.tag.replace(/\./g, '-')
    console.log('')
    console.log('📣 Discord notification was skipped in the original run.')
    console.log('   Two ways to re-trigger it:')
    console.log('')
    console.log('   a) Re-dispatch the workflow for this tag (will re-publish to npm):')
    console.log(`        gh workflow run release.yml --repo ${args.repoSlug} --ref ${args.tag}`)
    console.log('')
    console.log('   b) Manually post to Discord using the release body in release_body.md')
    console.log('      and the URL in release.json.')
}

async function main() {
    const args = parseArgs(process.argv.slice(2))

    try {
        const { titlePath, bodyPath } = await generateMetadata(args)

        if (args.dryRun || args.metadataOnly) {
            if (args.dryRun) {
                console.log('🛑 --dry-run set; skipping gh release create.')
            } else {
                console.log('🛑 --metadata-only set; skipping gh release create.')
            }
            return
        }

        await createRelease(args, titlePath, bodyPath)
        await fetchReleasePayload(args)
        printDiscordInstructions(args)
    } catch (err) {
        console.error('')
        console.error(`❌ ${(err as Error).message}`)
        process.exit(1)
    }
}

if (import.meta.main) {
    main()
}
