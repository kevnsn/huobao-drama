import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

type VoiceCharacter = { name: string; voiceAudioUrl: string | null; bound?: boolean }
const voiceToken = /#[^\s#@，。！？；、：,.!?;:「」“”"'（）()[\]{}<>]{1,100}/u

/** Only explicitly mentioned voices are sent; indices follow the audio array, not image order. */
export function resolveVoiceMentions(prompt: string, characters: VoiceCharacter[], existingAudio: string[] = []) {
  const audioUrls = [...new Set(existingAudio.map(url => url.trim()))]
  const names = [...new Set(characters.map(c => c.name).filter(Boolean))].sort((a, b) => b.length - a.length)
  let hasVoiceReferences = false
  let result = ''
  for (let pos = 0; pos < prompt.length;) {
    if (prompt[pos] !== '#') { result += prompt[pos++]; continue }
    const tail = prompt.slice(pos)
    const name = names.find(name => tail.startsWith(`#${name}`))
    if (name === undefined) {
      const unknown = tail.match(voiceToken)
      // Numeric shot labels such as #01 are not voice mentions.
      if (unknown?.index === 0 && !/^#\d+$/.test(unknown[0])) throw new Error(`Invalid voice reference "${unknown[0]}". Choose a voice from a character bound to the current shot`)
      result += prompt[pos++]
      continue
    }
    const matches = characters.filter(c => c.name === name && c.bound !== false)
    if (!matches.length) throw new Error(`Invalid voice reference "#${name}": that character is not bound to the current shot`)
    if (matches.length > 1) throw new Error(`The current shot has multiple characters named "${name}". Rename them before referencing a voice`)
    const url = matches[0].voiceAudioUrl?.trim()
    if (!url) throw new Error(`Character "${name}" has no voice uploaded or the voice was removed. Re-upload it and try again`)
    let index = audioUrls.indexOf(url)
    if (index < 0) { index = audioUrls.length; audioUrls.push(url) }
    hasVoiceReferences = true
    result += `${name}（音色参考音频${index + 1}）`
    pos += name.length + 1
    // Keep saved prompts using the previous #Name音色 spelling functional.
    if (prompt.slice(pos).startsWith('音色')) pos += 2
  }
  return { prompt: result, audioUrls, hasVoiceReferences }
}

export async function resolveStoryboardVoiceReferences(prompt: string, storyboardId: number | undefined, existingAudio: string[]) {
  if (!prompt.includes('#')) return { prompt, audioUrls: existingAudio, hasVoiceReferences: false }
  if (!storyboardId) {
    if ([...prompt.matchAll(new RegExp(voiceToken, 'gu'))].some(match => !/^#\d+$/.test(match[0]))) throw new Error('A shot must be specified when referencing character voices')
    return { prompt, audioUrls: existingAudio, hasVoiceReferences: false }
  }
  const characters = await db.select({ name: schema.characters.name, voiceAudioUrl: schema.characters.voiceAudioUrl, boundId: schema.storyboardCharacters.characterId })
    .from(schema.storyboards)
    .innerJoin(schema.episodes, eq(schema.storyboards.episodeId, schema.episodes.id))
    .innerJoin(schema.characters, eq(schema.characters.dramaId, schema.episodes.dramaId))
    .leftJoin(schema.storyboardCharacters, and(eq(schema.storyboardCharacters.storyboardId, schema.storyboards.id), eq(schema.storyboardCharacters.characterId, schema.characters.id)))
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt), isNull(schema.episodes.deletedAt), isNull(schema.characters.deletedAt)))
  return resolveVoiceMentions(prompt, characters.map(c => ({ ...c, bound: c.boundId !== null })), existingAudio)
}
