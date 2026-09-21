import type {
    UsageSpeedBucketPoint,
    UsageSpeedDailyProfile,
    UsageSpeedModelStat,
    UsageSpeedResponse,
    UsageSpeedSeries
} from '@hapi/protocol/apiTypes'
import type { UsageEvent } from '../store/usage'
import type { Store } from '../store'
import { collectUsageEvents, cumulativeSnapshotDelta, type UsageSnapshot } from './usageService'

/**
 * Token speed analytics (our-main feature).
 *
 * Both agents are normalized to per-request output deltas first:
 * - pi emits delta events natively (one per streaming segment).
 * - codex emits cumulative thread totals; we diff them with the same
 *   reset/last-fallback semantics as the usage summary.
 *
 * Speed model: consecutive requests of the same (sessionId, model) closer
 * than GAP_THRESHOLD_MS form one "generation span". Span output tokens
 * divided by span wall time yields one speed sample. Longer gaps are tool
 * execution or idle waiting and are excluded, so speeds reflect pure
 * generation throughput.
 */

const GAP_THRESHOLD_MS = 120_000
const BUCKET_MS = 15 * 60 * 1000
/** floor for a span duration so a single bursty delta cannot inflate speed */
const MIN_SPAN_MS = 1_000

type RequestDelta = {
    sessionId: string
    createdAt: number
    agent: string
    model: string
    outputTokens: number
}

export const SPEED_GAP_THRESHOLD_MS = GAP_THRESHOLD_MS
export const SPEED_BUCKET_MS = BUCKET_MS

function normalizeRequestDeltas(events: UsageEvent[], sessionIds: Set<string>): RequestDelta[] {
    const deltas: RequestDelta[] = []
    const cumulativePrevious = new Map<string, UsageSnapshot>()
    const cumulativeFingerprints = new Set<string>()
    const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt || a.sourceSeq - b.sourceSeq)
    for (const event of sorted) {
        if (!sessionIds.has(event.sessionId)) continue
        let outputTokens = event.outputTokens
        let skip = false
        if (event.kind === 'cumulative') {
            const sourceParts = event.sourceKey.split('|')
            const streamKey = sourceParts.slice(0, 3).join('|')
            const previous = cumulativePrevious.get(streamKey) ?? null
            const current: UsageSnapshot = [
                event.inputTokens,
                event.outputTokens,
                event.cacheReadTokens,
                event.cacheCreationTokens
            ]
            const last: UsageSnapshot | null = event.lastInputTokens !== null
                && event.lastOutputTokens !== null
                && event.lastCacheReadTokens !== null
                && event.lastCacheCreationTokens !== null
                ? [
                    event.lastInputTokens,
                    event.lastOutputTokens,
                    event.lastCacheReadTokens,
                    event.lastCacheCreationTokens
                ]
                : null
            const delta = cumulativeSnapshotDelta(current, previous, last)
            outputTokens = delta[1]
            cumulativePrevious.set(streamKey, current)
            const turnId = sourceParts[3]
            if (turnId) {
                const fingerprint = [
                    event.sessionId,
                    turnId,
                    event.inputTokens,
                    event.outputTokens,
                    event.cacheReadTokens,
                    event.cacheCreationTokens,
                    event.lastInputTokens,
                    event.lastOutputTokens,
                    event.lastCacheReadTokens,
                    event.lastCacheCreationTokens
                ].join('|')
                if (cumulativeFingerprints.has(fingerprint)) skip = true
                cumulativeFingerprints.add(fingerprint)
            }
        }
        if (skip || outputTokens <= 0) continue
        deltas.push({
            sessionId: event.sessionId,
            createdAt: event.createdAt,
            agent: event.agent,
            model: event.model ?? 'unknown',
            outputTokens
        })
    }
    return deltas
}

type SpeedSample = {
    model: string
    tokensPerSec: number
    outputTokens: number
    generationSeconds: number
    startedAt: number
    endedAt: number
}

