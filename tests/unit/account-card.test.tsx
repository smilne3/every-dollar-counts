import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AccountCard } from '@/components/AccountCard'

afterEach(cleanup)

const account = (type: string, current_balance: number | null) => ({
  id: 'a1',
  name: 'Quicksilver',
  type,
  subtype: null,
  current_balance,
  iso_currency_code: 'USD',
})

describe('AccountCard', () => {
  // Whole dollars, as every balance is (#215).
  it('shows a balance in whole dollars', () => {
    render(<AccountCard account={account('depository', 19039.2)} />)
    expect(screen.getByText('$19,039').className).toContain('text-ink')
  })

  it('shows a debt as a negative, in coral', () => {
    render(<AccountCard account={account('credit', 1234.56)} />)
    expect(screen.getByText('−$1,235').className).toContain('text-coral')
    expect(screen.getByText('Owed')).toBeTruthy()
  })

  // #215: a debt under 50 cents rounds to $0, and "−$0" in coral would be a debt of nothing. The
  // minus sign and the colour follow the figure shown. It is still the card's debt account, so it
  // still says Owed.
  it('shows a debt that rounds to $0 as a plain $0', () => {
    render(<AccountCard account={account('credit', 0.3)} />)
    expect(screen.getByText('$0').className).not.toContain('text-coral')
    expect(screen.queryByText('−$0')).toBeNull()
    expect(screen.getByText('Owed')).toBeTruthy()
  })

  // From 50 cents, it rounds to a dollar owed, and is one.
  it('shows a debt of 50 cents as a dollar owed', () => {
    render(<AccountCard account={account('credit', 0.5)} />)
    expect(screen.getByText('−$1').className).toContain('text-coral')
  })
})
