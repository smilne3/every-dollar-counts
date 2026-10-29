import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// money() is whole dollars and moneyExact keeps the cents (lib/format.ts). The household asked for
// the cents to go everywhere but the transactions themselves, and the owner kept them on what is
// owed back on those (2026-10-23, #215). Whole dollars being the default, a new summary is whole
// dollars without anyone choosing it, but only while the exact formatter stays where it belongs.
//
// So these files may use moneyExact, and no others. A file belongs here only if what it shows is a
// transaction, or what is owed back on one. The list cannot outlive its files either: an entry whose
// file no longer uses moneyExact fails, so the list always says where the app shows cents.
const ALLOWED = new Map([
  ['components/TransactionRow.tsx', 'Transactions, a table row: its amount and your share.'],
  ['components/TransactionCard.tsx', 'Transactions, a phone card and its sheet: the amount and your share.'],
  ['components/RecentActivity.tsx', "The dashboard's Recent activity, which is transactions."],
  ['components/ReimbursableCheckbox.tsx', "A transaction's reimbursable part, beside its full amount."],
  ['components/ReimbursableEditor.tsx', "A transaction's reimbursable part, entered to the cent (step=\"0.01\")."],
  ['app/(app)/reimbursements/page.tsx', "What is owed back: the \"You're owed\" total and the rows it adds up."],
  ['components/ReimbursementCard.tsx', 'One row of what is owed back, or of what was reimbursed, on a phone.'],
  ['components/OwedToYouLink.tsx', "The dashboard's Owed to you, the same total as the reimbursements page's."],
])

// From this file, not the working directory, so it reads this checkout wherever it runs from (#201).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Every .ts and .tsx file the app is built from, by its path from the root.
const files = ['app', 'components', 'lib'].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(dir, file).replaceAll('\\', '/'))
)

// Whether a file's code names moneyExact: in an import, under an alias, as a namespace's member
// (format.moneyExact) or a string key (format['moneyExact']), in a re-export. Parsed, so a comment
// that mentions it is not a use.
function usesMoneyExact(path: string, text: string): boolean {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const named = (node: ts.Node): boolean =>
    ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'moneyExact') ||
    (ts.forEachChild(node, named) ?? false)
  return named(sf)
}

// lib/format.ts defines it.
const users = files.filter((path) => path !== 'lib/format.ts' && usesMoneyExact(path, readFileSync(join(root, path), 'utf8')))

describe('moneyExact, the formatter that keeps the cents (#215)', () => {
  // Files this test knows are there, so finding no stray use means something.
  it('reads the files it checks', () => {
    expect(files).toContain('app/(app)/dashboard/page.tsx')
    expect(files).toContain('components/ui/StatCard.tsx')
    expect(files).toContain('components/TransactionRow.tsx')
  })

  it('sees it however a file reaches it, and not in a comment', () => {
    const uses = (text: string) => usesMoneyExact('components/X.tsx', text)
    expect(uses(`import { moneyExact } from '@/lib/format'`)).toBe(true)
    expect(uses(`import { moneyExact as cents } from '@/lib/format'`)).toBe(true)
    expect(uses(`import * as format from '@/lib/format'\nconst a = format.moneyExact(1)`)).toBe(true)
    expect(uses(`import * as format from '@/lib/format'\nconst a = format['moneyExact'](1)`)).toBe(true)
    expect(uses(`export { moneyExact } from '../lib/format'`)).toBe(true)
    expect(uses(`const { moneyExact } = await import('@/lib/format')`)).toBe(true)
    expect(uses(`import { money } from '@/lib/format'\n// not moneyExact: a summary\nconst a = money(1)`)).toBe(false)
  })

  it('is used by no file it is not allowed in', () => {
    expect(users.filter((path) => !ALLOWED.has(path))).toEqual([])
  })

  // An entry for a file that has stopped using it, or is gone, would let the next use there in
  // without anyone deciding it.
  it('is used by every file it is allowed in', () => {
    expect([...ALLOWED.keys()].filter((path) => !users.includes(path))).toEqual([])
  })
})
