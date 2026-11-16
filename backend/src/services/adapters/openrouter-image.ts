/**
 * OpenRouter image generation — POST /api/v1/images, synchronous, image returned as base64.
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 *
 * Mainly here for ByteDance Seedream: Seedance (video) rejects photorealistic people as reference
 * images unless the picture was made by ByteDance's own image model. The saved file must stay
 * byte-identical — the provenance metadata Seedream embeds is what Seedance checks.
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

const DEFAULT_MODEL = 'bytedance-seed/seedream-5-0-pro'
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

function parseRefs(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

/** "1920x1080" -> the closest ratio the images API accepts */
function aspectRatio(size?: string | null): string {
  const [w, h] = String(size || '').toLowerCase().split('x').map(Number)
  if (!w || !h) return '16:9'
  return RATIOS.reduce((best, ratio) => {
    const value = (r: string) => Number(r.split(':')[0]) / Number(r.split(':')[1])
    return Math.abs(value(ratio) - w / h) < Math.abs(value(best) - w / h) ? ratio : best
  })
}

export class OpenRouterImageAdapter implements ImageProviderAdapter {
  provider = 'openrouter'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const refs = parseRefs(record.referenceImages)
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v1', '/images'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: {
        model: record.model || config.model || DEFAULT_MODEL,
        prompt: record.prompt || '',
        aspect_ratio: aspectRatio(record.size),
        output_format: 'png',
        ...(refs.length ? { input_references: refs.map(url => ({ type: 'image_url', image_url: { url } })) } : {}),
      },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (!result?.data?.[0]?.b64_json) {
      throw new Error(`OpenRouter returned no image: ${result?.error?.message || 'unknown error'}`)
    }
    return { isAsync: false }
  }

  buildPollRequest(): ProviderRequest {
    throw new Error('OpenRouter image generation is synchronous')
  }

  parsePollResponse(): ImagePollResponse {
    return { status: 'failed', error: 'OpenRouter image generation is synchronous' }
  }

  extractImageUrl(): string | null {
    return null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const image = result?.data?.[0]
    return image?.b64_json ? { data: image.b64_json, mimeType: image.media_type || 'image/png' } : null
  }
}
