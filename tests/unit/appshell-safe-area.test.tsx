import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { AppShell } from '@/components/AppShell'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}))

afterEach(cleanup)

// With viewportFit 'cover' (app/layout.tsx) the page runs under the notch and the home indicator,
// and only these insets keep content out of them (#21). The tab bar grows by the home indicator's
// height, so the page's bottom padding has to grow by the same amount, or the last card on a long
// page ends up behind the bar.
function shell() {
  const { container } = render(
    <AppShell householdName="Milne" userEmail="a@b.c">
      <p>content</p>
    </AppShell>
  )
  return {
    main: container.querySelector('main')!.className,
    tabBar: container.querySelector('nav.fixed.bottom-0')!.className,
    aside: container.querySelector('aside')!.className,
  }
}

describe('AppShell safe areas', () => {
  it('the tab bar pads the home indicator', () => {
    expect(shell().tabBar).toContain('pb-[env(safe-area-inset-bottom)]')
  })

  it('the page clears the tab bar plus the home indicator on a phone', () => {
    expect(shell().main).toContain('pb-[calc(6rem+env(safe-area-inset-bottom))]')
  })

  // The desktop/landscape layout has no tab bar, so its padding must not grow with it.
  it('keeps the fixed bottom padding from md up', () => {
    expect(shell().main).toContain('md:pb-10')
  })

  // An iPhone in landscape is wider than md, so it gets the sidebar, with the notch on one side.
  it('keeps the sidebar and the content clear of a landscape notch', () => {
    const { aside, main } = shell()
    expect(aside).toContain('pl-[env(safe-area-inset-left)]')
    expect(main).toContain('md:pr-[max(2rem,env(safe-area-inset-right))]')
  })
})
