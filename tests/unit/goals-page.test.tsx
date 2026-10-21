import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The goals page reads the table directly (app/api/goals/route.ts has no GET). The stand-in is
// strict, as in tests/unit/goals-route.test.ts (#99, #101): the goals resolve only through
// .select().order() awaited at the end of the chain, and each call is recorded, so a narrowed select
// or a dropped order cannot pass.
const { calls, reply, onRead } = vi.hoisted(() => ({
  calls: [] as unknown[][],
  reply: { value: { data: [] as unknown, error: null as { message: string } | null } },
  // Run as the read is awaited, so a test can move the clock on during it.
  onRead: { value: () => {} },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table !== 'goals') throw new Error(`unexpected table ${table}`)
      return {
        select: (cols: string) => {
          calls.push(['select', cols])
          return {
            order: (col: string) => {
              calls.push(['order', col])
              return {
                then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                  onRead.value()
                  return Promise.resolve(reply.value).then(resolve, reject)
                },
              }
            },
          }
        },
      }
    },
  }),
}))

import GoalsPage from '@/app/(app)/goals/page'
import { GoalsList } from '@/components/GoalsList'

// Server Components return an unrendered React element tree, so the props the page hands GoalsList
// can be read straight off it (see tests/unit/settings-page.test.tsx).
function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, type)
      if (found) return found
    }
    return null
  }
  const el = node as { type?: unknown; props?: { children?: unknown } }
  if (el.type === type) return (el.props ?? {}) as Record<string, unknown>
  if (el.props && 'children' in el.props) return findProps(el.props.children, type)
  return null
}

const GOAL = { id: 'g-1', name: 'Emergency fund', target_amount: 3000, saved_amount: 1200 }

beforeEach(() => {
  calls.length = 0
  reply.value = { data: [GOAL], error: null }
  onRead.value = () => {}
})
afterEach(() => vi.useRealTimers())

describe('Goals page', () => {
  it('hands GoalsList the goals, in the order they were made', async () => {
    const props = findProps(await GoalsPage(), GoalsList)
    expect(props?.initialGoals).toEqual([GOAL])
    expect(calls).toEqual([
      ['select', 'id, name, target_amount, saved_amount'],
      ['order', 'created_at'],
    ])
  })

  // "You have no savings goals" is a claim about the household, not about the database (#46).
  it('throws when the goals cannot be read', async () => {
    reply.value = { data: null, error: { message: 'boom' } }
    await expect(GoalsPage()).rejects.toThrow('could not read savings goals: boom')
  })

  // #182: a goal's card refills what it sent only from a read made after its last update was
  // written, so the time it is given is taken before the goals are read. Taken after, a read that
  // began before an update was written and returned after it would pass as newer.
  it('tells GoalsList when it read the goals, timed from before the read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
    const before = Date.now()
    onRead.value = () => vi.setSystemTime(before + 5_000)
    const props = findProps(await GoalsPage(), GoalsList)
    expect(props?.initialGoals).toEqual([GOAL])
    expect(props?.readAt).toBe(before)
  })
})
