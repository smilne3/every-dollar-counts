import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// money() is whole dollars and moneyExact keeps the cents (lib/format.ts). The household asked for
// the cents to go everywhere but the transactions themselves. The owner kept them on the
// reimbursements too, and on the owed-to-you total wherever it appears (2026-10-23 and 2026-10-30,
// #215). Whole dollars being the default, a new summary is whole dollars without anyone choosing it,
// but only while the exact formatter stays where it belongs.
//
// So these files may use moneyExact, and no others. A file belongs here only if what it shows is a
// transaction, a reimbursement, or the owed-to-you total. The list cannot outlive its files either:
// an entry whose file no longer uses moneyExact fails, so the list always says where the app shows
// cents.
const ALLOWED = new Map([
  ['components/TransactionRow.tsx', 'Transactions, a table row: its amount and your share.'],
  ['components/TransactionCard.tsx', 'Transactions, a phone card and its sheet: the amount and your share.'],
  ['components/RecentActivity.tsx', "The dashboard's Recent activity, which is transactions."],
  ['components/ReimbursableCheckbox.tsx', "A transaction's reimbursable part, beside its full amount."],
  ['components/ReimbursableEditor.tsx', "A transaction's reimbursable part, entered to the cent (step=\"0.01\")."],
  ['app/(app)/reimbursements/page.tsx', "What is owed back: the \"You're owed\" total, the rows it adds up, and the rows already reimbursed."],
  ['components/ReimbursementCard.tsx', 'One row of what is owed back, or of what was reimbursed, on a phone.'],
  ['components/OwedToYouLink.tsx', "The dashboard's Owed to you, the same total as the reimbursements page's."],
  ['components/BreakdownList.tsx', "Only a row its page marks `exact`: net worth's Owed to you, the same total again."],
])

// From this file, not the working directory, so it reads this checkout wherever it runs from (#201).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

// Every .ts and .tsx file the app is built from, by its path from the root.
const files = ['app', 'components', 'lib'].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(dir, file).replaceAll('\\', '/'))
)

// Every place a file's code names moneyExact: an import, an alias's original name, a namespace's
// member (format.moneyExact) or string key (format['moneyExact']), a re-export, a declaration. Parsed,
// so a comment that mentions it is not one.
function namesOfMoneyExact(path: string, text: string): ts.Node[] {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'moneyExact') found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}
const usesMoneyExact = (path: string, text: string) => namesOfMoneyExact(path, text).length > 0

// lib/format.ts defines it, and is held to that below.
const users = files.filter((path) => path !== 'lib/format.ts' && usesMoneyExact(path, read(path)))

describe('moneyExact, the formatter that keeps the cents (#215)', () => {
  // Files this test knows are there, so finding no stray use means something.
  it('reads the files it checks', () => {
    expect(files).toContain('app/(app)/dashboard/page.tsx')
    expect(files).toContain('components/ui/StatCard.tsx')
    expect(files).toContain('components/TransactionRow.tsx')
    expect(files).toContain('lib/format.ts')
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

  // The file that defines it names it only to declare it. An alias, a wrapper or a re-export there,
  // such as `export const moneyCents = moneyExact`, would hand the cents to any file under a name
  // this list never sees.
  it('is named in lib/format.ts only where it is declared', () => {
    const names = namesOfMoneyExact('lib/format.ts', read('lib/format.ts'))
    expect(names).toHaveLength(1)
    const declared = names[0].parent
    expect(ts.isFunctionDeclaration(declared) && declared.name === names[0]).toBe(true)
  })
})
