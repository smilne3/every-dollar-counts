import { it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import { BankList } from '@/components/BankList'
import { savePendingLink } from '@/components/plaid-link-context'
import { answering, replyWith, saved } from './helpers/save-replies'
import { useMemoryStorage } from './helpers/memory-storage'

// Reconnect inside the bank list (#165). The reconnect route can answer "Reconnected. New
// transactions have not arrived yet — Refresh will fetch them." The reload that follows shows the
// bank healthy, the list stops rendering its Reconnect button, and a notice shown beside the button
// would go with it, so the list holds it. Plaid Link cannot run here: usePlaidLink is a stand-in
// that keeps the config it was given, to fire onSuccess as Link would.

type LinkConfig = { token: string | null; onSuccess: () => Promise<void>; onExit: (err: unknown) => void }
const plaid = vi.hoisted(() => ({ config: null as LinkConfig | null, open: vi.fn() }))
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (config: LinkConfig) => {
    plaid.config = config
    return { open: plaid.open, ready: config.token !== null }
  },
}))

const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

// jsdom has no showModal()/close() on <dialog> (see tests/unit/confirm-dialog.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})
beforeEach(() => {
  useMemoryStorage()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  refresh.mockClear()
  plaid.config = null
})

const WARNING = 'Reconnected. New transactions have not arrived yet — Refresh will fetch them.'
const bank = (status: string) => ({
  id: 'item-1',
  institution_name: 'Wells Fargo',
  status,
  status_detail: null,
  products: ['transactions'],
  created_at: '2026-05-07',
})
const list = (status: string) => <BankList items={[bank(status)]} slotsUsed={6} lifetimeSlots={10} />

// Reconnects the bank as Link would, then shows the list the reload brings: the bank healthy, so its
// Reconnect button gone.
async function reconnectWithWarning() {
  vi.stubGlobal('fetch', answering(() => replyWith({ ok: true, warning: WARNING })))
  const { rerender } = render(list('needs_reconnect'))
  savePendingLink({ token: 'link-sandbox-update', mode: 'update', itemId: 'item-1' })
  await act(() => plaid.config!.onSuccess())
  expect(refresh).toHaveBeenCalledTimes(1)
  rerender(list('ok'))
  expect(screen.queryByRole('button', { name: /Reconnect/ })).toBeNull()
}

it('keeps the reconnect’s warning after the reload shows the bank healthy', async () => {
  await reconnectWithWarning()
  expect(screen.getByText(WARNING)).toBeTruthy()
})

// A message about the last action must not stand beside the next one's outcome.
it('clears that warning when a disconnect starts', async () => {
  await reconnectWithWarning()
  expect(screen.getByText(WARNING)).toBeTruthy()
  vi.stubGlobal('fetch', answering(saved))
  const row = screen.getByText('Wells Fargo').closest('li') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Disconnect' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Disconnect Wells Fargo?' })).getByRole('button', { name: 'Disconnect' }))
  expect(screen.queryByText(WARNING)).toBeNull()
})
