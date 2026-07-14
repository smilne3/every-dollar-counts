'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType } from 'react'
import { SignOutButton } from '@/components/SignOutButton'
import {
  HomeIcon,
  TransactionsIcon,
  WalletIcon,
  TrendsIcon,
  TargetIcon,
  SettingsIcon,
} from '@/components/ui/icons'

type NavItem = {
  href: string
  label: string
  short: string
  Icon: ComponentType<{ className?: string }>
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', short: 'Home', Icon: HomeIcon },
  { href: '/transactions', label: 'Transactions', short: 'Activity', Icon: TransactionsIcon },
  { href: '/budgets', label: 'Budgets', short: 'Budgets', Icon: WalletIcon },
  { href: '/trends', label: 'Trends', short: 'Trends', Icon: TrendsIcon },
  { href: '/goals', label: 'Goals', short: 'Goals', Icon: TargetIcon },
  { href: '/settings', label: 'Settings', short: 'Settings', Icon: SettingsIcon },
]

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + '/')
}

function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`grid place-items-center rounded-xl bg-emerald font-bold text-white ${className}`}
      aria-hidden="true"
    >
      $
    </span>
  )
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '')
  return letters.join('') || 'EDC'
}

export function AppShell({
  children,
  householdName,
  userEmail,
}: {
  children: React.ReactNode
  householdName: string
  userEmail: string
}) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-pine text-white md:flex">
        <div className="flex items-center gap-2.5 px-5 pb-2 pt-5">
          <BrandMark className="h-9 w-9 text-lg" />
          <span className="text-sm font-semibold leading-tight text-white">
            Every Dollar
            <br />
            Counts
          </span>
        </div>

        <nav className="mt-4 flex flex-1 flex-col gap-1 px-3">
          {NAV.map(({ href, label, Icon }) => {
            const active = isActive(pathname, href)
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-pine-500 font-medium text-white'
                    : 'text-white/65 hover:bg-pine-600 hover:text-white'
                }`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald/90 text-xs font-semibold text-white">
              {initials(householdName)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-white">{householdName}</div>
              <div className="truncate text-xs text-white/55">{userEmail}</div>
            </div>
          </div>
          <SignOutButton className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/60 transition-colors hover:bg-pine-600 hover:text-white disabled:opacity-50" />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur md:hidden">
        <div className="flex items-center gap-2">
          <BrandMark className="h-8 w-8 text-base" />
          <span className="text-sm font-semibold text-ink">Every Dollar Counts</span>
        </div>
        <SignOutButton
          showLabel={false}
          className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        />
      </header>

      {/* Main content */}
      <div className="md:pl-64">
        <main className="mx-auto max-w-6xl px-4 py-6 pb-24 md:px-8 md:py-8 md:pb-10">{children}</main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map(({ href, short, Icon }) => {
          const active = isActive(pathname, href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
                active ? 'text-emerald' : 'text-faint hover:text-ink'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="w-full truncate text-center">{short}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