function buildSpeedSamples(deltas: RequestDelta[]): SpeedSample[] {
    const samples: SpeedSample[] = []
    const streams = new Map<string, RequestDelta[]>()
    for (const delta of deltas) {
        const key = `${delta.sessionId}|${delta.model}`
        const list = streams.get(key)
        if (list) list.push(delta)
        else streams.set(key, [delta])
    }
    for (const list of streams.values()) {
        let spanStart = list[0].createdAt
        let spanEnd = list[0].createdAt
        let spanTokens = 0
        const flush = () => {
            const durationSec = Math.max((spanEnd - spanStart) / 1000, MIN_SPAN_MS / 1000)
            if (spanTokens > 0) {
                samples.push({
                    model: list[0].model,
                    tokensPerSec: spanTokens / durationSec,
                    outputTokens: spanTokens,
                    generationSeconds: durationSec,
                    startedAt: spanStart,
                    endedAt: spanEnd
                })
            }
        }
        for (const delta of list) {
            if (delta.createdAt - spanEnd > GAP_THRESHOLD_MS) {
                flush()
                spanStart = delta.createdAt
                spanTokens = 0
            }
            spanEnd = delta.createdAt
            spanTokens += delta.outputTokens
        }
        flush()
    }
    return samples
}

function percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0
    const index = Math.min(sortedValues.length - 1, Math.ceil(p * sortedValues.length) - 1)
    return sortedValues[Math.max(0, index)]
}

function createHourFormatter(timeZone: string): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    })
}

const PROFILE_SLOT_MS = 15 * 60 * 1000
const PROFILE_SLOTS = 96

/** Returns [dayKey, slot 0-95] for a timestamp in the given timeZone. */
function daySlotKey(timestamp: number, formatter: Intl.DateTimeFormat): { day: string; slot: number } {
    const parts = formatter.formatToParts(new Date(timestamp))
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
    const hourRaw = get('hour')
    const hour = Number.parseInt(hourRaw === '24' ? '0' : hourRaw, 10)
    const minute = Number.parseInt(get('minute'), 10) || 0
    const slot = (Number.isFinite(hour) ? hour : 0) * 4 + Math.floor(minute / 15)
    return { day: `${get('year')}-${get('month')}-${get('day')}`, slot: Math.min(PROFILE_SLOTS - 1, Math.max(0, slot)) }
}

function buildDailyProfiles(
    byModelMap: Map<string, SpeedSample[]>,
    timeZone: string
): Array<UsageSpeedDailyProfile> {
    const formatter = createHourFormatter(timeZone)
    const nowSlot = daySlotKey(Date.now(), formatter)
    const profiles: Array<UsageSpeedDailyProfile> = []
    for (const [model, list] of byModelMap) {
        // slot -> { tokens, seconds } split into history (full days) and today
        const history = new Map<number, { tokens: number; seconds: number }>()
        const today = new Map<number, { tokens: number; seconds: number }>()
        for (const sample of list) {
            // attribute the sample to the slot of its midpoint
            const { day, slot } = daySlotKey(Math.floor((sample.startedAt + sample.endedAt) / 2), formatter)
            const target = day === nowSlot.day ? today : history
            const entry = target.get(slot) ?? { tokens: 0, seconds: 0 }
            entry.tokens += sample.outputTokens
            entry.seconds += sample.generationSeconds
            target.set(slot, entry)
        }
        profiles.push({
            model,
            history: Array.from(history.entries())
                .map(([slot, e]) => ({ hour: slot, tokensPerSec: e.seconds > 0 ? e.tokens / e.seconds : 0, outputTokens: e.tokens }))
                .sort((a, b) => a.hour - b.hour),
            today: Array.from(today.entries())
                .map(([slot, e]) => ({ hour: slot, tokensPerSec: e.seconds > 0 ? e.tokens / e.seconds : 0, outputTokens: e.tokens }))
                .sort((a, b) => a.hour - b.hour),
            todayKey: nowSlot.day
        })
    }
    return profiles.sort((a, b) => {
        const aTok = a.history.reduce((s, p) => s + p.outputTokens, 0) + a.today.reduce((s, p) => s + p.outputTokens, 0)
        const bTok = b.history.reduce((s, p) => s + p.outputTokens, 0) + b.today.reduce((s, p) => s + p.outputTokens, 0)
        return bTok - aTok
    })
}

