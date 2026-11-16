import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { STORAGE_ROOT } from '../utils/paths.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'

const MAX_BYTES = 15 * 1024 * 1024
const INLINE_PROVIDERS = new Set(['volcengine', 'minimax', 'openrouter', 'anyfast'])

function localAudioPath(url: string): string | null {
  if (!/^\/?static\//.test(url)) return null
  const file = path.resolve(STORAGE_ROOT, url.replace(/^\/?static\//, ''))
  if (!file.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) throw new Error('Invalid local voice path')
  return file
}

function publicAudioUrl(url: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) {
    throw new Error('The current video model requires a public voice URL. Set PUBLIC_BASE_URL on the backend, or switch to Seedance 2.0 / MiniMax H3, which support local voices.')
  }
  return `${base}/${url.replace(/^\//, '')}`
}

/** Validate before creating a paid task. M4A/AAC samples are converted without trimming the voice. */
export async function prepareReferenceAudio(refs: string[] | undefined, provider: string): Promise<string[]> {
  const urls = [...new Set((refs || []).map(url => url.trim()).filter(Boolean))]
  const minSeconds = provider === 'aliyun' ? 1 : 2
  let durationSum = 0
  const prepared: string[] = []
  for (const url of urls) {
    const file = localAudioPath(url)
    if (!file) { prepared.push(url); continue }
    if (!INLINE_PROVIDERS.has(provider)) publicAudioUrl(url)
    let size: number
    try { size = (await fs.stat(file)).size } catch { throw new Error('Character voice file not found. Please re-upload the voice') }
    const ext = path.extname(file).toLowerCase()
    if (!['.mp3', '.wav', '.m4a', '.aac'].includes(ext)) throw new Error('Reference voice only supports MP3, WAV, M4A or AAC')
    if (size > 20 * 1024 * 1024) throw new Error('Voice file is too large. Upload audio of 20MB or less')
    const suite = await checkFfmpegSuite()
    if (!suite.ffprobe) throw new Error('Voice validation requires FFprobe. Fix the backend FFprobe configuration and try again')
    const duration = await new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(file, (error, metadata) => {
        if (error || !metadata.streams.some(stream => stream.codec_type === 'audio')) {
          reject(new Error('Unable to read the voice file. Upload valid voice audio')); return
        }
        resolve(Number(metadata.format.duration))
      })
    })
    if (!Number.isFinite(duration) || duration < minSeconds || duration > 15) {
      throw new Error(`The current model requires each reference voice to be ${minSeconds}–15 seconds. Trim or re-upload it`)
    }
    durationSum += duration
    if (durationSum > 15.05) throw new Error('Total duration of referenced voices must not exceed 15 seconds. Reduce references or shorten the samples')
    if (ext === '.wav' || ext === '.mp3') {
      if (size > MAX_BYTES) throw new Error('The current model requires each reference voice to be 15MB or less. Compress or re-upload it')
      prepared.push(url.replace(/^\//, ''))
      continue
    }
    if (!suite.ffmpeg) throw new Error('M4A / AAC voices require FFmpeg conversion. Fix the configuration or upload WAV / MP3')
    const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex')
    const relative = `static/voice-references/${hash}.wav`
    const target = localAudioPath(relative)!
    await fs.mkdir(path.dirname(target), { recursive: true })
    try { await fs.access(target) } catch {
      const temporary = `${target}.${randomUUID()}.wav`
      try {
        await new Promise<void>((resolve, reject) => {
          ffmpeg(file).noVideo().audioChannels(1).audioFrequency(48000).audioCodec('pcm_s16le')
            .format('wav').on('end', () => resolve()).on('error', () => reject(new Error('Voice conversion failed. Use a WAV / MP3 file instead'))).save(temporary)
        })
        await fs.rename(temporary, target)
      } finally { await fs.rm(temporary, { force: true }) }
    }
    prepared.push(relative)
  }
  return prepared
}

/** Seedance 2.0 / MiniMax H3 accept audio data URLs; Wan requires a public/OSS URL.
 * https://docs.volcengine.com/docs/ark/create-video-generation-task-api
 * https://platform.minimax.cn/docs/api-reference/video-generation-v2-create
 * https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference
 */
export async function resolveReferenceAudioUrls(refs: string[] | undefined, provider: string): Promise<string[]> {
  return Promise.all((refs || []).map(async url => {
    const file = localAudioPath(url)
    if (!file) return url
    if (!INLINE_PROVIDERS.has(provider)) return publicAudioUrl(url)
    const bytes = await fs.readFile(file)
    if (bytes.length > MAX_BYTES) throw new Error('Reference voice must not exceed 15MB')
    const format = path.extname(file).toLowerCase() === '.mp3' ? 'mp3' : 'wav'
    return `data:audio/${format};base64,${bytes.toString('base64')}`
  }))
}
