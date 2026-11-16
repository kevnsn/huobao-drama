/**
 * OpenRouter video generation — one key, many video models (Veo, Seedance, Kling, Wan, Hailuo…).
 * Submit: POST /api/v1/videos -> { id, polling_url, status }
 * Poll:   GET  /api/v1/videos/{id} -> { status, unsigned_urls, error }
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/video-generation
 *
 * Supported durations, resolutions and aspect ratios differ per model (GET /api/v1/videos/models);
 * values are passed through and OpenRouter rejects unsupported combinations with a readable error.
 * Reference audio/video are not part of this API and are ignored.
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

const DEFAULT_MODEL = 'google/veo-3.1-fast'

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

function firstUrl(list: any): string | null {
  const first = Array.isArray(list) ? list[0] : null
  return typeof first === 'string' ? first : first?.url || null
}

function errorText(err: any): string {
  if (!err) return 'Video generation failed'
  return typeof err === 'string' ? err : err.message || JSON.stringify(err)
}

export class OpenRouterVideoAdapter implements VideoProviderAdapter {
  provider = 'openrouter'

  private headers(config: AIConfig, withJson = false): Record<string, string> {
    return {
      ...(withJson ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${config.apiKey}`,
    }
  }

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('OpenRouter video generation requires a prompt')

    const body: any = { model: record.model || config.model || DEFAULT_MODEL, prompt }
    if (record.duration) body.duration = Math.round(Number(record.duration))
    if (record.resolution) body.resolution = record.resolution
    if (record.aspectRatio) body.aspect_ratio = record.aspectRatio
    if (record.generateAudio != null) body.generate_audio = Boolean(record.generateAudio)
    if (record.seed != null) body.seed = record.seed

    // Exact frames win over loose references (OpenRouter applies the same precedence)
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = (record.lastFrameUrl || '').trim()
    const frames = [
      ...(firstFrame ? [{ type: 'image_url', image_url: { url: firstFrame }, frame_type: 'first_frame' }] : []),
      ...(lastFrame ? [{ type: 'image_url', image_url: { url: lastFrame }, frame_type: 'last_frame' }] : []),
    ]
    const references = parseUrlArray(record.referenceImageUrls)
    if (frames.length) body.frame_images = frames
    else if (references.length) {
      body.input_references = references.map(url => ({ type: 'image_url', image_url: { url } }))
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/api/v1', '/videos'),
      method: 'POST',
      headers: this.headers(config, true),
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result?.id) return { isAsync: true, taskId: String(result.id) }
    throw new Error(`OpenRouter did not return a job id: ${errorText(result?.error)}`)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v1', `/videos/${taskId}`),
      method: 'GET',
      headers: this.headers(config),
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    if (result.status === 'completed') {
      const videoUrl = this.extractVideoUrl(result)
      return videoUrl
        ? { status: 'completed', videoUrl }
        : { status: 'failed', error: 'OpenRouter reported completion without a video URL' }
    }
    if (['failed', 'cancelled', 'expired'].includes(result.status)) {
      return { status: 'failed', error: errorText(result.error || result.status) }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return firstUrl(result.urls) || firstUrl(result.unsigned_urls)
  }

  /** unsigned_urls are served by OpenRouter itself and need the API key; signed/CDN URLs must not get it */
  downloadHeaders(config: AIConfig, videoUrl: string): Record<string, string> | undefined {
    try {
      const host = new URL(videoUrl).hostname
      const apiHost = new URL(joinProviderUrl(config.baseUrl, '/api/v1', '/videos')).hostname
      return host === apiHost ? this.headers(config) : undefined
    } catch {
      return undefined
    }
  }
}
