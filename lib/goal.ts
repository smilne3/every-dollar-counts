// Progress toward a savings goal: clamped ratio of saved / target in [0,1].
export function goalProgress(saved: number, target: number): number {
  if (target <= 0) return 0
  return Math.min(Math.max(saved / target, 0), 1)
}
