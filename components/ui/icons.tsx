// Lightweight inline line-icons (24x24, currentColor). No icon dependency.
import type { ReactNode } from 'react'

type IconProps = { className?: string }

function Svg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const HomeIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M3 11l9-8 9 8" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M10 21v-6h4v6" />
  </Svg>
)

export const TransactionsIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M7 7h13l-3-3" />
    <path d="M17 17H4l3 3" />
  </Svg>
)

export const WalletIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <path d="M3 10.5h18" />
    <circle cx="17" cy="14" r="1.15" fill="currentColor" stroke="none" />
  </Svg>
)

export const TrendsIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M17 7h4v4" />
  </Svg>
)

export const TargetIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
)

export const SettingsIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M4 6h8" />
    <path d="M16 6h4" />
    <circle cx="14" cy="6" r="2" />
    <path d="M4 12h4" />
    <path d="M12 12h8" />
    <circle cx="10" cy="12" r="2" />
    <path d="M4 18h8" />
    <path d="M16 18h4" />
    <circle cx="14" cy="18" r="2" />
  </Svg>
)

export const BellIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Svg>
)

export const PlusIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
)

export const SearchIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.6-3.6" />
  </Svg>
)

export const RefreshIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4.2h-4.2" />
  </Svg>
)

export const MenuIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
  </Svg>
)

export const LogOutIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 12h10" />
    <path d="M17 9l3 3-3 3" />
  </Svg>
)

export const BankIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M4 9.5l8-5 8 5" />
    <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" />
    <path d="M3 21h18" />
  </Svg>
)

export const ArrowUpRightIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M7 17L17 7" />
    <path d="M8 7h9v9" />
  </Svg>
)

export const ArrowDownLeftIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M17 7L7 17" />
    <path d="M16 17H7V8" />
  </Svg>
)
