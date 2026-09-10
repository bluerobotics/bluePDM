import { memo, useMemo, useState } from 'react'
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'

import { ChartFrame } from '../components/ChartFrame'
import { TooltipCard, TooltipRow } from '../components/TooltipCard'
import type { RosterRow } from '../hooks/useCustomerRoster'
import { useChartTheme } from '../lib/chartTheme'
import {
  formatAmount,
  formatCompact,
  formatCount,
  formatDate,
  formatRelativeDays,
  MONEY_NOTE,
} from '../lib/format'
import type { AccountRollup } from '../lib/rollup'
import {
  AT_RISK_AFTER_DAYS,
  CHURNED_AFTER_DAYS,
  isSegmentId,
  SEGMENT_IDS,
  SEGMENTS,
  segmentMeta,
} from '../lib/segments'

type Account = AccountRollup<RosterRow>

interface RfmScatterChartProps {
  /**
   * Companies, not contacts. The roll-up is what the customer table renders, so
   * plotting anything else would put a contact's name next to their employer's
   * money - the sync credits every order to the commercial partner.
   */
  accounts: Account[]
  loading: boolean
  onSelect: (account: Account) => void
  /** Active segment facet, so the legend can show what is being filtered on. */
  selectedSegments: string[]
  onToggleSegment: (segment: string) => void
}

/** What bubble area encodes. */
type SizeMetric = 'order' | 'total'

const SIZE_METRIC_IDS = ['order', 'total'] as const

const SIZE_METRICS: Record<
  SizeMetric,
  { toggle: string; description: string; areaLabel: string; areaPhrase: string }
> = {
  order: {
    toggle: 'Order size',
    description: 'Size bubbles by spend divided by orders - what a typical order from them is worth',
    areaLabel: 'Area: typical order',
    areaPhrase: 'area is a typical order',
  },
  total: {
    toggle: 'Total spend',
    description: 'Size bubbles by everything they spent inside the selected range',
    areaLabel: 'Area: range spend',
    areaPhrase: 'area is total spend in the range',
  },
}

/**
 * Most bubbles the chart will draw.
 *
 * Every point is an SVG symbol, and 900 of them is already about what a 300px
 * plot can separate - at the radii below they overplot into a solid mass well
 * before then. Rolling contacts up into companies cuts the count a long way,
 * but a large Odoo still has thousands of accounts.
 */
const MAX_POINTS = 900

/**
 * Biggest bubbles always survive the downsample. They are the ones worth
 * clicking, so losing one is the only omission a reader would actually notice.
 */
const KEEP_LARGEST = 200

/**
 * Bubble area in px², smallest to largest. Recharts treats the z range as an
 * area (`sizeType` defaults to 'area'), so value maps to area rather than to
 * radius and a bubble twice as wide really is worth four times as much.
 */
const SIZE_RANGE: [number, number] = [20, 460]

/**
 * Where the size scale tops out.
 *
 * Spend is heavily skewed, and scaling to the maximum meant one outsized
 * account took the whole range while everybody else sat on the floor at
 * indistinguishable minimum size. Anything above this percentile draws at max.
 */
const SIZE_CAP_PERCENTILE = 0.98

/** Reference bubbles in the size key, below the cap that closes it out. */
const SIZE_KEY_PERCENTILES = [0.25, 0.75]

/** Box the key's circles are centred in: the largest bubble the scale can draw. */
const SIZE_KEY_BOX = Math.ceil(2 * Math.sqrt(SIZE_RANGE[1] / Math.PI))

interface ScatterPoint {
  account: Account
  /** Days since their last order. */
  x: number
  /** Orders inside the range. */
  y: number
  /** The active size metric, clamped to the cap. */
  z: number
}

function sizeValue(account: Account, metric: SizeMetric): number {
  // Refunds can push a window negative, and a negative area is not a bubble.
  const spend = Math.max(account.totalSpent, 0)
  if (metric === 'total') return spend
  return account.orderCount > 0 ? spend / account.orderCount : 0
}

/** Nearest-rank percentile over an already ascending array. */
function percentileOf(ascending: number[], fraction: number): number {
  if (ascending.length === 0) return 0
  return ascending[Math.round(fraction * (ascending.length - 1))]
}

