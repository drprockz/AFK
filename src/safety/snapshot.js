// src/safety/snapshot.js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Creates a git checkpoint before a destructive deferred action.
 * Runs `git add -A` + `git commit`. Non-blocking on failure.
 * Uses execFile (not exec) to avoid shell injection on cwd or reason.
 * @param {string} cwd — project working directory
 * @param {string} reason — human-readable reason (embedded in commit message)
 * @returns {Promise<{ snapshotted: boolean, commit: string | null }>}
 */
export async function snapshot(cwd, reason) {
  // Step 1: verify cwd is a git repo
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd })
  } catch {
    return { snapshotted: false, commit: null }
  }

  // Step 2: stage all changes
  try {
    await execFileAsync('git', ['add', '-A'], { cwd })
  } catch (err) {
    process.stderr.write(`afk snapshot: git add failed: ${err.message}\n`)
    return { snapshotted: false, commit: null }
  }

  // Step 3: commit — leave staged state if this fails (per spec: no cleanup)
  try {
    const { stdout } = await execFileAsync('git', [
      'commit', '-m', `afk: checkpoint before ${reason} [skip ci]`
    ], { cwd })
    // Git stdout format: "[branch-name abc1234] message"
    const match = stdout.match(/\[[\w/.\-]+ ([0-9a-f]+)\]/)
    const commit = match?.[1] ?? null
    return { snapshotted: true, commit }
  } catch (err) {
    const output = String(err.stdout ?? '') + String(err.stderr ?? '')
    if (output.includes('nothing to commit')) {
      return { snapshotted: false, commit: null }
    }
    process.stderr.write(`afk snapshot: git commit failed: ${err.message}\n`)
    return { snapshotted: false, commit: null }
  }
}
