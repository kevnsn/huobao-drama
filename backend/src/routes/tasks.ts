import { Hono } from 'hono'
import { getOpenRouterVideoModels, fitToModel } from '../services/openrouter-video-models.js'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { generateImage, generateVideo, recoverVideoTask } from '../services/generation.js'
import { safeTaskError } from '../services/video-download.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { resolveStoryboardVoiceReferences } from '../services/character-voice-references.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { continuityPrompt, continuityReferences, generationOrderBlocker } from '../services/continuity.js'

const app = new Hono()

app.post('/:id/recover', async c => {
  try {
    await recoverVideoTask(Number(c.req.param('id')))
    return success(c, { id: Number(c.req.param('id')) })
  } catch (error) { return badRequest(c, safeTaskError(error)) }
})

app.get('/:id/diagnostics', async c => {
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(c.req.param('id'))))
  if (!task) return badRequest(c, 'Task not found')
  return success(c, { id: task.id, upstreamTaskId: task.taskId, provider: task.provider, model: task.model,
    status: task.status, stage: task.stage, errorCode: task.errorCode, error: safeTaskError(task.errorMsg),
    hasResult: !!task.resultUrl, hasLocalFile: !!task.localPath, createdAt: task.createdAt, updatedAt: task.updatedAt,
    version: process.env.HUOBAO_VERSION || 'development' })
})

type TaskType = 'image' | 'video'

const WAN_MEDIA_TYPES = new Set([
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
  'file',
  'link',
])

/**
 * 兼容项目原有扁平入参，也支持 Wan 3.0 官方 model/input/parameters 结构。
 */
function normalizeVideoRequest(body: any) {
  const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {}
  const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
    ? body.parameters
    : {}
  const media = Array.isArray(input.media) ? input.media : []

  const mediaUrls = (type: string) => media
    .filter((item: any) => item?.type === type)
    .map((item: any) => item?.url)

  return {
    ...body,
    prompt: body.prompt ?? input.prompt ?? '',
    reference_image_urls: body.reference_image_urls ?? mediaUrls('reference_image'),
    reference_video_urls: body.reference_video_urls ?? mediaUrls('reference_video'),
    reference_audio_urls: body.reference_audio_urls ?? mediaUrls('reference_audio'),
    first_frame_url: body.first_frame_url ?? mediaUrls('first_frame')[0],
    last_frame_url: body.last_frame_url ?? mediaUrls('last_frame')[0],
    file_url: body.file_url ?? mediaUrls('file')[0],
    link_url: body.link_url ?? mediaUrls('link')[0],
    generate_audio: body.generate_audio ?? parameters.audio,
    duration: body.duration ?? parameters.duration,
    aspect_ratio: body.aspect_ratio ?? parameters.ratio,
    resolution: body.resolution ?? parameters.resolution,
    seed: body.seed ?? parameters.seed,
    prompt_extend: body.prompt_extend ?? parameters.prompt_extend,
    watermark: body.watermark ?? parameters.watermark,
    official_media: media,
  }
}

