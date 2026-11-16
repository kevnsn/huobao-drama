/**
 * Per-model limits for OpenRouter video models (allowed durations and resolutions).
 * Source: GET /api/v1/videos/models — public, no key needed. Cached for an hour.
 */
import { joinProviderUrl } from './adapters/url.js'

export interface VideoModelLimits {
  durations: number[]
  resolutions: string[]
}

const TTL_MS = 60 * 60 * 1000
const TIERS = ['480p', '720p', '1080p']
let cache: { at: number; models: Record<string, VideoModelLimits> } | null = null

export async function getOpenRouterVideoModels(baseUrl = 'https://openrouter.ai'): Promise<Record<string, VideoModelLimits>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models
  try {
    const resp = await fetch(joinProviderUrl(baseUrl, '/api/v1', '/videos/models'), { signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const { data } = await resp.json() as { data: any[] }
    const models: Record<string, VideoModelLimits> = {}
    for (const m of data || []) {
      models[m.id] = {
        durations: [...(m.supported_durations || [])].sort((a, b) => a - b),
        resolutions: m.supported_resolutions || [],
      }
    }
    cache = { at: Date.now(), models }
    return models
  } catch {
    // Limits are a convenience: without them the request goes out as asked
    return cache?.models || {}
  }
}

/** Snap a shot's duration and resolution to the closest values the model accepts. */
export function fitToModel(limits: VideoModelLimits | undefined, duration?: number | null, resolution?: string | null) {
  let fitDuration = duration
  let fitResolution = resolution
  if (limits?.durations.length && duration != null) {
    fitDuration = limits.durations.reduce((best, d) => Math.abs(d - duration) < Math.abs(best - duration) ? d : best)
  }
  const tiers = TIERS.filter(t => limits?.resolutions.includes(t))
  if (tiers.length && resolution && !tiers.includes(resolution)) {
    const want = TIERS.indexOf(resolution)
    fitResolution = tiers.reduce((best, t) => Math.abs(TIERS.indexOf(t) - want) < Math.abs(TIERS.indexOf(best) - want) ? t : best)
  }
  return { duration: fitDuration, resolution: fitResolution }
}
