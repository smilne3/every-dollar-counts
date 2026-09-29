'use client'

import { useState } from 'react'
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
import { CHART_SERIES } from '@/lib/chart-palette'
import { capCategories } from '@/lib/trends'

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
  const [expanded, setExpanded] = useState(false)
  // Phone only. The desktop chart has the width for every category and this stage does not change
  // it (spec §5: the cap is "below `md`").
  const { shown, other } = capCategories(data)
  const phoneRows = expanded || !other ? data : [...shown, other]
  // Grows with its rows, like SpendByCategoryChart. 56 rather than that chart's 40 because each
  // category here carries two bars, not one.
  const phoneHeight = Math.max(200, phoneRows.length * 56)
  return (
    <>
      {/* Horizontal below `md`. recharts calls this layout="vertical" — the name describes the
          axis arrangement, not the bars. Copied from SpendByCategoryChart, which is already this
          shape and already works on a phone. No rotated labels means §1.4's collision cannot
          recur by construction. */}
      <div className="md:hidden" style={{ width: '100%', height: phoneHeight }}>
        <ResponsiveContainer>
          <BarChart data={phoneRows} layout="vertical" margin={{ left: 4, right: 16 }} barGap={2}>
            <CartesianGrid horizontal={false} stroke="#e6e9e3" />
            <XAxis
              type="number"
              tickFormatter={(v) => `$${v}`}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#8b948c', fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="category"
              width={110}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#5f6b64', fontSize: 12 }}
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
            <Bar dataKey="previous" name={previousLabel} fill={CHART_SERIES.comparison} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />
            <Bar dataKey="current" name={currentLabel} fill={CHART_SERIES.primary} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {other && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 text-sm font-medium text-emerald hover:text-emerald-600 md:hidden"
        >
          {expanded ? 'Show fewer' : `Show all ${data.length} categories`}
        </button>
      )}

      {/* Unchanged from before this stage apart from the series colour (§5.1). The rotated labels
          stay here: at desktop width they have the room they never had on a phone. */}
      <div className="hidden md:block" style={{ width: '100%', height: 340 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ left: 20, right: 20, bottom: 60 }} barGap={4}>
            <CartesianGrid vertical={false} stroke="#e6e9e3" />
            <XAxis
              dataKey="category"
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
            <Bar dataKey="previous" name={previousLabel} fill={CHART_SERIES.comparison} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            <Bar dataKey="current" name={currentLabel} fill={CHART_SERIES.primary} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}
