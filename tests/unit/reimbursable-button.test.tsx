import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReimbursableButton } from '@/components/ReimbursableButton'

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
afterEach(cleanup)

// The component calls router.refresh() after a successful write. Nothing here writes, but the hook
// runs at render, so it needs to exist.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}))

const txn = (amount: number) => ({ amount, pfc_detailed: null, user_category: null })
const claim = (id: string, name: string) => ({ id, name, written_off_on: null })

const props = {
  transactionId: 't1',
  txn: txn(78),
  splits: [],
  pinned: [],
  label: 'Starbucks',
}

// The column header says "Reimbursable" once. Repeating it in all forty cells was the thing the
// header replaced, so a cell that still prints it has undone the change.
describe('ReimbursableButton under a Reimbursable column header', () => {
  it('renders a bare checkbox for the default claim', () => {
    render(<ReimbursableButton {...props} />)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.queryByText(/Reimbursable/)).toBeNull()
  })

  // Without this the accessible name is "checkbox" forty times over, with nothing to tell the rows
  // apart — a column header is announced in table navigation, but not when focus lands on the input.
  it('names the row it belongs to for screen readers', () => {
    render(<ReimbursableButton {...props} />)
    expect(screen.getByRole('checkbox', { name: /Starbucks/ })).toBeTruthy()
  })

  // A household running "Dan's work" and "Sarah's work" pinned those names deliberately, so the cell
  // still has to say WHICH — it just no longer repeats the word above it.
  it('shows the claim name, without the word, when a named claim is pinned', () => {
    render(<ReimbursableButton {...props} pinned={[claim('c1', "Dan's work")]} />)
    expect(screen.getByText("Dan's work")).toBeTruthy()
    expect(screen.queryByText(/Reimbursable/)).toBeNull()
  })

  it('renders the box ticked when the row is already reimbursable', () => {
    render(
      <ReimbursableButton
        {...props}
        splits={[{ id: 's1', claim_id: 'c1', amount: 78 }]}
        pinned={[claim('c1', "Dan's work")]}
      />
    )
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  // The inflow and credit-card-payment guards still own the cell: it stays empty rather than
  // offering a one-tap action the splits API would refuse.
  it('renders nothing at all on an inflow', () => {
    const { container } = render(<ReimbursableButton {...props} txn={txn(-260)} />)
    expect(container.firstChild).toBeNull()
  })
})
