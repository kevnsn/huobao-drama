/**
 * 阿里云百炼万相 Wan 3.0 视频生成 Adapter。
 *
 * 官方协议：
 * - POST /api/v1/services/aigc/video-generation/video-synthesis
 * - GET  /api/v1/tasks/{task_id}
 * - 仅支持 wan3.0-video-prime / wan3.0-video
 * - 请求体为 { model, input: { prompt, media }, parameters }
 * - 异步响应为 { output: { task_id, task_status }, request_id }
 */
import type {
  AIConfig,
  ProviderRequest,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'

const SUPPORTED_MODELS = new Set(['wan3.0-video-prime', 'wan3.0-video'])
const DEFAULT_MODEL = 'wan3.0-video'
const PROMPT_MAX_CHARS = 20_000
const MAX_SEED = 2_147_483_647
const REF_LIMITS = { images: 10, videos: 5, audios: 5, total: 20 } as const
const VALID_RATIOS = new Set(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'])
const VALID_RESOLUTIONS = new Set(['480P', '720P', '1080P'])

type WanMediaType =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'
  | 'file'
  | 'link'

interface WanMedia {
  type: WanMediaType
  url: string
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value
      .filter((url): url is string => typeof url === 'string')
      .map(url => url.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function cleanUrl(value?: string | null): string {
  return String(value || '').trim()
}

function validateMediaUrl(type: WanMediaType, url: string) {
  const isWebUrl = /^https?:\/\//i.test(url)
  const isOssUrl = /^oss:\/\//i.test(url)
  const isImageData = /^data:image\/(?:jpeg|jpg|png|bmp|webp);base64,/i.test(url)
  if (type === 'first_frame' || type === 'last_frame' || type === 'reference_image') {
    if (isWebUrl || isOssUrl || isImageData) return
    throw new Error(`Wan 3.0 ${type} requires an HTTP(S)/OSS image URL or an officially supported image Base64`)
  }
  if (type === 'link') {
    if (isWebUrl) return
    throw new Error('Wan 3.0 link only supports public HTTP(S) pages that do not require login')
  }
  if (isWebUrl || isOssUrl) return
  throw new Error(`Wan 3.0 ${type} only supports HTTP(S) or OSS URLs`)
}

function booleanValue(value: number | boolean | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback
  return value !== false && value !== 0
}

function errorMessage(result: any, fallback: string): string {
  const output = result?.output && typeof result.output === 'object' ? result.output : {}
  const code = output.code || result?.code
  const message = output.message || result?.message || fallback
  const requestId = result?.request_id
  return `${code ? `[${code}] ` : ''}${message}${requestId ? ` (request_id: ${requestId})` : ''}`
}

export class AliyunWanVideoAdapter implements VideoProviderAdapter {
  provider = 'aliyun'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = cleanUrl(record.model || config.model || DEFAULT_MODEL)
    if (!SUPPORTED_MODELS.has(model)) {
      throw new Error(`Wan 3.0 only supports wan3.0-video-prime or wan3.0-video, got: ${model}`)
    }

    // 官方对超过 20000 字符的部分自动截断；同时将项目内部 @图片N 标记转为官方的 图N 引用。
    const prompt = cleanUrl(record.prompt).replace(/@图片(\d+)/g, '图$1').slice(0, PROMPT_MAX_CHARS)

    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    const firstFrame = cleanUrl(record.firstFrameUrl || record.imageUrl)
    const lastFrame = cleanUrl(record.lastFrameUrl)
    const file = cleanUrl(record.referenceFileUrl)
    const link = cleanUrl(record.referenceLinkUrl)

    this.validateMedia({ refImages, refVideos, refAudios, firstFrame, lastFrame, file, link })

    const media: WanMedia[] = []
    if (firstFrame) media.push({ type: 'first_frame', url: firstFrame })
    if (lastFrame) media.push({ type: 'last_frame', url: lastFrame })
    for (const url of refImages) media.push({ type: 'reference_image', url })
    for (const url of refVideos) media.push({ type: 'reference_video', url })
    for (const url of refAudios) media.push({ type: 'reference_audio', url })
    if (file) media.push({ type: 'file', url: file })
    if (link) media.push({ type: 'link', url: link })
    for (const item of media) validateMediaUrl(item.type, item.url)

    if (!prompt && media.length === 0) {
      throw new Error('Wan 3.0 requires at least one of input.prompt and input.media')
    }

    const input: { prompt?: string; media?: WanMedia[] } = {}
    if (prompt) input.prompt = prompt
    if (media.length) input.media = media

    const parameters: Record<string, string | number | boolean> = {
      resolution: this.normalizeResolution(record.resolution),
      ratio: this.normalizeRatio(record.aspectRatio),
      duration: this.normalizeDuration(record.duration),
      audio: booleanValue(record.generateAudio, true),
      prompt_extend: booleanValue(record.promptExtend, true),
      watermark: booleanValue(record.watermark, false),
    }

    if (record.seed !== null && record.seed !== undefined) {
      const seed = Number(record.seed)
      if (!Number.isInteger(seed) || (seed !== -1 && (seed < 0 || seed > MAX_SEED))) {
        throw new Error(`Wan 3.0 seed must be -1 or an integer in 0~${MAX_SEED}`)
      }
      parameters.seed = seed
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: { model, input, parameters },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result?.output?.task_id
    if (taskId) return { isAsync: true, taskId: String(taskId) }
    throw new Error(errorMessage(result, 'Wan 3.0 response is missing output.task_id'))
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v1', `/tasks/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const output = result?.output && typeof result.output === 'object' ? result.output : {}
    switch (output.task_status) {
      case 'PENDING':
        return { status: 'pending' }
      case 'RUNNING':
        return { status: 'processing' }
      case 'SUCCEEDED':
        if (!output.video_url) {
          return { status: 'failed', error: errorMessage(result, 'Wan 3.0 task succeeded but the response is missing output.video_url') }
        }
        {
          const duration = Number(result?.usage?.output_video_duration ?? result?.usage?.duration)
          return {
            status: 'completed',
            videoUrl: output.video_url,
            ...(Number.isFinite(duration) ? { duration } : {}),
          }
        }
      case 'FAILED':
        return { status: 'failed', error: errorMessage(result, 'Wan 3.0 video generation failed') }
      case 'CANCELED':
        return { status: 'failed', error: errorMessage(result, 'Wan 3.0 task was canceled') }
      case 'UNKNOWN':
        return { status: 'failed', error: errorMessage(result, 'Wan 3.0 task not found or past the 24-hour query window') }
      default:
        if (result?.code || result?.message || output.code || output.message) {
          return { status: 'failed', error: errorMessage(result, 'Wan 3.0 task query failed') }
        }
        return { status: 'processing' }
    }
  }

  extractVideoUrl(result: any): string | null {
    return result?.output?.video_url || null
  }

  private validateMedia(input: {
    refImages: string[]
    refVideos: string[]
    refAudios: string[]
    firstFrame: string
    lastFrame: string
    file: string
    link: string
  }) {
    const { refImages, refVideos, refAudios, firstFrame, lastFrame, file, link } = input
    if (refImages.length > REF_LIMITS.images || refVideos.length > REF_LIMITS.videos || refAudios.length > REF_LIMITS.audios) {
      throw new Error(`Wan 3.0 reference limit exceeded: images ≤${REF_LIMITS.images}, videos ≤${REF_LIMITS.videos}, audios ≤${REF_LIMITS.audios}`)
    }
    if (lastFrame && !firstFrame) throw new Error('Wan 3.0 last frame must be provided together with the first frame')
    if (file && link) throw new Error('Wan 3.0 file and link cannot be provided together')

    const hasFrameMode = Boolean(firstFrame || lastFrame)
    const hasReferenceMode = Boolean(refImages.length || refVideos.length || refAudios.length || file || link)
    if (hasFrameMode && hasReferenceMode) {
      throw new Error('Wan 3.0 first_frame/last_frame cannot be combined with reference_image/reference_video/reference_audio/file/link')
    }

    const total = refImages.length + refVideos.length + refAudios.length + (firstFrame ? 1 : 0)
      + (lastFrame ? 1 : 0) + (file ? 1 : 0) + (link ? 1 : 0)
    if (total > REF_LIMITS.total) throw new Error(`Wan 3.0 input.media allows at most ${REF_LIMITS.total} items`)
  }

  private normalizeDuration(duration?: number | null): number {
    if (duration === null || duration === undefined) return 5
    const value = Number(duration)
    if (!Number.isInteger(value) || (value !== -1 && (value < 2 || value > 30))) {
      throw new Error('Wan 3.0 duration must be -1 or an integer in 2~30')
    }
    return value
  }

  private normalizeResolution(resolution?: string | null): string {
    const value = cleanUrl(resolution).toUpperCase() || '1080P'
    if (!VALID_RESOLUTIONS.has(value)) {
      throw new Error('Wan 3.0 resolution only supports 480P, 720P or 1080P')
    }
    return value
  }

  private normalizeRatio(ratio?: string | null): string {
    const value = cleanUrl(ratio) || 'adaptive'
    if (!VALID_RATIOS.has(value)) {
      throw new Error('Wan 3.0 ratio only supports adaptive, 16:9, 4:3, 1:1, 3:4 or 9:16')
    }
    return value
  }
}
