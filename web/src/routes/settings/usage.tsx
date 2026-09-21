import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageSummaryBucket, UsageSpeedResponse } from '@hapi/protocol/apiTypes'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

type UsageRange = '7d' | '30d' | 'all'

function formatTokens(value: number): string {
    if (value < 1000) return value.toLocaleString()
    if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
    if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
    return `${(value / 1_000_000_000).toFixed(1)}B`
}

function UsageBarList(props: { rows: UsageSummaryBucket[]; empty: string }) {
    const { t } = useTranslation()
    const max = props.rows[0]?.totalTokens ?? 0
    if (props.rows.length === 0) return <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{props.empty}</div>
    return (
        <div className="divide-y divide-[var(--app-divider)]">
            {props.rows.slice(0, 8).map((row) => (
                <div key={row.key} className="px-3 py-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate font-medium text-[var(--app-fg)]">{row.key}</span>
                        <span className="shrink-0 text-[var(--app-hint)]">{formatTokens(row.totalTokens)}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                        <div className="h-full rounded-full bg-[var(--app-link)]" style={{ width: `${max > 0 ? Math.max(2, (row.totalTokens / max) * 100) : 0}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-[var(--app-hint)]">
                        {t('settings.usage.bucketDetails', {
                            requests: row.requests.toLocaleString(),
                            input: formatTokens(row.inputTokens),
                            output: formatTokens(row.outputTokens)
                        })}
                    </div>
                </div>
            ))}
        </div>
    )
}

function formatSpeed(value: number): string {
    return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

function DailyProfileChart(props: {
    profile: {
        history: Array<{ hour: number; tokensPerSec: number; outputTokens: number }>
        today: Array<{ hour: number; tokensPerSec: number; outputTokens: number }>
    }
}) {
    const { t } = useTranslation()
    const historyBySlot = new Map(props.profile.history.map((p) => [p.hour, p]))
    const todayBySlot = new Map(props.profile.today.map((p) => [p.hour, p]))
    const allValues = [
        ...Array.from(historyBySlot.values()).map((p) => p.tokensPerSec),
        ...Array.from(todayBySlot.values()).map((p) => p.tokensPerSec)
    ]
    const maxSpeed = Math.max(...allValues, 1)
    const SLOTS = 96
    const CHART_H = 56 // svg user units; keep in sync with h-14 below
    const slotLabel = (slot: number) =>
        `${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`
    const x = (slot: number) => (slot + 0.5) * (100 / SLOTS)
    const yFor = (v: number) => Math.max(1, (v / maxSpeed) * CHART_H)

    // Break today's polyline at gaps so we never draw a long straight line
    // across unused hours.
    const presentSlots = Array.from(todayBySlot.keys()).sort((a, b) => a - b)
    const runs: number[][] = []
    for (const slot of presentSlots) {
        const last = runs[runs.length - 1]
        if (last && slot - last[last.length - 1] <= 2) last.push(slot)
        else runs.push([slot])
    }

    const now = new Date()
    const currentX = x(now.getHours() * 4 + Math.floor(now.getMinutes() / 15))

    return (
        <div className="mt-3">
            <div className="flex items-stretch gap-2">
                {/* chart */}
                <div className="relative h-14 flex-1">
                    {/* grid: baseline + 6-hour ticks */}
                    {[0, 24, 48, 72].map((slot) => (
                        <div key={`grid-${slot}`} className="absolute top-0 bottom-0 w-px bg-[var(--app-divider)] opacity-40" style={{ left: `${x(slot)}%` }} />
                    ))}
                    <div className="absolute inset-x-0 bottom-0 h-px bg-[var(--app-divider)]" />
                    {/* history bars (gray) */}
                    <div className="absolute inset-0 flex items-end gap-[1px]">
                        {Array.from({ length: SLOTS }, (_, slot) => {
                            const hist = historyBySlot.get(slot)
                            const h = hist ? (hist.tokensPerSec / maxSpeed) * 100 : 0
                            return (
                                <div
                                    key={slot}
                                    className="min-w-[2px] flex-1"
                                    style={{ height: `${h}%`, backgroundColor: 'var(--app-hint)', opacity: hist ? 0.35 : 0, borderRadius: '1px 1px 0 0' }}
                                />
                            )
                        })}
                    </div>
                    {/* today line (colored), broken at gaps */}
                    <svg viewBox={`0 0 100 ${CHART_H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                        {runs.map((run, i) =>
                            run.length > 1 ? (
                                <polyline
                                    key={`run-${i}`}
                                    points={run.map((slot) => `${x(slot)},${CHART_H - yFor(todayBySlot.get(slot)!.tokensPerSec)}`).join(' ')}
                                    fill="none"
                                    stroke="var(--app-link)"
                                    strokeWidth="1.6"
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                    vectorEffect="non-scaling-stroke"
                                />
                            ) : null
                        )}
                        {runs.flat().map((slot) => (
                            <circle
                                key={`dot-${slot}`}
                                cx={x(slot)}
                                cy={CHART_H - yFor(todayBySlot.get(slot)!.tokensPerSec)}
                                r="1.7"
                                fill="var(--app-link)"
                                vectorEffect="non-scaling-stroke"
                            />
                        ))}
                    </svg>
                    {/* current time marker */}
                    <div className="absolute top-0 bottom-0 w-px bg-[var(--app-link)] opacity-30" style={{ left: `${currentX}%` }} />
                    {/* hover targets */}
                    <div className="absolute inset-0 flex gap-[1px]">
                        {Array.from({ length: SLOTS }, (_, slot) => {
                            const hist = historyBySlot.get(slot)
                            const today = todayBySlot.get(slot)
                            return (
                                <div
                                    key={`hit-${slot}`}
                                    className="min-w-[2px] flex-1"
                                    title={t('settings.usage.speed.profileTooltip', {
                                        time: slotLabel(slot),
                                        hist: hist ? formatSpeed(hist.tokensPerSec) : '0',
                                        today: today ? formatSpeed(today.tokensPerSec) : '0'
                                    })}
                                />
                            )
                        })}
                    </div>
                </div>
                {/* y axis labels */}
                <div className="flex w-12 flex-col justify-between text-right text-[10px] leading-none text-[var(--app-hint)]">
                    <span>{formatSpeed(maxSpeed)}</span>
                    <span>0</span>
                </div>
            </div>
            {/* x axis labels */}
            <div className="mt-1 flex justify-between pl-0 pr-14 text-[10px] text-[var(--app-hint)]">
                <span>00:00</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>24:00</span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-[var(--app-hint)]">
                <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--app-hint)] opacity-35" />
                    {t('settings.usage.speed.legendHistory')}
                </span>
                <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-0 w-3 border-t-2 border-[var(--app-link)]" />
                    {t('settings.usage.speed.legendToday')}
                </span>
            </div>
        </div>
    )
}

function UsageSpeedSection(props: { range: UsageRange }) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const query = useQuery({
        queryKey: queryKeys.usageSpeed(props.range),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getUsageSpeed(props.range)
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: false
    })

    if (query.isLoading) {
        return (
            <SettingsSection title={t('settings.usage.speed.title')}>
                <SettingsRow label={t('settings.usage.speed.loading')} />
            </SettingsSection>
        )
    }
    if (query.error || !query.data) {
        return (
            <SettingsSection title={t('settings.usage.speed.title')}>
                <SettingsRow label={t('settings.usage.speed.error')} description={query.error instanceof Error ? query.error.message : undefined} />
            </SettingsSection>
        )
    }
    const data: UsageSpeedResponse = query.data
    if (data.byModel.length === 0) {
        return (
            <SettingsSection title={t('settings.usage.speed.title')} description={t('settings.usage.speed.description')}>
                <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{t('settings.usage.speed.empty')}</div>
            </SettingsSection>
        )
    }
    const formatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
    void formatter
    return (
        <SettingsSection title={t('settings.usage.speed.title')} description={t('settings.usage.speed.description')}>
            <div className="divide-y divide-[var(--app-divider)]">
                {data.byModel.map((stat) => {
                    const profile = data.dailyProfiles?.find((p) => p.model === stat.model)
                    return (
                        <div key={stat.model} className="px-3 py-3">
                            <div className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0 truncate font-medium text-[var(--app-fg)]">{stat.model}</span>
                                <span className="shrink-0 font-semibold text-[var(--app-link)]">{formatSpeed(stat.meanTokensPerSec)} tok/s</span>
                            </div>
                            <div className="mt-1 flex items-center gap-3 text-xs text-[var(--app-hint)]">
                                <span>{t('settings.usage.speed.median', { value: formatSpeed(stat.medianTokensPerSec) })}</span>
                                <span>{t('settings.usage.speed.p90', { value: formatSpeed(stat.p90TokensPerSec) })}</span>
                                <span>{t('settings.usage.speed.samples', { count: stat.samples.toLocaleString() })}</span>
                            </div>
                            {profile && (profile.history.length > 0 || profile.today.length > 0) ? (
                                <DailyProfileChart profile={profile} />
                            ) : null}
                                                    </div>
                    )
                })}
            </div>
            <div className="px-3 pt-2 text-xs text-[var(--app-hint)]">{t('settings.usage.speed.note')}</div>
        </SettingsSection>
    )
}

export default function SettingsUsagePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const [range, setRange] = useState<UsageRange>('7d')
    const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    const query = useQuery({
        queryKey: queryKeys.usageSummary(range, timeZone),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getUsageSummary(range, timeZone)
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: false
    })
    const maxDaily = useMemo(() => Math.max(...(query.data?.daily.map((row) => row.totalTokens) ?? [0]), 1), [query.data?.daily])
    const cacheHitRate = query.data && query.data.totals.inputTokens > 0
        ? `${((query.data.totals.cacheReadTokens / query.data.totals.inputTokens) * 100).toFixed(1)}%`
        : '0%'

    return (
        <SettingsPageContent description={t('settings.usage.description')}>
            <div className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border)]" role="radiogroup" aria-label={t('settings.usage.range.label')}>
                {(['7d', '30d', 'all'] as const).map((option) => (
                    <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={range === option}
                        onClick={() => setRange(option)}
                        className={`border-r border-[var(--app-border)] px-3 py-2 text-sm font-medium transition-colors last:border-r-0 ${range === option ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                    >
                        {t(`settings.usage.range.${option}`)}
                    </button>
                ))}
            </div>

            {query.isLoading ? <SettingsSection><SettingsRow label={t('settings.usage.loading')} /></SettingsSection> : null}
            {query.error ? <SettingsSection><SettingsRow label={t('settings.usage.error')} description={query.error instanceof Error ? query.error.message : undefined} /></SettingsSection> : null}
            {query.data ? (
                <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[
                            ['settings.usage.total', query.data.totals.totalTokens],
                            ['settings.usage.uncached', query.data.totals.uncachedTokens],
                            ['settings.usage.input', query.data.totals.inputTokens],
                            ['settings.usage.output', query.data.totals.outputTokens],
                            ['settings.usage.cacheRead', query.data.totals.cacheReadTokens],
                            ['settings.usage.cacheCreation', query.data.totals.cacheCreationTokens],
                            ['settings.usage.cacheHitRate', cacheHitRate],
                            ['settings.usage.requests', query.data.totals.requests]
                        ].map(([label, value]) => (
                            <div key={label} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 shadow-sm">
                                <div className="text-xs text-[var(--app-hint)]">{t(label as string)}</div>
                                <div className="mt-1 text-xl font-semibold text-[var(--app-fg)]">{typeof value === 'number' ? formatTokens(value) : value}</div>
                            </div>
                        ))}
                    </div>
                    <SettingsSection title={t('settings.usage.daily.title')}>
                        {query.data.daily.length === 0 ? <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{t('settings.usage.empty')}</div> : (
                            <div className="space-y-3 px-3 py-4">
                                {query.data.daily.map((row) => (
                                    <div key={row.key} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs">
                                        <span className="text-[var(--app-hint)]">{row.key}</span>
                                        <div className="h-2 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"><div className="h-full rounded-full bg-[var(--app-link)]" style={{ width: `${Math.max(2, (row.totalTokens / maxDaily) * 100)}%` }} /></div>
                                        <span className="text-right font-medium text-[var(--app-fg)]">{formatTokens(row.totalTokens)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </SettingsSection>
                    <div className="grid gap-5 md:grid-cols-2">
                        <SettingsSection title={t('settings.usage.agent.title')}>
                            <UsageBarList rows={query.data.byAgent} empty={t('settings.usage.empty')} />
                        </SettingsSection>
                        <SettingsSection title={t('settings.usage.model.title')}>
                            <UsageBarList rows={query.data.byModel} empty={t('settings.usage.empty')} />
                        </SettingsSection>
                    </div>
                    <UsageSpeedSection range={range} />
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('settings.usage.sessions', { count: query.data.totals.sessions })}
                    </div>
                </>
            ) : null}
        </SettingsPageContent>
    )
}
