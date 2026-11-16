/**
 * Codex subscription image generation.
 *
 * There is no images endpoint on the ChatGPT-hosted Codex backend. Instead a chat model is asked
 * to call the built-in `image_generation` tool, and the picture comes back base64-encoded on the
 * tool-call item. So the configured "model" is the chat model that drives the tool — the image
 * model itself is chosen by ChatGPT. Auth and streaming are handled by codexFetch.
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { CODEX_BASE_URL, codexFetch } from '../codex-auth.js'

const INSTRUCTIONS = [
  'You are an image generation relay.',
  "Call the image_generation tool exactly once, using the user's text verbatim as the image prompt — do not rewrite, shorten or embellish it.",
  'If images are attached, treat them as visual references and keep characters, props and scenes consistent with them.',
  'Do not reply with any text.',
].join(' ')

function parseRefs(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

/** The tool only offers square, landscape and portrait canvases */
function toolSize(size?: string | null): string {
  const [w, h] = String(size || '').toLowerCase().split('x').map(Number)
  if (!w || !h || w === h) return '1024x1024'
  return w > h ? '1536x1024' : '1024x1536'
}

function findImage(result: any): string | null {
  const item = (result?.output || []).find((o: any) => o?.type === 'image_generation_call' && o.result)
  return item?.result || null
}

export class CodexImageAdapter implements ImageProviderAdapter {
  provider = 'codex'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    return {
      url: `${config.baseUrl || CODEX_BASE_URL}/responses`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: record.model || config.model || 'gpt-5.6-terra',
        instructions: INSTRUCTIONS,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: record.prompt || '' },
            ...parseRefs(record.referenceImages).map(url => ({ type: 'input_image', image_url: url })),
          ],
        }],
        tools: [{ type: 'image_generation', size: toolSize(record.size), output_format: 'png' }],
        tool_choice: { type: 'image_generation' },
      },
      fetch: codexFetch,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (!findImage(result)) {
      throw new Error('Codex returned no image. Your ChatGPT plan may not include image generation, or the request was refused')
    }
    return { isAsync: false }
  }

  buildPollRequest(): ProviderRequest {
    throw new Error('Codex image generation is synchronous')
  }

  parsePollResponse(): ImagePollResponse {
    return { status: 'failed', error: 'Codex image generation is synchronous' }
  }

  extractImageUrl(): string | null {
    return null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const data = findImage(result)
    return data ? { data, mimeType: 'image/png' } : null
  }
}
