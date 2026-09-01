import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ReimbursableCheckbox } from '@/components/ReimbursableCheckbox'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const props = { transactionId: 't1', amount: 78, reimbursableAmount: null, label: 'Starbucks' }

describe('ReimbursableCheckbox', () => {
  it('is unticked when nothing is marked', () => {
    render(<ReimbursableCheckbox {...props} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('is ticked when the whole transaction is marked', () => {
    render(<ReimbursableCheckbox {...props} reimbursableAmount={78} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  // The column header is announced in table navigation but NOT when focus lands on the input, so
  // without this a screen reader hears "checkbox" down forty rows with nothing to tell them apart.
  it('names the row it belongs to', () => {
    render(<ReimbursableCheckbox {...props} />)
    expect(screen.getByRole('checkbox', { name: /Starbucks/ })).toBeTruthy()
  })

  // A partial mark is NOT a binary state. A ticked box beside "$750 of $1,000" would claim the whole
  // charge is coming back; an unticked one would claim none of it is. Both are lies, so it shows the
  // amount instead and sends the user to the editor.
  it('shows the marked amount rather than a box when only part is marked', () => {
    render(<ReimbursableCheckbox {...props} amount={1000} reimbursableAmount={750} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(/750/)).toBeTruthy()
  })

  it('renders nothing on a credit-card payment', () => {
    const { container } = render(
      <ReimbursableCheckbox {...props} pfcDetailed="LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" />
    )
    expect(container.firstChild).toBeNull()
  })

  // 0 would violate the DB CHECK's `reimbursable_amount > 0 or null`. Unticking must clear the mark
  // by sending `amount: null`, never `0` — this is the wire-level counterpart to
  // clampReimbursable's own null-not-zero contract in tests/unit/reimbursable-amount.test.ts.
  it('sends amount: null, not 0, when unticking a marked checkbox', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    render(<ReimbursableCheckbox {...props} reimbursableAmount={78} />)
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    fireEvent.click(checkbox)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/reimbursable')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.amount).toBeNull()
  })

  // Clearing the mark must clear the memo too, or reimbursable_note stays set on a transaction whose
  // reimbursable_amount is null — data with nowhere it is shown, orphaned by the very action meant to
  // undo the mark.
  it('clears the note along with the amount when unticking', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    render(<ReimbursableCheckbox {...props} reimbursableAmount={78} note="Dave" />)
    fireEvent.click(screen.getByRole('checkbox'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.note).toBeNull()
  })
})
