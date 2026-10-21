import { createClient } from '@/lib/supabase/server'
import { GoalsList } from '@/components/GoalsList'
import { PageHeader } from '@/components/ui/PageHeader'

type Supabase = Awaited<ReturnType<typeof createClient>>

// The household's goals, and when they were read by the server's clock, for each goal's card to tell
// this read from one made before its last update was written. The time is taken before the read, so
// it is never later than it (#182).
async function readGoals(supabase: Supabase) {
  const readAt = Date.now()
  const { data: goals, error: goalsError } = await supabase
    .from('goals')
    .select('id, name, target_amount, saved_amount')
    .order('created_at')
  // "You have no savings goals" is a claim about the household, not about the database (#46).
  if (goalsError) throw new Error(`could not read savings goals: ${goalsError.message}`)
  return { goals, readAt }
}

export default async function GoalsPage() {
  const supabase = await createClient()
  const { goals, readAt } = await readGoals(supabase)

  return (
    <div className="space-y-6">
      <PageHeader title="Savings goals" subtitle="Set a target and track how close you are." />
      <GoalsList initialGoals={goals ?? []} readAt={readAt} />
    </div>
  )
}
