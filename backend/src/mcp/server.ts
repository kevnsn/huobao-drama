/**
 * MCP server for Huobao Drama. Every tool is a thin wrapper over the REST API,
 * so it works the same over stdio (Claude Code, Codex CLI) and HTTP (ChatGPT).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import sharp from 'sharp'
import { z } from 'zod'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
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

  const server = new McpServer({ name: 'huobao-drama', version: '1.0.0' })

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
    description: z.string().optional(),
    duration: z.number().optional().describe('Seconds'),
    scene_id: id.optional(),
    character_ids: z.array(id).optional(),
    prop_ids: z.array(id).optional(),
  }
  tool('create_storyboard', 'Add a shot to an episode. Scene, characters and props must already be linked to that episode.', {
    episode_id: id,
    storyboard_number: z.number().int().positive().optional(),
    ...shotFields,
  }, args => api('POST', '/storyboards', args))

  tool('update_storyboard', 'Update a shot. `video_prompt` is what the video model receives.', {
    storyboard_id: id,
    ...shotFields,
    video_prompt: z.string().optional(),
    image_prompt: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
  }, ({ storyboard_id, ...body }) => api('PUT', `/storyboards/${storyboard_id}`, body))

  // ── Generation ───────────────────────────────────────────────────────────
  tool('generate_image', 'Generate the image for a character, scene or prop with the app\'s own image service. Billed by that service. Returns a task id; poll get_task.', {
    target,
    id,
    episode_id: id.describe('Episode whose locked image service and style to use'),
    model: z.string().optional(),
    config_id: id.optional().describe('Image service id from list_services, overrides the episode\'s'),
  }, ({ target: t, id: targetId, ...body }) => api('POST', `/${TARGET_PATH[t]}/${targetId}/generate-image`, body))

  tool('generate_video', 'Generate the video for a shot. Billed by the video service. Returns a task; poll get_task until status is completed or failed.', {
    storyboard_id: id,
    prompt: z.string().min(1).describe('Usually the shot\'s video_prompt from get_episode_assets'),
    duration: z.number().optional().describe('Seconds'),
    model: z.string().optional(),
    config_id: id.optional().describe('Video service id from list_services, overrides the episode\'s'),
    reference_image_urls: z.array(z.string()).optional(),
    force_new: z.boolean().optional().describe('Required to retry after a failed task; may be billed again'),
  }, args => api('POST', '/tasks', { type: 'video', ...args }))

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

  async function readImage(args: { file_path?: string; url?: string; base64?: string; file?: z.infer<typeof fileSchema> }) {
    const given = [args.file_path, args.url, args.base64, args.file].filter(Boolean)
    if (given.length !== 1) throw new Error('Pass exactly one of file_path, url, base64 or file')
    let buf: Buffer
    if (args.file_path) {
      if (!path.isAbsolute(args.file_path)) throw new Error('file_path must be an absolute path')
      const stat = await fs.stat(args.file_path).catch(() => null)
      if (!stat?.isFile()) throw new Error(`No file at ${args.file_path}`)
      if (stat.size > MAX_IMAGE_BYTES) throw new Error('Image is larger than 20MB')
      buf = await fs.readFile(args.file_path)
    } else if (args.base64) {
      buf = Buffer.from(args.base64.replace(/^data:[^,]*,/, ''), 'base64')
    } else {
      const src = args.url || args.file!.download_url
      if (!/^https?:\/\//i.test(src)) throw new Error('url must start with http:// or https://')
      const resp = await fetch(src, { signal: AbortSignal.timeout(60_000) })
      if (!resp.ok) throw new Error(`Could not download the image: HTTP ${resp.status}`)
      if (Number(resp.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Image is larger than 20MB')
      buf = Buffer.from(await resp.arrayBuffer())
    }
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image is larger than 20MB')
    const mime = imageMime(buf)
    if (!mime) throw new Error('Not a PNG, JPEG, WebP or GIF image')
    return { buf, mime }
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
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), `mcp-import${IMAGE_EXT[mime]}`)
      const resp = await fetch(`${apiBase}/upload/image`, { method: 'POST', body: form })
      const json: any = await resp.json().catch(() => null)
      if (!resp.ok || !json?.data?.path) throw new Error(json?.message || `Upload failed with HTTP ${resp.status}`)
      const saved = json.data.path as string
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

  return server
}
