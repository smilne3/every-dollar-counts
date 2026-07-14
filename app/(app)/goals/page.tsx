import { createClient } from '@/lib/supabase/server'
import { GoalsList } from '@/components/GoalsList'
import { PageHeader } from '@/components/ui/PageHeader'

export default async function GoalsPage() {
  const supabase = await createClient()
  const { data: goals } = await supabase
    .from('goals')
    .select('id, name, target_amount, saved_amount')
    .order('created_at')

  return (
    <div className="space-y-6">
      <PageHeader title="Savings goals" subtitle="Set a target and track how close you are." />
      <GoalsList initialGoals={goals ?? []} />
    </div>
  )
}
