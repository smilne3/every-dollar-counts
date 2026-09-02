import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BankList } from '@/components/BankList'

afterEach(cleanup)
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const items = [
  { id: '1', institution_name: 'Capital One', status: 'ok', status_detail: null, products: ['transactions'], created_at: '2026-05-07' },
  { id: '2', institution_name: 'Fidelity', status: 'ok', status_detail: null, products: ['investments'], created_at: '2026-05-08' },
]

describe('BankList lifetime connections', () => {
  // The count exists to be looked at: the plan gives ten for the life of the account and a
  // disconnect never returns one, so "how many are left" is the only question that matters (#51).
  it('says how many of the allowance are spent', () => {
    render(<BankList items={items} slotsUsed={6} lifetimeSlots={10} />)
    expect(screen.getByText(/6 of 10 lifetime connections used/)).toBeTruthy()
    expect(screen.getByText(/does not give it back/)).toBeTruthy()
  })

  // The spent count is what matters, and it is not the same as the live count — that is the whole
  // reason this number could not be shown before.
  it('does not confuse spent with active', () => {
    render(<BankList items={items} slotsUsed={6} lifetimeSlots={10} />)
    expect(screen.getByText(/2 bank connections active/)).toBeTruthy()
  })

  // Before migration 018 is applied there is no number. Printing one anyway would be worse than
  // the old wording, which at least states the rule truthfully.
  it('falls back to stating the rule when the count is unknown', () => {
    render(<BankList items={items} slotsUsed={null} lifetimeSlots={10} />)
    expect(screen.queryByText(/lifetime connections used/)).toBeNull()
    expect(screen.getByText(/You get 10 over the lifetime of the account/)).toBeTruthy()
  })

  it('warns as the allowance runs out', () => {
    const { container } = render(<BankList items={items} slotsUsed={9} lifetimeSlots={10} />)
    expect(container.querySelector('.text-amber')).not.toBeNull()
    cleanup()
    const { container: spent } = render(<BankList items={items} slotsUsed={10} lifetimeSlots={10} />)
    expect(spent.querySelector('.text-coral')).not.toBeNull()
  })
})
