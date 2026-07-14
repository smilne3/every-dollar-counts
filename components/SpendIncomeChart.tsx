'use client'

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts'

type Row = { label: string; income: number; spending: number }

const EMERALD = '#0e9f6e'
const CORAL = '#df6742'

export function SpendIncomeChart({ data }: { data: Row[] }) {
  const rows = data.map((d) => ({
    name: d.label,
    Income: Math.round(d.income * 100) / 100,
    Spending: Math.round(d.spending * 100) / 100,
  }))
  return (
    <div style={{ width: '100%', height: 260 }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, left: 4, right: 8, bottom: 0 }} barGap={4}>
          <CartesianGrid vertical={false} stroke="#e6e9e3" />
          <XAxis
            dataKey="name"
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#5f6b64', fontSize: 12 }}
          />
          <YAxis
            tickFormatter={(v) => `$${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`}
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fill: '#8b948c', fontSize: 11 }}
          />
          <Tooltip
            formatter={(value) => `$${Number(value).toLocaleString()}`}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid #e6e9e3',
              fontSize: 13,
              boxShadow: '0 4px 12px rgba(20,35,28,0.08)',
            }}
            cursor={{ fill: 'rgba(20,35,28,0.04)' }}
          />
          <Legend
            iconType="circle"
            iconSize={9}
            wrapperStyle={{ fontSize: 12, color: '#5f6b64', paddingTop: 4 }}
          />
          <Bar dataKey="Income" fill={EMERALD} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          <Bar dataKey="Spending" fill={CORAL} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
