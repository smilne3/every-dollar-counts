import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { OwedToYouLink } from '@/components/OwedToYouLink'

afterEach(cleanup)

describe('OwedToYouLink', () => {
  // To the cent, like the "You're owed" it leads to (owner decision, 2026-10-23, #215): the total is
  // checked to the cent against an expense report and then the repayment.
  it('shows what is owed to the cent, and links to the reimbursements behind it', () => {
    render(<OwedToYouLink amount={1234.56} currency="USD" />)
    const link = screen.getByRole('link', { name: 'Owed to you: $1,234.56' })
    expect(link.getAttribute('href')).toBe('/reimbursements')
    expect(link.textContent).toBe('Owed to you$1,234.56')
  })

  // It shows for any amount above zero. Rounded, a 30-cent remainder would read "Owed to you $0".
  it('shows a 30-cent remainder as $0.30', () => {
    render(<OwedToYouLink amount={0.3} />)
    expect(screen.getByRole('link', { name: 'Owed to you: $0.30' }).textContent).toBe('Owed to you$0.30')
  })

  it.each([0, -5])('renders nothing when the household is owed %s', (amount) => {
    const { container } = render(<OwedToYouLink amount={amount} />)
    expect(container.firstChild).toBeNull()
  })

  // A 44px tap target below md by its own classes (#122), released from md up.
  it('gives the link a 44px floor below md', () => {
    render(<OwedToYouLink amount={20} />)
    expect(screen.getByRole('link').className.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex', 'min-h-[44px]', 'md:min-h-0'])
    )
  })
})