function validateVideoRequest(body: any, provider?: string): string | null {
  for (const key of ['reference_image_urls', 'reference_video_urls', 'reference_audio_urls']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return `${key} must be an array`
    if (Array.isArray(body[key]) && body[key].some((url: any) => typeof url !== 'string' || !url.trim())) {
      return `Every URL in ${key} must be a non-empty string`
    }
  }

  if (body.official_media.length) {
    for (const item of body.official_media) {
      if (!item || typeof item !== 'object' || !WAN_MEDIA_TYPES.has(item.type) || typeof item.url !== 'string' || !item.url.trim()) {
        return 'Every item in input.media must include an officially supported type and a non-empty url'
      }
    }
    for (const type of ['first_frame', 'last_frame', 'file', 'link']) {
      if (body.official_media.filter((item: any) => item.type === type).length > 1) {
        return `Wan 3.0 input.media allows at most 1 ${type} item`
      }
    }
  }

  const imgs = body.reference_image_urls.length
  const vids = body.reference_video_urls.length
  const auds = body.reference_audio_urls.length
  const first = Boolean(body.first_frame_url)
  const last = Boolean(body.last_frame_url)
  const file = Boolean(body.file_url)
  const link = Boolean(body.link_url)

  if ((provider || '').toLowerCase() === 'aliyun') {
    if (imgs > 10 || vids > 5 || auds > 5) return 'Wan 3.0 reference limit exceeded: images ≤10, videos ≤5, audios ≤5'
    if (last && !first) return 'Wan 3.0 last frame must be provided together with the first frame'
    if (file && link) return 'Wan 3.0 file and link cannot be provided together'
    if ((first || last) && (imgs + vids + auds > 0 || file || link)) {
      return 'Wan 3.0 first_frame/last_frame cannot be combined with reference_image/reference_video/reference_audio/file/link'
    }
    const total = imgs + vids + auds + Number(first) + Number(last) + Number(file) + Number(link)
    if (total > 20) return 'Wan 3.0 input.media allows at most 20 items'
  } else {
    if (imgs > 9 || vids > 3 || auds > 3) return 'Reference limit exceeded: images ≤9, videos ≤3, audios ≤3'
    if (auds > 0 && imgs + vids === 0) return 'Reference audio requires at least 1 reference image or video'
  }

  if (!String(body.prompt || '').trim() && imgs + vids + auds === 0 && !first && !last && !file && !link) {
    return 'Video generation requires at least one reference asset or a prompt'
  }
  return null
}

