// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { TAP_TARGETS_ALLOWED, PASS_THROUGH } from '../../scripts/check-invariants.mjs'

// #207: the script runs its checks only when started as a script. Through a symlinked path that
// decision went the wrong way, so it checked nothing and exited 0, which reads as a pass. Whatever
// path starts it, it must say "invariants ok" or fail: never exit 0 in silence.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO, 'scripts', 'check-invariants.mjs')
const NAMED = [...TAP_TARGETS_ALLOWED, ...PASS_THROUGH].map((e) => e.file)

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
// realpathSync, so the links made below are the only symlinks in the path: macOS's tmpdir() is under
// /var, itself a link to /private/var.
function scratch(prefix: string) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

// A tree the script passes, plus the files its allowlist and PASS_THROUGH name, which it requires.
function tree(page: string) {
  const dir = scratch('invariants-entry-')
  for (const d of ['app/(app)/x', 'lib', 'components']) mkdirSync(join(dir, d), { recursive: true })
  for (const file of NAMED) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    copyFileSync(join(REPO, file), join(dir, file))
  }
  writeFileSync(join(dir, 'app/(app)/x/page.tsx'), page)
  return dir
}
const CLEAN = 'export default function Page() {\n  return null\n}\n'
// An unbounded transactions read, which tripwire #69 fails.
const BROKEN = `export default async function Page() {
  const { data, error } = await supabase.from('transactions').select('id, amount, date').eq('removed', false)
  if (error) throw error
}
`

// The two ways a symlink gets into the path: a link to the script, or a linked folder above it.
function viaLinkedFile() {
  const link = join(scratch('invariants-link-'), 'check-invariants.mjs')
  symlinkSync(SCRIPT, link)
  return link
}
function viaLinkedFolder() {
  const folder = join(scratch('invariants-link-'), 'scripts')
  symlinkSync(join(REPO, 'scripts'), folder, 'dir')
  return join(folder, 'check-invariants.mjs')
}

function run(scriptPath: string, cwd: string) {
  const r = spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' })
  return { status: r.status, out: (r.stdout + r.stderr).trim() }
}

describe('check-invariants started through a symlinked path (#207)', () => {
  it.each([
    ['a link to the script', viaLinkedFile],
    ['a linked folder above it', viaLinkedFolder],
  ])('checks a clean tree when started through %s', (_, path) => {
    const r = run(path(), tree(CLEAN))
    expect(r).toEqual({ status: 0, out: 'invariants ok' })
  })

  it.each([
    ['a link to the script', viaLinkedFile],
    ['a linked folder above it', viaLinkedFolder],
  ])('fails a broken tree when started through %s', (_, path) => {
    const r = run(path(), tree(BROKEN))
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('unbounded-txn-read')
  })

  // The tests import its exports. That must not run the checks against whatever tree the importer is in.
  it('runs nothing when imported', () => {
    const cwd = tree(BROKEN)
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)}); console.log('imported')`],
      { cwd, encoding: 'utf8' }
    )
    expect({ status: r.status, out: (r.stdout + r.stderr).trim() }).toEqual({ status: 0, out: 'imported' })
  })
})
