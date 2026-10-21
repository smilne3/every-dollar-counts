import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ComponentType } from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ErrorInfo } from 'next/dist/client/components/error-boundary'
import AppSegmentError from '@/app/(app)/error'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// What Next renders an error boundary with: its own ErrorInfo (`reset`, `retry`), with `error` as the
// docs promise it (Next types it `unknown` internally, since anything can be thrown).
type NextErrorProps = Omit<ErrorInfo, 'error'> & { error: Error & { digest?: string } }

// This page took `unstable_retry`, the name before Next 16.3 made `retry` stable. #88 moved the app to
// 16.3.4 on 2026-09-08 and nothing noticed: the props were typed by hand, so "Try again" called
// undefined and did nothing. Every page that throws on a failed read (#46, #91) lands here, so the
// retry is the whole way back.
describe('app/(app)/error.tsx', () => {
  it('takes only props Next renders an error boundary with', () => {
    // A type check, run by tsc in CI: if the page asks for a prop Next does not pass (or Next renames
    // one again), this line stops compiling.
    const asNextRendersIt: ComponentType<NextErrorProps> = AppSegmentError
    expect(asNextRendersIt).toBe(AppSegmentError)
  })

  it('"Try again" retries through the retry prop', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const retry = vi.fn()
    const reset = vi.fn()
    const props: NextErrorProps = { error: new Error('could not read linked banks: timeout'), reset, retry }
    render(<AppSegmentError {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(retry).toHaveBeenCalledTimes(1)
    // reset() re-renders without re-fetching, so a failed server read would only fail again.
    expect(reset).not.toHaveBeenCalled()
  })

  // It used to add "Your other pages are unaffected". A failed read of the bank list, which every
  // money page makes for the "isn't syncing" banner (#171), takes them all down at once.
  it('says what to do, and promises nothing about the other pages', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const props: NextErrorProps = { error: new Error('could not read linked banks: timeout'), reset: vi.fn(), retry: vi.fn() }
    render(<AppSegmentError {...props} />)
    expect(screen.getByText(/^Something went wrong/).textContent).toBe(
      'Something went wrong fetching this data. Try again, or come back in a moment.'
    )
  })
})
