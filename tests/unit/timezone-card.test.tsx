import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TimezoneCard } from '@/components/TimezoneCard'

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
afterEach(cleanup)

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('TimezoneCard', () => {
  it('shows the stored zone as the selected option', () => {
    render(<TimezoneCard current="America/Chicago" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    expect(select.value).toBe('America/Chicago')
  })

  // A zone the browser does not enumerate must still be visible rather than silently replaced by
  // whatever happens to sort first.
  it('keeps an unrecognised stored zone in the list', () => {
    render(<TimezoneCard current="Etc/GMT+3" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    expect(Array.from(select.options).some((o) => o.value === 'Etc/GMT+3')).toBe(true)
    expect(select.value).toBe('Etc/GMT+3')
  })

  it('offers a real list of zones', () => {
    render(<TimezoneCard current="America/New_York" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    expect(select.options.length).toBeGreaterThan(5)
    expect(Array.from(select.options).some((o) => o.value === 'America/New_York')).toBe(true)
  })

  it('shows the server\'s message when saving fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'That is not a timezone we recognise.' }) }))
    )
    render(<TimezoneCard current="America/New_York" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(select, { target: { value: 'America/Chicago' } })
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That is not a timezone we recognise.'
    )
  })
})