/** Keeps the size key honest when a tight distribution puts two marks together. */
function uniqueAscending(values: number[]): number[] {
  const unique: number[] = []
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value)
  }
  return unique
}

/** Radius the chart will draw for a value, so the size key can match it. */
function bubbleRadius(value: number, cap: number): number {
  const fraction = cap > 0 ? Math.min(Math.max(value, 0) / cap, 1) : 0
  const area = SIZE_RANGE[0] + fraction * (SIZE_RANGE[1] - SIZE_RANGE[0])
  return Math.sqrt(area / Math.PI)
}

/**
 * Bounds the plotted set while keeping its shape.
 *
 * Takes the largest bubbles, then walks the remainder at a fixed stride.
 * Because the remainder is ordered by size, the stride spreads the sample
 * evenly down the range instead of clipping its tail.
 */
function selectPoints(points: ScatterPoint[]): ScatterPoint[] {
  if (points.length <= MAX_POINTS) return points

  const bySize = [...points].sort((a, b) => b.z - a.z)
  const kept = bySize.slice(0, KEEP_LARGEST)

  const tail = bySize.slice(KEEP_LARGEST)
  const wanted = MAX_POINTS - KEEP_LARGEST
  // At least 1, so the indices below strictly increase and never repeat a row.
  const stride = tail.length / wanted

  for (let index = 0; index < wanted; index++) {
    kept.push(tail[Math.floor(index * stride)])
  }

  return kept
}

/** Segments a buyer can be in. A prospect has no order to plot. */
const PLOTTABLE_SEGMENTS = SEGMENT_IDS.filter((id) => id !== 'prospect')

/**
 * Recency against frequency, bubble area by order value.
 *
 * Plots only companies who bought inside the selected range. Everyone else sits
 * at zero orders with no recency to plot, so they would pile onto one axis and
 * squash the real distribution.
 *
 * Points are split into one series per lifecycle segment so each series can
 * carry a flat fill. Colouring a single series meant emitting a <Cell> element
 * per company, which for a large org is thousands of React nodes rebuilt on
 * every filter change; this is at most five regardless of org size.
 *
 * Memoized because the Overview re-renders on every filter and panel change,
 * and this is by far the most expensive chart on it to rebuild.
 */
