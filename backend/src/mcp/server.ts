/**
 * MCP server for Huobao Drama. Every tool is a thin wrapper over the REST API,
 * so it works the same over stdio (Claude Code, Codex CLI) and HTTP (ChatGPT).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import sharp from 'sharp'
import { z } from 'zod'
import { ffmpegPath } from '../utils/ffmpeg.js'

const exec = promisify(execFile)

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
}
const TARGET_PATH = { character: 'characters', scene: 'scenes', prop: 'props' } as const

const id = z.number().int().positive()
const target = z.enum(['character', 'scene', 'prop'])

type ToolResult = { content: any[]; isError?: boolean }
const text = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})

/** Sniff the real type from the bytes: file names and declared MIME types can lie */
function imageMime(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  return null
}

/** mp4/mov/m4v carry "ftyp" at byte 4, webm starts with the EBML magic */
function videoExt(buf: Buffer): string | null {
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return buf.subarray(8, 10).toString('latin1') === 'qt' ? '.mov' : '.mp4'
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return '.webm'
  return null
}

const INSTRUCTIONS = `Huobao Drama turns scripts into short-form video: project → episode → characters/scenes/props → shots (storyboards) → video per shot.

To recreate an existing clip in a different style:
1. upload_clip, then analyze_clip. It finds the cuts and returns, per shot, its timing, a first frame, a middle frame and a cut-out segment.
2. Look at the frames and write each shot yourself: what is in frame, the action, shot size, angle, camera move, and timing. Stay faithful to the source; change only the style.
3. create_project with the new style (list_style_presets) and the clip's aspect ratio, create_episode, create_character for each person (appearance and styling in the new style), then create_storyboards with one entry per source shot, same order and same durations.
4. Per shot, restyle the first frame with generate_frame (reference_images = the source first frame; ask for the same composition, people, poses and framing in the new style), wait with get_task, then generate_video with reference_image_urls = [that task's localPath] and a prompt that says the video opens on exactly image 1, then describes the action and camera move. This works with every video service.
5. Closer motion match: pass the shot's segment as reference_video_urls instead of a first frame. Only some services accept reference video (Seedance, Wan), and the backend needs PUBLIC_BASE_URL so the service can download it.
Generation is billed by the user's services: confirm before starting many tasks.`

