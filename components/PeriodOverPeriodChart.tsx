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

const EMERALD = '#0e9f6e'
const GRAY = '#c9cec7'

// Two equal windows side by side, per category. The keys stay `current`/`previous`; the window
// names arrive as `name` on each Bar, which is what Legend and Tooltip display. They used to be
// the literal dataKeys "This"/"Last", which cannot say which window they mean now that the
// windows are rolling 30-day periods rather than calendar months (#67).
export function PeriodOverPeriodChart({
  data,
  currentLabel,
  previousLabel,
}: {
  data: { category: string; current: number; previous: number }[]
  currentLabel: string
  previousLabel: string
}) {
  const rows = data.map((d) => ({
    name: d.category,
    current: Math.round(d.current * 100) / 100,
    previous: Math.round(d.previous * 100) / 100,
  }))
  return (
    <div style={{ width: '100%', height: 340 }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ left: 20, right: 20, bottom: 60 }} barGap={4}>
          <CartesianGrid vertical={false} stroke="#e6e9e3" />
          <XAxis
            dataKey="name"
            angle={-40}
            textAnchor="end"
            interval={0}
            height={70}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#5f6b64', fontSize: 12 }}
          />
          <YAxis
            tickFormatter={(v) => `$${v}`}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#8b948c', fontSize: 11 }}
          />
          <Tooltip
            formatter={(v) => `$${v}`}
            cursor={{ fill: 'rgba(20,35,28,0.04)' }}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid #e6e9e3',
              fontSize: 13,
              boxShadow: '0 4px 12px rgba(20,35,28,0.08)',
            }}
          />
          <Legend
            iconType="circle"
            iconSize={9}
            wrapperStyle={{ fontSize: 12, color: '#5f6b64', paddingTop: 4 }}
          />
          <Bar dataKey="previous" name={previousLabel} fill={GRAY} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          <Bar dataKey="current" name={currentLabel} fill={EMERALD} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
