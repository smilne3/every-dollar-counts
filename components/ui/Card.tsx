import type { HTMLAttributes } from 'react'

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-card border border-line bg-surface shadow-[0_1px_2px_rgba(20,35,28,0.05)] ${className}`}
      {...props}
    />
  )
}
