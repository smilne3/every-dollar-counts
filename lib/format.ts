export function money(amount: number | null | undefined, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount ?? 0)
}
