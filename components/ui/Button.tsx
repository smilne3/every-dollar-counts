import type { ButtonHTMLAttributes, Ref } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40'

const variants: Record<Variant, string> = {
  primary: 'bg-emerald text-white hover:bg-emerald-600',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  ghost: 'text-muted hover:text-ink hover:bg-surface-2',
  danger: 'text-coral border border-line hover:bg-coral-050',
}

// `h-8`/`h-10` become desktop-only and a 44px minimum applies below `md` (§7). Written as
// `min-h-[44px] md:h-8` rather than by changing h-8 itself, so the desktop button is the height
// it has always been and only the phone changes.
const sizes: Record<Size, string> = {
  sm: 'min-h-[44px] md:h-8 md:min-h-0 px-3 text-sm',
  md: 'min-h-[44px] md:h-10 md:min-h-0 px-4 text-sm',
}

// Shared class string so <a>/<Link>/<button> can all match the button look.
export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = '') {
  return `${base} ${variants[variant]} ${sizes[size]} ${extra}`.trim()
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  ref?: Ref<HTMLButtonElement> // React 19 passes ref as a plain prop to function components
}) {
  return <button className={buttonClass(variant, size, className)} {...props} />
}