export function createMcpServer(apiBase = process.env.HUOBAO_API || 'http://localhost:5679/api/v1') {
  const origin = new URL(apiBase).origin

  async function api(method: string, route: string, body?: unknown): Promise<any> {
    let resp: Response
    try {
      resp = await fetch(`${apiBase}${route}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new Error(`Cannot reach the Huobao Drama backend at ${apiBase}. Start it first.`)
    }
    const json: any = await resp.json().catch(() => null)
    if (!resp.ok || (json?.code && json.code >= 400)) {
      throw new Error(json?.message || `${method} ${route} failed with HTTP ${resp.status}`)
    }
    return json?.data ?? null
  }

  const server = new McpServer({ name: 'huobao-drama', version: '1.0.0' }, { instructions: INSTRUCTIONS })

  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult | unknown>,
    extra: { readOnly?: boolean; _meta?: Record<string, unknown> } = {},
  ) {
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: { readOnlyHint: !!extra.readOnly },
      ...(extra._meta ? { _meta: extra._meta } : {}),
    }, (async (args: any) => {
      try {
        const out = await run(args)
        return (out as ToolResult)?.content ? out : text(out ?? 'ok')
      } catch (err: any) {
        return { ...text(err?.message || String(err)), isError: true }
      }
    }) as any)
  }

  // ── Projects and episodes ────────────────────────────────────────────────
  tool('list_projects', 'List all projects (dramas) with their ids.', {},
    async () => ((await api('GET', '/dramas?page=1&page_size=100'))?.items || []).map((d: any) => ({
      id: d.id, title: d.title, description: d.description, style: d.style, aspect_ratio: d.aspect_ratio,
      episodes: (d.episodes || []).map((e: any) => ({ id: e.id, number: e.episode_number, title: e.title })),
      characters: d.characters?.length || 0, scenes: d.scenes?.length || 0,
    })), { readOnly: true })

  tool('get_project', 'Get one project with its characters, scenes, props and episodes.', { project_id: id },
    ({ project_id }) => api('GET', `/dramas/${project_id}`), { readOnly: true })

  tool('create_project', 'Create a project. `style` is a style preset value from list_style_presets (for example "realistic").', {
    title: z.string().min(1),
    description: z.string().optional(),
    genre: z.string().optional(),
    style: z.string().optional(),
    aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional(),
  }, args => api('POST', '/dramas', args))

  tool('update_project', 'Update a project\'s title, description, genre, style or aspect ratio.', {
    project_id: id,
    title: z.string().optional(),
    description: z.string().optional(),
    genre: z.string().optional(),
    style: z.string().optional(),
    aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional(),
  }, ({ project_id, ...body }) => api('PUT', `/dramas/${project_id}`, body))

  tool('create_episode', 'Add an episode to a project. It locks the currently enabled image and video services; pass config ids from list_services to choose others.', {
    project_id: id,
    title: z.string().optional(),
    resolution: z.enum(['480p', '720p', '1080p']).optional(),
    image_config_id: id.optional(),
    video_config_id: id.optional(),
  }, ({ project_id, ...body }) => api('POST', '/episodes', { drama_id: project_id, ...body }))

  tool('update_episode', 'Update an episode: title, script text (`content` is the raw story, `script_content` the formatted script) or resolution.', {
    episode_id: id,
    title: z.string().optional(),
    content: z.string().optional(),
    script_content: z.string().optional(),
    resolution: z.enum(['480p', '720p', '1080p']).optional(),
  }, ({ episode_id, ...body }) => api('PUT', `/episodes/${episode_id}`, body))

  tool('get_episode_assets', 'Get everything in an episode: characters, scenes, props, shots (storyboards) and pipeline progress.', { episode_id: id },
    async ({ episode_id }) => {
      const [characters, scenes, props, storyboards, pipeline] = await Promise.all([
        api('GET', `/episodes/${episode_id}/characters`),
        api('GET', `/episodes/${episode_id}/scenes`),
        api('GET', `/episodes/${episode_id}/props`),
        api('GET', `/episodes/${episode_id}/storyboards`),
        api('GET', `/episodes/${episode_id}/pipeline-status`),
      ])
      return { characters, scenes, props, storyboards, pipeline: pipeline?.steps }
    }, { readOnly: true })

  // ── Characters, scenes, props, shots ─────────────────────────────────────
  tool('create_character', 'Add a character to a project. Pass episode_id to also link it to that episode.', {
    project_id: id,
    name: z.string().min(1),
    episode_id: id.optional(),
    role: z.string().optional(),
    description: z.string().optional(),
    appearance: z.string().optional(),
    styling: z.string().optional(),
  }, ({ project_id, ...body }) => api('POST', '/characters', { drama_id: project_id, ...body }))

  tool('update_character', 'Update a character. `final_prompt` is the exact prompt used for its portrait.', {
    character_id: id,
    name: z.string().optional(),
    role: z.string().optional(),
    description: z.string().optional(),
    appearance: z.string().optional(),
    styling: z.string().optional(),
    final_prompt: z.string().optional(),
  }, ({ character_id, ...body }) => api('PUT', `/characters/${character_id}`, body))

  tool('create_scene', 'Add a scene (location) to a project. Pass episode_id to also link it to that episode.', {
    project_id: id,
    location: z.string().min(1),
    episode_id: id.optional(),
    time: z.string().optional(),
    prompt: z.string().optional().describe('Visual description of the place'),
  }, ({ project_id, ...body }) => api('POST', '/scenes', { drama_id: project_id, ...body }))

  tool('update_scene', 'Update a scene. `final_prompt` is the exact prompt used for its image.', {
    scene_id: id,
    location: z.string().optional(),
    time: z.string().optional(),
    prompt: z.string().optional(),
    lighting: z.string().optional(),
    final_prompt: z.string().optional(),
  }, ({ scene_id, ...body }) => api('PUT', `/scenes/${scene_id}`, body))

  tool('create_prop', 'Add a prop to a project. Pass episode_id to also link it to that episode.', {
    project_id: id,
    name: z.string().min(1),
    episode_id: id.optional(),
    type: z.string().optional(),
    description: z.string().optional(),
  }, ({ project_id, ...body }) => api('POST', '/props', { drama_id: project_id, ...body }))

  tool('update_prop', 'Update a prop. `final_prompt` is the exact prompt used for its image.', {
    prop_id: id,
    name: z.string().optional(),
    type: z.string().optional(),
    description: z.string().optional(),
    final_prompt: z.string().optional(),
  }, ({ prop_id, ...body }) => api('PUT', `/props/${prop_id}`, body))

  const shotFields = {
    title: z.string().optional(),
    description: z.string().optional().describe('What the audience sees and hears, sub-shot by sub-shot'),
    duration: z.number().optional().describe('Seconds'),
    scene_id: id.optional(),
    character_ids: z.array(id).optional(),
    prop_ids: z.array(id).optional(),
    video_prompt: z.string().optional().describe('What the video model receives'),
    image_prompt: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional().describe('Camera move'),
    atmosphere: z.string().optional(),
  }
  const CREATE_KEYS = ['title', 'description', 'duration', 'scene_id', 'character_ids', 'prop_ids']

  async function createShot(episode_id: number, shot: Record<string, any>) {
    const base: Record<string, any> = { episode_id, storyboard_number: shot.storyboard_number }
    const rest: Record<string, any> = {}
    for (const [k, v] of Object.entries(shot)) {
      if (v === undefined || k === 'storyboard_number') continue
      if (CREATE_KEYS.includes(k)) base[k] = v
      else rest[k] = v
    }
    const created = await api('POST', '/storyboards', base)
    if (Object.keys(rest).length) await api('PUT', `/storyboards/${created.id}`, rest)
    return { ...created, ...rest }
  }

  tool('create_storyboard', 'Add one shot to an episode. Scene, characters and props must already be linked to that episode.', {
    episode_id: id,
    storyboard_number: z.number().int().positive().optional(),
    ...shotFields,
  }, ({ episode_id, ...shot }) => createShot(episode_id, shot))

  tool('create_storyboards', 'Add several shots to an episode in order, each with its own description, duration and video prompt. Shots are numbered after the episode\'s existing ones.', {
    episode_id: id,
    shots: z.array(z.object(shotFields)).min(1).max(40),
  }, async ({ episode_id, shots }) => {
    const existing = await api('GET', `/episodes/${episode_id}/storyboards`)
    const list: any[] = Array.isArray(existing) ? existing : existing?.items || []
    let next = Math.max(0, ...list.map(sb => Number(sb.storyboard_number) || 0)) + 1
    const out = []
    for (const shot of shots) {
      const row = await createShot(episode_id, { ...shot, storyboard_number: next++ })
      out.push({ id: row.id, storyboard_number: row.storyboard_number, title: row.title, duration: row.duration })
    }
    return out
  })

  tool('update_storyboard', 'Update a shot. `video_prompt` is what the video model receives.', {
    storyboard_id: id,
    ...shotFields,
  }, ({ storyboard_id, ...body }) => api('PUT', `/storyboards/${storyboard_id}`, body))

  // ── Generation ───────────────────────────────────────────────────────────
  tool('generate_image', 'Generate the image for a character, scene or prop with the app\'s own image service. Billed by that service. Returns a task id; poll get_task.', {
    target,
    id,
    episode_id: id.describe('Episode whose locked image service and style to use'),
    model: z.string().optional(),
    config_id: id.optional().describe('Image service id from list_services, overrides the episode\'s'),
  }, ({ target: t, id: targetId, ...body }) => api('POST', `/${TARGET_PATH[t]}/${targetId}/generate-image`, body))

  tool('generate_frame', 'Generate a free-form image from a prompt, optionally guided by reference images (for example a frame from analyze_clip to restyle). With storyboard_id it becomes that shot\'s first frame, last frame or cover. Billed by the image service. Returns a task; poll get_task and use its localPath.', {
    prompt: z.string().min(1),
    project_id: id,
    reference_images: z.array(z.string()).optional().describe('Paths from this app (static/...) or public URLs'),
    storyboard_id: id.optional(),
    frame_type: z.enum(['first_frame', 'last_frame']).optional(),
    size: z.string().optional().describe('For example 1080x1920'),
    model: z.string().optional(),
    config_id: id.optional().describe('Image service id from list_services'),
  }, ({ project_id, ...body }) => api('POST', '/tasks', { type: 'image', drama_id: project_id, ...body }))

  tool('generate_video', 'Generate the video for a shot. Billed by the video service. Returns a task; poll get_task until status is completed or failed. Exact frames (first_frame_url) and loose references (reference_*_urls) cannot be mixed on most services.', {
    storyboard_id: id,
    prompt: z.string().min(1).describe('Usually the shot\'s video_prompt from get_episode_assets'),
    duration: z.number().optional().describe('Seconds'),
    model: z.string().optional(),
    config_id: id.optional().describe('Video service id from list_services, overrides the episode\'s'),
    first_frame_url: z.string().optional().describe('Start the video from this exact image. The Volcengine Seedance service ignores it: pass the image in reference_image_urls there'),
    last_frame_url: z.string().optional(),
    reference_image_urls: z.array(z.string()).optional(),
    reference_video_urls: z.array(z.string()).optional().describe('Motion and camera reference. Must be reachable by the video service: a public URL, or an app path when the backend has PUBLIC_BASE_URL set'),
    aspect_ratio: z.string().optional(),
    resolution: z.enum(['480p', '720p', '1080p']).optional(),
    generate_audio: z.boolean().optional(),
    force_new: z.boolean().optional().describe('Required to retry after a failed task; may be billed again'),
    continuity: z.boolean().optional().describe('Default true: adds the scene master frame and the previous shot\'s last frame as references'),
  }, args => api('POST', '/tasks', { type: 'video', ...args }))

  tool('generate_scene_masters', 'Generate one wide master frame per staging setup of an episode (a run of consecutive shots in one scene with the same people), with every character in place and in costume. Every shot in that setup then gets it as a continuity reference automatically, along with the last frame of the previous shot. Run this after the storyboard exists and before generating videos; generate a scene\'s shots in order. Billed by the image service. Returns image task ids to poll with get_task.', {
    episode_id: id,
    force: z.boolean().optional().describe('Regenerate scenes that already have a master frame'),
  }, ({ episode_id, ...body }) => api('POST', `/episodes/${episode_id}/scene-masters`, body))

  tool('merge_episode', 'Join the episode\'s finished shot videos into one video, in shot order. Trailing dead air is trimmed conservatively unless trim_silence is false. Poll get_merge_status.', {
    episode_id: id,
    storyboard_ids: z.array(id).optional().describe('Only these shots'),
    trim_silence: z.boolean().optional(),
  }, ({ episode_id, ...body }) => api('POST', `/merge/episodes/${episode_id}/merge`, body))

  tool('get_merge_status', 'Latest merge of an episode: status and the merged video path.', { episode_id: id },
    ({ episode_id }) => api('GET', `/merge/episodes/${episode_id}/merge`), { readOnly: true })

  tool('get_task', 'Get one generation task: status (pending, processing, completed, failed), result and error.', { task_id: id },
    ({ task_id }) => api('GET', `/tasks/${task_id}`), { readOnly: true })

  tool('list_tasks', 'List generation tasks, optionally filtered.', {
    type: z.enum(['image', 'video']).optional(),
    project_id: id.optional(),
    storyboard_id: id.optional(),
  }, ({ type, project_id, storyboard_id }) => {
    const q = new URLSearchParams()
    if (type) q.set('type', type)
    if (project_id) q.set('drama_id', String(project_id))
    if (storyboard_id) q.set('storyboard_id', String(storyboard_id))
    return api('GET', `/tasks?${q}`)
  }, { readOnly: true })

  tool('list_services', 'List configured AI services (text, image, video) with their ids, models and whether they are enabled. API keys are never returned.', {},
    async () => (await api('GET', '/ai-configs') as any[]).map(({ api_key, apiKey, ...rest }) => rest), { readOnly: true })

  tool('list_style_presets', 'List visual style presets a project can use.', {},
    () => api('GET', '/style-presets'), { readOnly: true })

  // ── Images made elsewhere (ChatGPT, Codex) ───────────────────────────────
  const fileSchema = z.object({
    download_url: z.string(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })

  type Source = { file_path?: string; url?: string; base64?: string; file?: z.infer<typeof fileSchema> }

  async function readSource(args: Source, maxBytes: number): Promise<Buffer> {
    const mb = `${Math.round(maxBytes / 1024 / 1024)}MB`
    const given = [args.file_path, args.url, args.base64, args.file].filter(Boolean)
    if (given.length !== 1) throw new Error('Pass exactly one of file_path, url, base64 or file')
    let buf: Buffer
    if (args.file_path) {
      if (!path.isAbsolute(args.file_path)) throw new Error('file_path must be an absolute path')
      const stat = await fs.stat(args.file_path).catch(() => null)
      if (!stat?.isFile()) throw new Error(`No file at ${args.file_path}`)
      if (stat.size > maxBytes) throw new Error(`File is larger than ${mb}`)
      buf = await fs.readFile(args.file_path)
    } else if (args.base64) {
      buf = Buffer.from(args.base64.replace(/^data:[^,]*,/, ''), 'base64')
    } else {
      const src = args.url || args.file!.download_url
      if (!/^https?:\/\//i.test(src)) throw new Error('url must start with http:// or https://')
      const resp = await fetch(src, { signal: AbortSignal.timeout(120_000) })
      if (!resp.ok) throw new Error(`Could not download the file: HTTP ${resp.status}`)
      if (Number(resp.headers.get('content-length')) > maxBytes) throw new Error(`File is larger than ${mb}`)
      buf = Buffer.from(await resp.arrayBuffer())
    }
    if (buf.length > maxBytes) throw new Error(`File is larger than ${mb}`)
    return buf
  }

  async function readImage(args: Source) {
    const buf = await readSource(args, MAX_IMAGE_BYTES)
    const mime = imageMime(buf)
    if (!mime) throw new Error('Not a PNG, JPEG, WebP or GIF image')
    return { buf, mime }
  }

  /** Store bytes in the app's uploads folder; returns the app path (static/uploads/...) */
  async function upload(kind: 'image' | 'video', buf: Buffer, mime: string, name: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), name)
    const resp = await fetch(`${apiBase}/upload/${kind}`, { method: 'POST', body: form })
    const json: any = await resp.json().catch(() => null)
    if (!resp.ok || !json?.data?.path) throw new Error(json?.message || `Upload failed with HTTP ${resp.status}`)
    return json.data.path
  }

  const sourceShape = {
    file_path: z.string().optional().describe('Absolute path on this machine'),
    url: z.string().optional(),
    base64: z.string().optional(),
    file: fileSchema.optional().describe('A file from the ChatGPT conversation'),
  }

  tool('set_image',
    'Attach an existing image to a character, scene or prop, replacing its current one. Use this for images made outside the app, such as by ChatGPT or Codex image generation. Pass exactly one source: file_path (absolute path on this machine, e.g. where Codex saved the image), url, base64, or file (an image from the ChatGPT conversation).',
    {
      target,
      id,
      file_path: z.string().optional(),
      url: z.string().optional(),
      base64: z.string().optional(),
      file: fileSchema.optional(),
    },
    async ({ target: t, id: targetId, ...src }) => {
      const { buf, mime } = await readImage(src)
      const saved = await upload('image', buf, mime, `mcp-import${IMAGE_EXT[mime]}`)
      await api('PUT', `/${TARGET_PATH[t]}/${targetId}`, { image_url: saved, local_path: saved })
      return { target: t, id: targetId, image_url: saved, bytes: buf.length, mime_type: mime }
    },
    { _meta: { 'openai/fileParams': ['file'] } })

  tool('view_image', 'Look at the current image of a character, scene or prop.', { target, id, project_id: id },
    async ({ target: t, id: targetId, project_id }) => {
      const project = await api('GET', `/dramas/${project_id}`)
      const row = (project?.[TARGET_PATH[t]] || []).find((r: any) => r.id === targetId)
      if (!row) throw new Error(`No ${t} ${targetId} in project ${project_id}`)
      const imagePath = row.image_url || row.local_path
      if (!imagePath) throw new Error(`This ${t} has no image yet`)
      const src = /^https?:\/\//i.test(imagePath) ? imagePath : `${origin}/${String(imagePath).replace(/^\//, '')}`
      const resp = await fetch(src)
      if (!resp.ok) throw new Error(`Could not load the image: HTTP ${resp.status}`)
      const jpeg = await sharp(Buffer.from(await resp.arrayBuffer()))
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
      return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] }
    }, { readOnly: true })

  // ── Source clips: upload, find the cuts, hand back frames to describe ────
  tool('upload_image', 'Upload an image into the app without attaching it to anything. Returns an app path usable as a reference image or first frame.', sourceShape,
    async (src) => {
      const { buf, mime } = await readImage(src)
      return { path: await upload('image', buf, mime, `mcp-upload${IMAGE_EXT[mime]}`), bytes: buf.length, mime_type: mime }
    }, { _meta: { 'openai/fileParams': ['file'] } })

  tool('upload_clip', 'Upload a video clip (mp4, mov or webm, up to 50MB) into the app. Returns its app path; pass that to analyze_clip.', sourceShape,
    async (src) => {
      const buf = await readSource(src, MAX_VIDEO_BYTES)
      const ext = videoExt(buf)
      if (!ext) throw new Error('Not an mp4, mov or webm video')
      const mime = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4'
      return { clip: await upload('video', buf, mime, `mcp-clip${ext}`), bytes: buf.length }
    }, { _meta: { 'openai/fileParams': ['file'] } })

  tool('analyze_clip',
    'Break an uploaded clip into its shots. Finds the cuts and returns, per shot: start, end and duration in seconds, the first frame and a middle frame as images to look at, the first frame\'s app path (to restyle or use as first frame) and a cut-out segment\'s app path (to use as a reference video). Describe each shot from the frames, then build matching shots with create_storyboards.',
    {
      clip: z.string().describe('App path from upload_clip, for example static/uploads/abc.mp4'),
      sensitivity: z.number().min(0.05).max(0.9).optional().describe('Cut detection threshold, default 0.3. Lower finds more cuts'),
      max_shots: z.number().int().min(1).max(24).optional().describe('Default 12; the shortest shots are merged beyond this'),
    },
    async ({ clip, sensitivity = 0.3, max_shots = 12 }) => {
      if (!ffmpegPath) throw new Error('ffmpeg is not available on the backend')
      const rel = clip.replace(/^\//, '')
      if (!rel.startsWith('static/')) throw new Error('clip must be an app path from upload_clip')
      const resp = await fetch(`${origin}/${rel}`)
      if (!resp.ok) throw new Error(`Could not load the clip: HTTP ${resp.status}`)
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-clip-'))
      try {
        const input = path.join(dir, `in${path.extname(rel) || '.mp4'}`)
        await fs.writeFile(input, Buffer.from(await resp.arrayBuffer()))
        // ffmpeg reports on stderr; -f null decodes without writing a file
        const { stderr } = await exec(ffmpegPath, ['-hide_banner', '-i', input, '-vf', `select='gt(scene,${sensitivity})',showinfo`, '-an', '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 })
        const dm = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/)
        if (!dm) throw new Error('Could not read the clip duration')
        const total = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3])
        const size = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/)
        let cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1])).filter(t => t > 0.3 && t < total - 0.3)
        cuts = cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 0.3)
        while (cuts.length + 1 > max_shots) {
          // Drop the cut next to the shortest shot
          const e = [0, ...cuts, total]
          let drop = 0
          let shortest = Infinity
          cuts.forEach((_, i) => {
            const len = Math.min(e[i + 1] - e[i], e[i + 2] - e[i + 1])
            if (len < shortest) { shortest = len; drop = i }
          })
          cuts.splice(drop, 1)
        }
        const edges = [0, ...cuts, total]
        const shots: any[] = []
        const content: any[] = []
        for (let i = 0; i < edges.length - 1; i++) {
          const start = edges[i], end = edges[i + 1], dur = end - start
          const first = path.join(dir, `f${i}.jpg`), mid = path.join(dir, `m${i}.jpg`), seg = path.join(dir, `s${i}.mp4`)
          await exec(ffmpegPath, ['-y', '-ss', String(start + Math.min(0.05, dur / 4)), '-i', input, '-frames:v', '1', '-q:v', '2', first])
          await exec(ffmpegPath, ['-y', '-ss', String(start + dur / 2), '-i', input, '-frames:v', '1', '-q:v', '2', mid])
          await exec(ffmpegPath, ['-y', '-ss', String(start), '-i', input, '-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', seg])
          const firstBuf = await fs.readFile(first)
          shots.push({
            shot: i + 1,
            start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), duration: Number(dur.toFixed(2)),
            first_frame: await upload('image', firstBuf, 'image/jpeg', `clip-shot${i + 1}.jpg`),
            segment: await upload('video', await fs.readFile(seg), 'video/mp4', `clip-shot${i + 1}.mp4`),
          })
          for (const [label, file] of [['first frame', firstBuf], ['middle frame', await fs.readFile(mid)]] as const) {
            const small = await sharp(file).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer()
            content.push({ type: 'text', text: `Shot ${i + 1} (${start.toFixed(2)}s–${end.toFixed(2)}s), ${label}:` })
            content.push({ type: 'image', data: small.toString('base64'), mimeType: 'image/jpeg' })
          }
        }
        const summary = { clip: rel, duration: Number(total.toFixed(2)), width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null, shots }
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] }
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

  return server
}
