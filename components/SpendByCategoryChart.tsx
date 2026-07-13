'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { label } from '@/lib/categories'

export function SpendByCategoryChart({ data }: { data: { category: string; amount: number }[] }) {
  const rows = data.map((d) => ({ name: label(d.category), amount: Math.round(d.amount * 100) / 100 }))
  return (
    <div style={{ width: '100%', height: Math.max(200, rows.length * 40) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ left: 20, right: 20 }}>
          <XAxis type="number" tickFormatter={(v) => `$${v}`} />
          <YAxis type="category" dataKey="name" width={130} />
          <Tooltip formatter={(v) => `$${v}`} />
          <Bar dataKey="amount" fill="#16a34a" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
