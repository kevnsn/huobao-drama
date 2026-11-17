/**
 * Shot-to-shot continuity. Each shot is a separate video generation, so without shared
 * references the room, wardrobe and positions drift between shots. Two anchors fix that:
 * - a master frame per staging setup: one wide image with everyone in place and in costume,
 *   stored as the composed image of the setup's first shot. A setup is a run of consecutive
 *   shots in one scene with the same people in it; when someone arrives or leaves, a new one starts
 * - the last frame of the previous shot in the same scene, so the next one picks up from it
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { ffmpegPath } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { generateImage } from './generation.js'
import { getDramaStylePrompt } from './style-preset.js'

const exec = promisify(execFile)

type Storyboard = typeof schema.storyboards.$inferSelect

async function episodeShots(episodeId: number): Promise<Storyboard[]> {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
}

/**
 * Split an episode's shots into staging setups: consecutive shots that share a scene and a cast.
 * Shots without a scene are left out — there is nothing to hold them together.
 */
async function stagingSetups(shots: Storyboard[]): Promise<Storyboard[][]> {
  const links = shots.length
    ? await db.select().from(schema.storyboardCharacters)
      .where(inArray(schema.storyboardCharacters.storyboardId, shots.map(s => s.id)))
    : []
  const cast = (id: number) => links.filter(l => l.storyboardId === id).map(l => l.characterId).sort((a, b) => a - b).join(',')
  const setups: Storyboard[][] = []
  let key = ''
  for (const sb of shots) {
    if (!sb.sceneId) { key = ''; continue }
    const k = `${sb.sceneId}|${cast(sb.id)}`
    if (k === key) setups[setups.length - 1].push(sb)
    else { setups.push([sb]); key = k }
  }
  return setups
}

/** Last frame of a finished shot video, cached next to the other frames */
async function lastFrame(sb: Storyboard): Promise<string | null> {
  if (!sb.videoUrl || !ffmpegPath || /^https?:/i.test(sb.videoUrl)) return null
  const video = getAbsolutePath(sb.videoUrl)
  if (!fs.existsSync(video)) return null
  // The video file name changes on every regeneration, so it keys the cache
  const rel = `static/frames/shot-${sb.id}-${path.basename(video, path.extname(video))}-last.jpg`
  const out = path.join(STORAGE_ROOT, 'frames', path.basename(rel))
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    try {
      await exec(ffmpegPath, ['-y', '-sseof', '-0.15', '-i', video, '-frames:v', '1', '-q:v', '2', out])
    } catch {
      return null
    }
    if (!fs.existsSync(out)) return null
  }
  return rel
}

/** Continuity reference images for one shot: its scene's master frame and the previous shot's last frame */
export async function continuityReferences(storyboardId: number): Promise<{ master?: string; previous?: string }> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb?.sceneId) return {}
  const shots = await episodeShots(sb.episodeId)
  const setup = (await stagingSetups(shots)).find(group => group.some(s => s.id === sb.id)) || []
  const anchor = setup.find(s => s.composedImage)
  // The previous shot still counts across a staging change: it shows where everyone just was
  const before = shots.filter(s => s.sceneId === sb.sceneId && s.storyboardNumber < sb.storyboardNumber && s.videoUrl).pop()
  return {
    master: anchor?.composedImage || undefined,
    previous: (before && await lastFrame(before)) || undefined,
  }
}

/**
 * Why a shot should not be generated yet, or null when it can be. A shot continues from the last frame
 * of the shot before it in the same scene, so that one has to be finished first.
 */
export async function generationOrderBlocker(storyboardId: number): Promise<string | null> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb?.sceneId) return null
  const before = (await episodeShots(sb.episodeId))
    .filter(s => s.sceneId === sb.sceneId && s.storyboardNumber < sb.storyboardNumber).pop()
  if (!before) return null
  const [latest] = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, before.id)))
    .orderBy(desc(schema.sysTask.id)).limit(1)
  if (latest?.status === 'processing' || latest?.status === 'pending') {
    return `Shot ${before.storyboardNumber} is still generating. Wait for it so this shot can continue from its last frame`
  }
  if (!before.videoUrl) {
    return `Generate shot ${before.storyboardNumber} first so this shot can continue from its last frame`
  }
  return null
}

