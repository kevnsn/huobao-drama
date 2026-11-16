/**
 * AnyFast video generation — Seedance 2.0 / 2.5 behind a Volcengine-style request,
 * Wan 3.0 behind Alibaba's model/input/parameters request. Same endpoints for both.
 * Submit: POST /v1/video/generations -> { id, status }
 * Poll:   GET  /v1/video/generations/{id} -> { data: { status, result_url, fail_reason } }
 * Docs: https://docs.anyfast.ai (model-api/bytedance/seedance-*)
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

const DEFAULT_MODEL = 'seedance-2.5'

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

function errorText(err: any): string {
  if (!err) return 'Video generation failed'
  return typeof err === 'string' ? err : err.message || JSON.stringify(err)
}

export class AnyFastVideoAdapter implements VideoProviderAdapter {
  provider = 'anyfast'

  private headers(config: AIConfig, withJson = false): Record<string, string> {
    return {
      ...(withJson ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${config.apiKey}`,
    }
  }

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    if (model.startsWith('wan')) return this.buildWanRequest(config, record, model)
    const prompt = (record.prompt || '').trim()
    const content: any[] = prompt ? [{ type: 'text', text: prompt }] : []

    // Exact frames and loose references are different task types upstream, so frames win
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = (record.lastFrameUrl || '').trim()
    if (firstFrame) {
      content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
      if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    } else {
      for (const url of parseUrlArray(record.referenceImageUrls)) {
        content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
      }
      for (const url of parseUrlArray(record.referenceVideoUrls)) {
        content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
      }
      for (const url of parseUrlArray(record.referenceAudioUrls)) {
        content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
      }
    }
    if (!content.length) throw new Error('AnyFast video generation requires a prompt or a reference')

    // Seedance 2.5 runs 4–30s, the 2.0 family 4–15s
    const maxDuration = model.includes('2.5') ? 30 : 15
    const duration = Math.min(maxDuration, Math.max(4, Math.round(Number(record.duration) || 5)))

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/video/generations'),
      method: 'POST',
      headers: this.headers(config, true),
      body: {
        model,
        content,
        generate_audio: record.generateAudio !== 0 && record.generateAudio !== false,
        // First-frame tasks only accept the adaptive ratio
        ratio: firstFrame ? 'adaptive' : record.aspectRatio || 'adaptive',
        duration,
        resolution: ['480p', '720p', '1080p'].includes(record.resolution || '') ? record.resolution : '720p',
        watermark: false,
      },
    }
  }

  /** Wan 3.0: media roles sit in input.media, frames and references cannot be mixed */
  private buildWanRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const prompt = (record.prompt || '').trim()
    const media: { type: string; url: string }[] = []
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = (record.lastFrameUrl || '').trim()
    if (firstFrame) {
      media.push({ type: 'first_frame', url: firstFrame })
      if (lastFrame) media.push({ type: 'last_frame', url: lastFrame })
    } else {
      for (const url of parseUrlArray(record.referenceImageUrls)) media.push({ type: 'reference_image', url })
      // Wan takes video and audio references as public URLs only
      for (const url of parseUrlArray(record.referenceVideoUrls)) {
        if (/^https?:/i.test(url)) media.push({ type: 'reference_video', url })
      }
      for (const url of parseUrlArray(record.referenceAudioUrls)) {
        if (/^https?:/i.test(url)) media.push({ type: 'reference_audio', url })
      }
    }
    if (!prompt && !media.length) throw new Error('AnyFast video generation requires a prompt or a reference')

    const resolution = ['480p', '720p', '1080p'].includes(record.resolution || '') ? record.resolution! : '720p'
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/video/generations'),
      method: 'POST',
      headers: this.headers(config, true),
      body: {
        model,
        input: { ...(prompt ? { prompt } : {}), ...(media.length ? { media } : {}) },
        parameters: {
          resolution: resolution.toUpperCase(),
          ratio: firstFrame ? 'adaptive' : record.aspectRatio || '16:9',
          duration: Math.min(30, Math.max(2, Math.round(Number(record.duration) || 5))),
          audio: record.generateAudio !== 0 && record.generateAudio !== false,
          watermark: false,
        },
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const id = result?.id || result?.task_id
    if (id) return { isAsync: true, taskId: String(id) }
    throw new Error(`AnyFast did not return a task id: ${errorText(result?.error || result?.message)}`)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/video/generations/${taskId}`),
      method: 'GET',
      headers: this.headers(config),
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const task = result?.data || {}
    if (task.status === 'SUCCESS') {
      const videoUrl = this.extractVideoUrl(result)
      return videoUrl
        ? { status: 'completed', videoUrl }
        : { status: 'failed', error: 'AnyFast reported success without a video URL' }
    }
    if (task.status === 'FAILURE') return { status: 'failed', error: errorText(task.fail_reason) }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const data = result?.data
    return data?.result_url || data?.data?.content?.video_url || data?.data?.output?.video_url || null
  }
}
