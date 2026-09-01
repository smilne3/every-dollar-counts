import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReimbursableCheckbox } from '@/components/ReimbursableCheckbox'

afterEach(cleanup)
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
})