// POST /tasks — 发起生成任务（body.type: image | video）
app.post('/', async (c) => {
  const body = await c.req.json()
  const type = body.type as TaskType
  if (type !== 'image' && type !== 'video') return badRequest(c, 'type must be image or video')

  if (type === 'image') {
    if (!body.prompt) return badRequest(c, 'Prompt is required')
  }

  const videoBody = type === 'video' ? normalizeVideoRequest(body) : null

  try {
    if (type === 'video' && body.storyboard_id) {
      const [latest] = await db.select().from(schema.sysTask).where(and(
        eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, Number(body.storyboard_id))
      )).orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') return badRequest(c, 'This shot already has a running task. Please wait for the result')
      if (latest?.status === 'failed' && body.force_new !== true) {
        return badRequest(c, 'Recover the original task first; regenerating must be explicitly confirmed as it may be billed again')
      }
    }
    // Shots chain from the previous one's last frame, so they are generated in order (continuity: false opts out)
    if (type === 'video' && body.storyboard_id && body.continuity !== false) {
      const blocked = await generationOrderBlocker(Number(body.storyboard_id))
      if (blocked) return badRequest(c, blocked)
    }
    // 请求显式指定 config_id（工作台模型下拉跨厂商切换）时优先；
    // 未指定才回退到集锁定配置，避免锁定配置与所选模型错配（如锁定 Seedance 却传 MiniMax 模型名）
    let configId: number | undefined = body.config_id
    let episodeResolution: string | undefined
    let storyboardDramaId: number | undefined
    if (body.storyboard_id) {
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id)))
      if (sb) {
        const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
        const locked = type === 'image' ? ep?.imageConfigId : ep?.videoConfigId
        if (locked != null && configId == null) configId = locked
        if (type === 'video' && ep?.resolution) episodeResolution = ep.resolution
        storyboardDramaId = ep?.dramaId ?? undefined
      }
    }

    if (type === 'video' && videoBody) {
      const effectiveConfig = configId
        ? (await getConfigById(configId)) ?? await getActiveConfig('video')
        : await getActiveConfig('video')
      const validationError = validateVideoRequest(videoBody, effectiveConfig?.provider)
      if (validationError) return badRequest(c, validationError)
      const voices = await resolveStoryboardVoiceReferences(String(videoBody.prompt || ''), Number(body.storyboard_id) || undefined, videoBody.reference_audio_urls)
      videoBody.prompt = voices.prompt
      videoBody.reference_audio_urls = voices.audioUrls
      if (voices.hasVoiceReferences && videoBody.generate_audio === false) return badRequest(c, 'Video audio must be enabled when referencing character voices')
      const referenceError = validateVideoRequest(videoBody, effectiveConfig?.provider)
      if (referenceError) return badRequest(c, referenceError)
      if (effectiveConfig?.provider === 'openrouter') {
        // Each OpenRouter model allows different durations and resolutions; snap to the closest it accepts
        const model = videoBody.model || effectiveConfig.model
        const limits = (await getOpenRouterVideoModels(effectiveConfig.baseUrl))[model]
        const fit = fitToModel(limits, Number(videoBody.duration) || null, episodeResolution || videoBody.resolution)
        if (fit.duration != null) videoBody.duration = fit.duration
        if (fit.resolution) { videoBody.resolution = fit.resolution; episodeResolution = fit.resolution }
      }
    }

    logTaskStart('TaskAPI', 'generate', {
      type,
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
    })
    logTaskPayload('TaskAPI', 'request body', body)

    // 视频生成时把项目视觉风格词注入提示词最前方（与图片侧的自动注入保持一致口径）
    let videoPrompt = videoBody?.prompt
    // Shots are generated one by one: hand each the scene's master frame and the previous shot's last
    // frame so room, wardrobe and positions carry over. Exact-frame requests are left alone.
    if (type === 'video' && videoBody && body.storyboard_id && body.continuity !== false && !videoBody.first_frame_url) {
      const refs = await continuityReferences(Number(body.storyboard_id))
      const extra = [refs.master, refs.previous].filter((u): u is string => !!u && !videoBody.reference_image_urls.includes(u))
      // Seedance takes at most 9 reference images
      if (extra.length && videoBody.reference_image_urls.length + extra.length <= 9) {
        const note = continuityPrompt({
          master: extra.includes(refs.master!) ? refs.master : undefined,
          previous: extra.includes(refs.previous!) ? refs.previous : undefined,
        }, videoBody.reference_image_urls.length + 1)
        videoBody.reference_image_urls = [...videoBody.reference_image_urls, ...extra]
        videoPrompt = `${videoPrompt || ''}\n${note}`.trim()
      }
    }
    if (type === 'video' && String(videoPrompt || '').trim()) {
      const dramaId = body.drama_id ?? storyboardDramaId ?? null
      const stylePrompt = await getDramaStylePrompt(dramaId)
      if (stylePrompt) videoPrompt = `${stylePrompt}，\n${videoPrompt}`
    }

    const id = type === 'image'
      ? await generateImage({
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        sceneId: body.scene_id,
        characterId: body.character_id,
        prompt: body.prompt,
        model: body.model,
        size: body.size,
        referenceImages: body.reference_images,
        frameType: body.frame_type,
        configId,
      })
      : await generateVideo({
        forceNew: body.force_new === true,
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        prompt: videoPrompt,
        model: videoBody!.model,
        referenceMode: 'reference',
        imageUrl: videoBody!.image_url,
        firstFrameUrl: videoBody!.first_frame_url,
        lastFrameUrl: videoBody!.last_frame_url,
        referenceImageUrls: videoBody!.reference_image_urls,
        referenceVideoUrls: videoBody!.reference_video_urls,
        referenceAudioUrls: videoBody!.reference_audio_urls,
        referenceFileUrl: videoBody!.file_url,
        referenceLinkUrl: videoBody!.link_url,
        generateAudio: videoBody!.generate_audio,
        duration: videoBody!.duration,
        aspectRatio: videoBody!.aspect_ratio,
        resolution: episodeResolution || videoBody!.resolution,
        seed: videoBody!.seed,
        promptExtend: videoBody!.prompt_extend,
        watermark: videoBody!.watermark,
        configId,
      })

    const [record] = await db.select().from(schema.sysTask)
      .where(eq(schema.sysTask.id, id))
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('TaskAPI', 'generate', { type, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /tasks/:id — 轮询任务状态
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.id, id))
  return success(c, row || null)
})

// GET /tasks — 按 type / storyboard_id / drama_id 过滤
app.get('/', async (c) => {
  const type = c.req.query('type')
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = await db.select().from(schema.sysTask)

  if (type) rows = rows.filter(r => r.type === type)
  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /tasks/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (task?.status === 'processing') return badRequest(c, 'Task is running and cannot be deleted yet')
  await db.delete(schema.sysTask).where(eq(schema.sysTask.id, id))
  return success(c)
})

export default app
