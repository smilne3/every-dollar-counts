import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'

afterEach(cleanup)

const bank = (institution_name: string | null, status: string) => ({ institution_name, status })

// The dashboard's banner, moved so every page that shows a bank's figures says the same thing (#135).
// The page tests check each page hands it the bank list in the right place; this checks what it says.
describe('NotSyncingBanner', () => {
  it('shows nothing while every bank is syncing', () => {
    const { container } = render(<NotSyncingBanner items={[bank('Capital One', 'ok'), bank('Amex', 'ok')]} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing for a household with no banks', () => {
    const { container } = render(<NotSyncingBanner items={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('names the bank whose login broke, and sends the reader to Settings to reconnect it', () => {
    render(<NotSyncingBanner items={[bank('Amex', 'ok'), bank('Capital One', 'needs_reconnect')]} />)
    const link = screen.getByRole('link')
    expect(link.textContent).toBe(
      "Capital One isn't syncing — reconnect in Settings to resume. These figures may be out of date."
    )
    expect(link.getAttribute('href')).toBe('/settings')
  })

  // Reconnecting does not fix these (components/BankList.tsx says what does), so it says only
  // "see Settings".
  it.each(['action_at_bank', 'temporarily_unavailable', 'config_error'])(
    'sends a bank that is %s to Settings without telling the reader to reconnect',
    (status) => {
      render(<NotSyncingBanner items={[bank('Capital One', status)]} />)
      expect(screen.getByRole('link').textContent).toBe(
        "Capital One isn't syncing — see Settings. These figures may be out of date."
      )
    }
  )

  // The definition is the dashboard's: anything but 'ok'. A status this code has never seen is not
  // proof the bank is fine.
  it('counts a status it does not know as not syncing', () => {
    render(<NotSyncingBanner items={[bank('Capital One', 'something_new')]} />)
    expect(screen.getByRole('link').textContent).toContain("Capital One isn't syncing")
  })

  it('counts several banks, and says to reconnect when any of them needs it', () => {
    render(
      <NotSyncingBanner
        items={[bank('Capital One', 'temporarily_unavailable'), bank('Amex', 'ok'), bank('Chase', 'needs_reconnect')]}
      />
    )
    expect(screen.getByRole('link').textContent).toBe(
      "2 banks aren't syncing — reconnect in Settings to resume. These figures may be out of date."
    )
  })

  it('says "A bank" when the bank has no name', () => {
    render(<NotSyncingBanner items={[bank(null, 'needs_reconnect')]} />)
    expect(screen.getByRole('link').textContent).toMatch(/^A bank isn't syncing — /)
  })

  // The dashboard's look, exactly, so its phone layout, already checked there, carries to every page.
  it('keeps the look the dashboard banner had', () => {
    render(<NotSyncingBanner items={[bank('Capital One', 'needs_reconnect')]} />)
    expect(screen.getByRole('link').className).toBe(
      'block rounded-card border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral'
    )
  })
})
