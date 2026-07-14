import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { SignOutButton } from '@/components/SignOutButton'

const NAV: [string, string][] = [
  ['/dashboard', 'Dashboard'],
  ['/transactions', 'Transactions'],
  ['/budgets', 'Budgets'],
  ['/trends', 'Trends'],
  ['/goals', 'Goals'],
  ['/settings', 'Settings'],
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: households } = await supabase.from('households').select('id, name').limit(1)
  const household = households?.[0]

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 p-4 text-sm">
          <span className="font-semibold">Every Dollar Counts</span>
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="text-gray-600 hover:text-black">
              {label}
            </Link>
          ))}
          <span className="ml-auto text-gray-400">{household?.name ?? 'No household yet'}</span>
          <SignOutButton />
        </nav>
      </header>
      <main className="mx-auto max-w-5xl p-4">{children}</main>
    </div>
  )
}
