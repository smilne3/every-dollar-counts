// Shared class strings for consistent form controls across the app.
//
// `min-h-[44px] md:min-h-0`: §7 asks for a 44px minimum tap height on a phone, and every control
// here was under it — this one was ≈38px, the select ≈34px. Released at `md` so the desktop
// layouts stages 1-4 shipped are untouched; the padding below still sets the height there.

export const inputClass =
  'w-full min-h-[44px] md:min-h-0 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40'

export const selectClass =
  'w-full md:w-auto min-h-[44px] md:min-h-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:opacity-50'

export const labelClass = 'text-sm font-medium text-ink'