export const RfmScatterChart = memo(function RfmScatterChart({
  accounts,
  loading,
  onSelect,
  selectedSegments,
  onToggleSegment,
}: RfmScatterChartProps) {
  const theme = useChartTheme()
  const [metric, setMetric] = useState<SizeMetric>('order')

  const series = useMemo(() => {
    const eligible: ScatterPoint[] = []
    const sizes: number[] = []

    for (const account of accounts) {
      if (account.recencyDays == null || account.orderCount <= 0) continue

      const value = sizeValue(account, metric)
      sizes.push(value)
      eligible.push({
        account,
        x: account.recencyDays,
        y: account.orderCount,
        z: value,
      })
    }

    sizes.sort((a, b) => a - b)
    const cap = percentileOf(sizes, SIZE_CAP_PERCENTILE)
    // A degenerate cap (everyone at zero, or a single point) would divide by
    // zero in the scale; falling back to 1 draws every bubble at minimum.
    const sizeCap = cap > 0 ? cap : 1

    for (const point of eligible) point.z = Math.min(point.z, sizeCap)

    const plotted = selectPoints(eligible)

    const bySegment = new Map<string, ScatterPoint[]>()
    let maxRecency = 0
    for (const point of plotted) {
      maxRecency = Math.max(maxRecency, point.x)
      const bucket = bySegment.get(point.account.segment)
      if (bucket) bucket.push(point)
      else bySegment.set(point.account.segment, [point])
    }

    // Ordered by SEGMENT_IDS rather than by insertion so the draw order, and
    // therefore which bubbles end up on top, does not depend on the sort.
    const ordered: { id: string; points: ScatterPoint[] }[] = SEGMENT_IDS.filter((id) =>
      bySegment.has(id),
    ).map((id) => ({ id, points: bySegment.get(id) as ScatterPoint[] }))

    // A segment the SQL produced that this file does not know about would
    // otherwise vanish from the chart without a trace.
    for (const [id, points] of bySegment) {
      if (!isSegmentId(id)) ordered.push({ id, points })
    }

    // Largest first within a series, so small bubbles paint last and stay
    // hoverable instead of disappearing under the big ones.
    for (const entry of ordered) entry.points.sort((a, b) => b.z - a.z)

    // Every buyer segment, whether or not it is on screen: once a segment
    // filter is on, the roster only carries that segment, and a legend that
    // collapsed to the one chip would leave nothing to switch to.
    const legend = [
      ...PLOTTABLE_SEGMENTS,
      ...ordered.map((entry) => entry.id).filter((id) => !isSegmentId(id)),
    ].map((id) => ({ id, count: bySegment.get(id)?.length ?? 0 }))

    return {
      ordered,
      legend,
      sizeCap,
      capped: sizes.length > 0 && sizes[sizes.length - 1] > sizeCap,
      sizeKey: uniqueAscending([
        ...SIZE_KEY_PERCENTILES.map((fraction) => percentileOf(sizes, fraction)),
        sizeCap,
      ]),
      maxRecency,
      total: eligible.length,
      plotted: plotted.length,
    }
  }, [accounts, metric])

  const metricMeta = SIZE_METRICS[metric]

  const subtitle =
    series.plotted < series.total
      ? `Showing ${formatCount(series.plotted)} of ${formatCount(series.total)} companies - the largest always shown, the rest evenly sampled. Click a bubble to open.`
      : `Each bubble is a company: recency across, orders up, ${metricMeta.areaPhrase}. Click to open.`

  return (
    <ChartFrame
      title="Recency, frequency and value"
      subtitle={subtitle}
      height={330}
      loading={loading}
      empty={series.total === 0}
      emptyMessage="No companies with confirmed orders in this period"
      actions={
        <div className="flex items-center gap-0.5 p-0.5 rounded bg-plm-bg">
          {SIZE_METRIC_IDS.map((option) => (
            <button
              key={option}
              onClick={() => setMetric(option)}
              title={SIZE_METRICS[option].description}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                metric === option
                  ? 'bg-plm-bg-light text-plm-fg'
                  : 'text-plm-fg-muted hover:text-plm-fg'
              }`}
            >
              {SIZE_METRICS[option].toggle}
            </button>
          ))}
        </div>
      }
    >
      <div className="h-full flex flex-col">
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
              <CartesianGrid stroke={theme.border} strokeDasharray="3 3" />

              <XAxis
                type="number"
                dataKey="x"
                name="Days since last order"
                allowDecimals={false}
                tick={{ fill: theme.fgMuted, fontSize: 10 }}
                axisLine={{ stroke: theme.border }}
                tickLine={false}
                label={{
                  value: 'Days since last order',
                  position: 'insideBottom',
                  offset: -10,
                  fill: theme.fgMuted,
                  fontSize: 10,
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Orders in range"
                // Order counts are heavily skewed - a handful of companies with
                // 50+ orders would flatten everyone else onto the baseline.
                scale="log"
                domain={[1, 'auto']}
                allowDataOverflow
                tick={{ fill: theme.fgMuted, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={36}
              />
              <ZAxis type="number" dataKey="z" range={SIZE_RANGE} domain={[0, series.sizeCap]} />

              {/* Where the colours change, so the bands are readable without
                  hovering anything. */}
              {series.maxRecency >= AT_RISK_AFTER_DAYS && (
                <ReferenceLine
                  x={AT_RISK_AFTER_DAYS}
                  stroke={theme.borderLight}
                  strokeDasharray="4 4"
                  label={{
                    value: SEGMENTS.at_risk.label,
                    position: 'insideTopLeft',
                    fill: theme.fgMuted,
                    fontSize: 9,
                  }}
                />
              )}
              {series.maxRecency >= CHURNED_AFTER_DAYS && (
                <ReferenceLine
                  x={CHURNED_AFTER_DAYS}
                  stroke={theme.borderLight}
                  strokeDasharray="4 4"
                  label={{
                    value: SEGMENTS.churned.label,
                    position: 'insideTopLeft',
                    fill: theme.fgMuted,
                    fontSize: 9,
                  }}
                />
              )}

              <Tooltip
                cursor={{ strokeDasharray: '3 3', stroke: theme.borderLight }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const point = payload[0]?.payload as ScatterPoint | undefined
                  if (!point) return null

                  const { account } = point
                  const meta = segmentMeta(account.segment)
                  const contact = account.lead.name

                  return (
                    <TooltipCard title={account.name}>
                      {contact !== account.name && <TooltipRow label="Contact" value={contact} />}
                      {account.hasMembers && (
                        <TooltipRow label="Contacts" value={formatCount(account.members.length)} />
                      )}
                      <TooltipRow color={meta.color(theme)} label="Segment" value={meta.label} />
                      <TooltipRow
                        label="Last order"
                        value={`${formatDate(account.lastOrderDate)} (${formatRelativeDays(account.recencyDays)})`}
                      />
                      <TooltipRow label="Orders" value={formatCount(account.orderCount)} />
                      <TooltipRow label="Range spend" value={formatAmount(account.totalSpent)} />
                      <TooltipRow
                        label="Typical order"
                        value={formatAmount(account.totalSpent / account.orderCount)}
                      />
                      {account.categoryLabel && (
                        <TooltipRow label="Category" value={account.categoryLabel} />
                      )}
                    </TooltipCard>
                  )
                }}
              />

              {series.ordered.map(({ id, points }) => {
                const color = segmentMeta(id).color(theme)
                const dimmed = selectedSegments.length > 0 && !selectedSegments.includes(id)
                return (
                  <Scatter
                    key={id}
                    name={segmentMeta(id).label}
                    data={points}
                    fill={color}
                    fillOpacity={dimmed ? 0.2 : 0.55}
                    stroke={color}
                    strokeOpacity={dimmed ? 0.3 : 0.9}
                    isAnimationActive={false}
                    className="cursor-pointer"
                    // Object form merges over the symbol's own props, so the
                    // hovered bubble keeps its colour and gains a ring.
                    activeShape={{
                      fillOpacity: 0.9,
                      stroke: theme.fg,
                      strokeOpacity: 0.85,
                      strokeWidth: 1.5,
                    }}
                    onClick={(entry) => {
                      const point = entry?.payload as ScatterPoint | undefined
                      if (point) onSelect(point.account)
                    }}
                  />
                )
              })}
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        <div className="flex items-center justify-between gap-3 px-1 pt-1">
          <div className="flex items-center gap-0.5 flex-wrap">
            {series.legend.map(({ id, count }) => {
              const meta = segmentMeta(id)
              const dimmed = selectedSegments.length > 0 && !selectedSegments.includes(id)
              return (
                <button
                  key={id}
                  onClick={() => onToggleSegment(id)}
                  title={`${meta.description}. Click to filter the workspace.`}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-plm-bg ${
                    dimmed ? 'opacity-45' : ''
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: meta.color(theme) }}
                  />
                  <span className="text-[10px] text-plm-fg-dim">{meta.label}</span>
                  <span className="text-[10px] text-plm-fg-muted tabular-nums">
                    {formatCount(count)}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-1.5 shrink-0" title={MONEY_NOTE}>
            <span className="text-[10px] text-plm-fg-muted">{metricMeta.areaLabel}</span>
            {series.sizeKey.map((value, index) => {
              const isCap = index === series.sizeKey.length - 1
              return (
                <span key={value} className="flex items-center gap-1">
                  <svg width={SIZE_KEY_BOX} height={SIZE_KEY_BOX} className="shrink-0">
                    <circle
                      cx={SIZE_KEY_BOX / 2}
                      cy={SIZE_KEY_BOX / 2}
                      r={bubbleRadius(value, series.sizeCap)}
                      fill={theme.fgMuted}
                      fillOpacity={0.35}
                      stroke={theme.fgMuted}
                      strokeOpacity={0.7}
                    />
                  </svg>
                  <span className="text-[10px] text-plm-fg-muted tabular-nums">
                    {formatCompact(value)}
                    {isCap && series.capped ? '+' : ''}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </ChartFrame>
  )
})
