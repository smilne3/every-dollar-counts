'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts'
import { CHART_SERIES } from '@/lib/chart-palette'
import { money } from '@/lib/format'

export function SpendByCategoryChart({ data }: { data: { category: string; amount: number }[] }) {
  const rows = data.map((d) => ({ name: d.category, amount: Math.round(d.amount * 100) / 100 }))
  return (
    <div style={{ width: '100%', height: Math.max(200, rows.length * 40) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ left: 20, right: 20 }}>
          <CartesianGrid horizontal={false} stroke="#e6e9e3" />
          <XAxis
            type="number"
            tickFormatter={(v) => `$${v}`}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#5f6b64', fontSize: 12 }}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={130}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#8b948c', fontSize: 11 }}
          />
          {/* money(), as every summary is (#215). The raw value in a template printed $1,234.50 as
              "$1234.5". */}
          <Tooltip
            formatter={(v) => money(Number(v))}
            cursor={{ fill: 'rgba(20,35,28,0.04)' }}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid #e6e9e3',
              fontSize: 13,
              boxShadow: '0 4px 12px rgba(20,35,28,0.08)',
            }}
          />
          <Bar dataKey="amount" fill={CHART_SERIES.primary} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
