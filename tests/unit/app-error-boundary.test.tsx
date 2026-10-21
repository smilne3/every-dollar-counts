import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ComponentType } from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ErrorInfo } from 'next/dist/client/components/error-boundary'
import AppSegmentError from '@/app/(app)/error'
import RootError from '@/app/error'

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

  // #130: in production the message is replaced ("Minified React error #441"), and only the digest
  // matches the screen to the server's log line.
  it("shows a server error's digest, in small print", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const props: NextErrorProps = { error: serverError('2817436171'), reset: vi.fn(), retry: vi.fn() }
    render(<AppSegmentError {...props} />)
    expect(screen.getByText('Error ID 2817436171').className).toContain('text-xs')
  })

  it('shows no digest line for an error without one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const props: NextErrorProps = { error: new Error('boom'), reset: vi.fn(), retry: vi.fn() }
    render(<AppSegmentError {...props} />)
    expect(screen.queryByText(/^Error ID/)).toBeNull()
  })
})

// An error a server component threw, as the browser receives it in production: the message
// replaced, the digest kept.
function serverError(digest: string) {
  return Object.assign(new Error('Minified React error #441'), { digest })
}

// The boundary above app/(app)/layout.tsx, for its sign-in check (#143). A server error carries a
// digest, and the layout's sign-in check is the one server component it sits over.
describe('app/error.tsx', () => {
  it('takes only props Next renders an error boundary with', () => {
    const asNextRendersIt: ComponentType<NextErrorProps> = RootError
    expect(asNextRendersIt).toBe(RootError)
  })

  it('says sign-in could not be checked when the server threw, and shows the digest in small print', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const props: NextErrorProps = { error: serverError('1638223470'), reset: vi.fn(), retry: vi.fn() }
    render(<RootError {...props} />)
    expect(screen.getByRole('heading').textContent).toBe("Couldn't check your sign-in")
    expect(screen.getByText(/^Something went wrong/).textContent).toBe(
      'Something went wrong reaching the sign-in service. Try again, or come back in a moment.'
    )
    expect(screen.getByText('Error ID 1638223470').className).toContain('text-xs')
  })

  // A crash in the browser, on /login or /plaid/oauth say, has nothing to do with the sign-in check.
  it('says only that the page could not load for an error from the browser, which has no digest', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const props: NextErrorProps = {
      error: new TypeError("Cannot read properties of undefined (reading 'name')"),
      reset: vi.fn(),
      retry: vi.fn(),
    }
    render(<RootError {...props} />)
    expect(screen.getByRole('heading').textContent).toBe("This page couldn't load")
    expect(screen.getByText(/^Something went wrong/).textContent).toBe('Something went wrong. Try again, or come back in a moment.')
    expect(screen.queryByText(/sign-in/)).toBeNull()
    expect(screen.queryByText(/^Error ID/)).toBeNull()
  })

  // Anything can be thrown in the browser, not only an Error (Next's error.js docs).
  it('still renders for a thrown value that is not an Error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const props: NextErrorProps = { error: null as unknown as Error, reset: vi.fn(), retry: vi.fn() }
    render(<RootError {...props} />)
    expect(screen.getByRole('heading').textContent).toBe("This page couldn't load")
  })

  it('"Try again" runs the check again through the retry prop', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const retry = vi.fn()
    const reset = vi.fn()
    const props: NextErrorProps = { error: serverError('1638223470'), reset, retry }
    render(<RootError {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
    // reset() re-renders without re-fetching, so the layout would not check again.
    expect(reset).not.toHaveBeenCalled()
  })

  it('logs what it caught, as app/(app)/error.tsx does', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const props: NextErrorProps = { error: serverError('1638223470'), reset: vi.fn(), retry: vi.fn() }
    render(<RootError {...props} />)
    expect(logged).toHaveBeenCalledWith(props.error)
  })
})