/** Prompt lines telling the video model what the extra reference images are. `first` is the 1-based index of the first one. */
export function continuityPrompt(refs: { master?: string; previous?: string }, first: number): string {
  const lines: string[] = []
  let n = first
  if (refs.master) {
    lines.push(`图片${n++} is the master frame of this scene: keep the same room, furniture, lighting, wardrobe and props, and the same people on the same sides.`)
  }
  if (refs.previous) {
    lines.push(`图片${n++} is the last frame of the previous shot: this shot continues directly from that moment — same places, postures and held objects unless the shot says someone moves.`)
  }
  return lines.join('\n')
}

function frameSize(aspectRatio?: string | null): string {
  if (aspectRatio === '9:16' || aspectRatio === '3:4') return '1080x1920'
  if (aspectRatio === '1:1') return '1440x1440'
  return '1920x1080'
}

/**
 * Start one master-frame image per staging setup of the episode. Returns the image task ids.
 * Setups that already have one are skipped unless `force`.
 */
export async function generateSceneMasters(episodeId: number, opts: { force?: boolean; configId?: number; model?: string } = {}) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('Episode not found')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId))
  const shots = await episodeShots(episodeId)
  const stylePrompt = await getDramaStylePrompt(ep.dramaId)

  const started: { scene_id: number; storyboard_id: number; task_id: number }[] = []
  const skipped: number[] = []

  for (const sceneShots of await stagingSetups(shots)) {
    const anchor = sceneShots[0]
    const sceneId = anchor.sceneId!
    if (!opts.force && sceneShots.some(s => s.composedImage)) { skipped.push(anchor.id); continue }
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    const links = await db.select().from(schema.storyboardCharacters)
      .where(inArray(schema.storyboardCharacters.storyboardId, sceneShots.map(s => s.id)))
    const charIds = Array.from(new Set(links.map(l => l.characterId)))
    const chars = charIds.length
      ? await db.select().from(schema.characters).where(and(inArray(schema.characters.id, charIds)))
      : []

    // Staging comes from the first shot's blocking line when the storyboard wrote one
    const blocking = (anchor.description || '').match(/【Blocking】([^【]*)/)?.[1]?.trim()
    const lock = (anchor.description || '').match(/【Scene lock】([^【]*)/)?.[1]?.trim()
    const prompt = [
      stylePrompt,
      `Wide master frame of one scene, a single film still that establishes the whole space: ${scene?.location || 'the location'}${scene?.time ? `, ${scene.time}` : ''}.`,
      scene?.prompt, scene?.lighting,
      lock ? `Scene details: ${lock}` : '',
      chars.length ? `Everyone is in frame, full body or knees-up, clearly separated: ${chars.map(c => `${c.name} — ${c.styling || c.appearance || ''}`).join('; ')}.` : '',
      blocking ? `Staging: ${blocking}` : '',
      'Each person matches their reference image exactly: same face, hair and clothing. Natural mid-conversation poses, nobody looking at the camera. No text, no captions, no split panels.',
    ].filter(Boolean).join('\n')

    const taskId = await generateImage({
      storyboardId: anchor.id,
      dramaId: ep.dramaId,
      prompt,
      size: frameSize(drama?.aspectRatio),
      referenceImages: [scene?.imageUrl, ...chars.map(c => c.imageUrl)].filter((u): u is string => !!u),
      model: opts.model,
      configId: opts.configId ?? ep.imageConfigId ?? undefined,
    })
    started.push({ scene_id: sceneId, storyboard_id: anchor.id, task_id: taskId })
  }
  return { started, skipped_storyboard_ids: skipped }
}