export function getUsageSpeed(
    store: Store,
    namespace: string,
    range: string | undefined,
    timeZone: string = 'UTC'
): UsageSpeedResponse {
    const sessions = store.sessions.getSessionsByNamespace(namespace)
    collectUsageEvents(store, sessions)
    const now = Date.now()
    const days = range === '30d' ? 30 : range === 'all' ? null : 7
    const from = days === null ? null : now - days * 24 * 60 * 60 * 1000
    const sessionIds = new Set(sessions.map((session) => session.id))
    const events = store.usage.getEvents(Array.from(sessionIds))
    const deltas = normalizeRequestDeltas(events, sessionIds).filter((delta) => {
        if (delta.outputTokens <= 0) return false
        if (from !== null && delta.createdAt < from) return false
        return delta.createdAt <= now
    })
    const samples = buildSpeedSamples(deltas)

    // per-model aggregate stats
    const byModelMap = new Map<string, SpeedSample[]>()
    for (const sample of samples) {
        const list = byModelMap.get(sample.model)
        if (list) list.push(sample)
        else byModelMap.set(sample.model, [sample])
    }
    const byModel: UsageSpeedModelStat[] = Array.from(byModelMap.entries()).map(([model, list]) => {
        const speeds = list.map((s) => s.tokensPerSec).sort((a, b) => a - b)
        const totalTokens = list.reduce((sum, s) => sum + s.outputTokens, 0)
        const totalSeconds = list.reduce((sum, s) => sum + s.generationSeconds, 0)
        return {
            model,
            meanTokensPerSec: totalSeconds > 0 ? totalTokens / totalSeconds : 0,
            medianTokensPerSec: percentile(speeds, 0.5),
            p90TokensPerSec: percentile(speeds, 0.9),
            samples: list.length,
            outputTokens: totalTokens,
            generationSeconds: totalSeconds
        }
    }).sort((a, b) => b.outputTokens - a.outputTokens)

    // 15-minute bucket series per model
    const series: UsageSpeedSeries[] = []
    for (const [model, list] of byModelMap) {
        const buckets = new Map<number, { tokens: number; seconds: number }>()
        for (const sample of list) {
            const bucket = Math.floor(sample.startedAt / BUCKET_MS) * BUCKET_MS
            const entry = buckets.get(bucket) ?? { tokens: 0, seconds: 0 }
            entry.tokens += sample.outputTokens
            entry.seconds += sample.generationSeconds
            buckets.set(bucket, entry)
        }
        const points: UsageSpeedBucketPoint[] = Array.from(buckets.entries())
            .map(([bucket, entry]) => ({
                bucket,
                tokensPerSec: entry.seconds > 0 ? entry.tokens / entry.seconds : 0,
                outputTokens: entry.tokens,
                generationSeconds: entry.seconds
            }))
            .sort((a, b) => a.bucket - b.bucket)
        series.push({ model, points })
    }
    series.sort((a, b) => b.points.reduce((s, p) => s + p.outputTokens, 0) - a.points.reduce((s, p) => s + p.outputTokens, 0))

    void timeZone // bucket grid is UTC epoch based; UI renders in local time
    return {
        range: { from, to: now },
        gapThresholdMs: GAP_THRESHOLD_MS,
        byModel,
        series,
        dailyProfiles: buildDailyProfiles(byModelMap, timeZone),
        updatedAt: now
    }
}
