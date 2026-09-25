import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReimbursementCard } from '@/components/ReimbursementCard'

afterEach(cleanup)

const props = { label: 'Starbucks', amount: 8.2, date: '2026-09-01', note: 'Dave' }

describe('ReimbursementCard', () => {
  it('leads with the merchant and the amount', () => {
    render(<ReimbursementCard {...props} />)
    expect(screen.getByText('Starbucks')).toBeTruthy()
    expect(screen.getByText('$8.20')).toBeTruthy()
  })

  // §6: rows expose who owes it. The note is where a name lives.
  it('puts the date and who owes it on one muted line', () => {
    render(<ReimbursementCard {...props} />)
    expect(screen.getByText('Sep 1 · Dave')).toBeTruthy()
  })

  // A mark with no note is ordinary — most are. The separator must not strand itself.
  it('shows the date alone when there is no note', () => {
    render(<ReimbursementCard {...props} note={null} />)
    expect(screen.getByText('Sep 1')).toBeTruthy()
    expect(screen.queryByText(/·/)).toBeNull()
  })

  it('treats an empty note the same as no note', () => {
    render(<ReimbursementCard {...props} note="" />)
    expect(screen.getByText('Sep 1')).toBeTruthy()
    expect(screen.queryByText(/·/)).toBeNull()
  })

  // The case an emptiness check misses: whitespace is truthy, so without trimming the separator
  // renders with nothing after it. A note field someone tabbed through produces exactly this.
  it('treats a whitespace-only note the same as no note', () => {
    render(<ReimbursementCard {...props} note="   " />)
    expect(screen.getByText('Sep 1')).toBeTruthy()
    expect(screen.queryByText(/·/)).toBeNull()
  })

  // And a note with a stray space around a real name is still that name. Asserted on textContent
  // rather than through the matcher, because getByText normalises whitespace away and would find
  // this line whether or not the component trimmed it.
  it('trims the padding off a note it does show', () => {
    render(<ReimbursementCard {...props} note="  Dave  " />)
    expect(screen.getByText('Sep 1 · Dave').textContent).toBe('Sep 1 · Dave')
  })

  // The figure is the reason the page exists; it must not be the thing that wraps.
  it('keeps the amount on one line', () => {
    render(<ReimbursementCard {...props} amount={12345.67} />)
    expect(screen.getByText('$12,345.67').className).toContain('whitespace-nowrap')
  })

  it('renders a long merchant name without pushing the amount off', () => {
    render(<ReimbursementCard {...props} label={'A'.repeat(60)} />)
    expect(screen.getByText('A'.repeat(60)).className).toContain('truncate')
  })
})
