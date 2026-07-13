'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'

export function MonthOverMonthChart({
  data,
}: {
  data: { category: string; thisMonth: number; lastMonth: number }[]
}) {
  const rows = data.map((d) => ({
    name: d.category,
    This: Math.round(d.thisMonth * 100) / 100,
    Last: Math.round(d.lastMonth * 100) / 100,
  }))
  return (
    <div style={{ width: '100%', height: 340 }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ left: 20, right: 20, bottom: 60 }}>
          <XAxis dataKey="name" angle={-40} textAnchor="end" interval={0} height={70} />
          <YAxis tickFormatter={(v) => `$${v}`} />
          <Tooltip formatter={(v) => `$${v}`} />
          <Legend />
          <Bar dataKey="Last" fill="#94a3b8" radius={[4, 4, 0, 0]} />
          <Bar dataKey="This" fill="#16a34a" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
