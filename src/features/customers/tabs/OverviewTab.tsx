import { useCallback } from 'react'

import { usePDMStore } from '@/stores/pdmStore'
import type { CustomerBucket } from '@/stores/types'

import { CategoryMixChart } from '../charts/CategoryMixChart'
import { ChannelMixChart } from '../charts/ChannelMixChart'
import { CohortHeatmap } from '../charts/CohortHeatmap'
import { GeoBarsChart } from '../charts/GeoBarsChart'
import { ParetoChart } from '../charts/ParetoChart'
import { RevenueTrendChart } from '../charts/RevenueTrendChart'
import { RfmScatterChart } from '../charts/RfmScatterChart'
import { TopProductsChart } from '../charts/TopProductsChart'
import { KpiStrip, PortfolioStrip } from '../components/KpiStrip'
import type { CustomerAnalyticsData } from '../data/types'
import { useChannelCounts } from '../hooks/useChannelCounts'
import type { RosterRow } from '../hooks/useCustomerRoster'
import type { AccountRollup } from '../lib/rollup'

interface OverviewTabProps {
  data: CustomerAnalyticsData
  /** Rolled up to companies, so the scatter agrees with the customer table. */
  accounts: AccountRollup<RosterRow>[]
  loading: boolean
  rosterLoading: boolean
  comparisonLabel: string
}

export function OverviewTab({
  data,
  accounts,
  loading,
  rosterLoading,
  comparisonLabel,
}: OverviewTabProps) {
  const filters = usePDMStore((s) => s.customerFilters)
  const setCustomerFilters = usePDMStore((s) => s.setCustomerFilters)
  const toggleCustomerFacet = usePDMStore((s) => s.toggleCustomerFacet)
  const setCustomerPanel = usePDMStore((s) => s.setCustomerPanel)

  const channelCounts = useChannelCounts()

  // Stable so the memoized scatter, the costliest chart here to rebuild, is
  // not re-rendered by every unrelated change on this tab. Opens the account's
  // lead row rather than an arbitrary contact, matching the Accounts tab.
  const openAccount = useCallback(
    (account: AccountRollup<RosterRow>) =>
      setCustomerPanel({ customerId: account.lead.customer_id, name: account.lead.name }),
    [setCustomerPanel],
  )

  const toggleSegment = useCallback(
    (segment: string) => toggleCustomerFacet('segments', segment),
    [toggleCustomerFacet],
  )

  return (
    <div className="space-y-3">
      <KpiStrip
        summary={data.summary}
        timeseries={data.timeseries}
        loading={loading}
        comparisonLabel={comparisonLabel}
      />

      <PortfolioStrip summary={data.summary} />

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
        <div className="2xl:col-span-2">
          <RevenueTrendChart
            data={data.timeseries}
            bucket={filters.bucket}
            onBucketChange={(bucket: CustomerBucket) => setCustomerFilters({ bucket })}
            loading={loading}
          />
        </div>

        <ChannelMixChart
          counts={channelCounts}
          selected={filters.channels}
          onSelect={(channel) => toggleCustomerFacet('channels', channel)}
        />

        <ParetoChart data={data.topAccounts} loading={loading} />

        <CategoryMixChart
          data={data.categories}
          loading={loading}
          selected={filters.categories}
          onSelect={(key) => toggleCustomerFacet('categories', key)}
        />

        <GeoBarsChart
          data={data.geo}
          loading={loading}
          selected={filters.countries}
          onSelect={(country) => toggleCustomerFacet('countries', country)}
        />

        <CohortHeatmap data={data.cohorts} loading={loading} />

        <RfmScatterChart
          accounts={accounts}
          loading={rosterLoading}
          onSelect={openAccount}
          selectedSegments={filters.segments}
          onToggleSegment={toggleSegment}
        />

        <TopProductsChart data={data.topProducts} loading={loading} />
      </div>
    </div>
  )
}
