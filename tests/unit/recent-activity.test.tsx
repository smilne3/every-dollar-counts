import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RecentActivity, type ActivityItem } from '@/components/RecentActivity'

afterEach(cleanup)

const base: ActivityItem = {
  id: 'a',
  name: 'ASU PREPARATORY',
  category: 'Income',
  date: '2026-08-29',
  amount: -2772.63, // Plaid: negative is money in
}

describe('RecentActivity', () => {
  it('shows real income as arriving', () => {
    render(<RecentActivity items={[base]} />)
    expect(screen.getByText(/\+\$2,772\.63/)).toBeTruthy()
    expect(screen.getByText(/Income ·/)).toBeTruthy()
  })

  // The card-payment leg is also a negative amount, so it took the same emerald "+" treatment as a
  // paycheck. It is not new money — both legs are already excluded from every total (#31).
  it('does not dress a credit-card payment up as income', () => {
    render(
      <RecentActivity
        items={[
          {
            ...base,
            name: 'CAPITAL ONE AUTOPAY PYMT',
            category: 'Loan Payments',
            amount: -7866.69,
            internalTransfer: true,
          },
        ]}
      />
    )
    expect(screen.queryByText(/\+\$7,866\.69/)).toBeNull()
    expect(screen.getByText(/\$7,866\.69/)).toBeTruthy()
    expect(screen.getByText(/Between your accounts ·/)).toBeTruthy()
  })
})
