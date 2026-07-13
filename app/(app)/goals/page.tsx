import { createClient } from '@/lib/supabase/server'
import { GoalsList } from '@/components/GoalsList'

export default async function GoalsPage() {
  const supabase = await createClient()
  const { data: goals } = await supabase
    .from('goals')
    .select('id, name, target_amount, saved_amount')
    .order('created_at')

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Savings goals</h1>
      <p className="text-sm text-gray-600">
        Set a target and track how close you are. Update the saved amount as you go.
      </p>
      <GoalsList initialGoals={goals ?? []} />
    </div>
  )
}
