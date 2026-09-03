import { createClient } from '@/lib/supabase/server'
import { GoalsList } from '@/components/GoalsList'
import { PageHeader } from '@/components/ui/PageHeader'

export default async function GoalsPage() {
  const supabase = await createClient()
  const { data: goals, error: goalsError } = await supabase
    .from('goals')
    .select('id, name, target_amount, saved_amount')
    .order('created_at')
  // "You have no savings goals" is a claim about the household, not about the database (#46).
  if (goalsError) throw new Error(`could not read savings goals: ${goalsError.message}`)

  return (
    <div className="space-y-6">
      <PageHeader title="Savings goals" subtitle="Set a target and track how close you are." />
      <GoalsList initialGoals={goals ?? []} />
    </div>
  )
}
