---
name: video-prompt
description: Video prompt specification — generates a time-segmented video-generation prompt from storyboard-segment content, with cuts allowed within a segment
---

# Video Prompt (storyboard segment → video_prompt)

From a single storyboard segment's description (containing the 【镜头N】 sub-shot structure and dialogue/narration) / atmosphere / duration, generate the `video_prompt` that drives AI video generation. **One storyboard segment = one 10-15-second video, cut fast, with a cut every 1-3 seconds**: consecutive segments may be different shots (change of shot size/angle/subject), joined with hard cuts; but the whole segment **never crosses scenes** and never uses flashbacks.

## Format

The **first line of the `video_prompt` is the header**: first introduce which characters and scene appear in this video, then follow with the time segments. Characters and scenes are always referenced with @ (during generation they are replaced with the corresponding reference-image markers, so the video model first locks onto "who" and "where").

```
Characters: @Xiaoming, @Xiaohong; Scene: @Coffee Shop.
Scene lock: small coffee shop, counter along the back wall, rain-streaked window on the left, corner table by the window. Xiaoming: grey hoodie under a worn denim jacket, silver watch, phone in hand, seated. Xiaohong: cream trench coat, red scarf, bag on her shoulder, standing.
Blocking: @Xiaoming sits at a corner table, frame left, facing the door; @Xiaohong enters frame right and stops across the table from him. They face each other, a table's width apart.
0-2s: @Coffee Shop, close shot, static camera; @Xiaoming taps the table, eyes on his phone, jaw tight.
2-3s: Cut to a wide shot of the doorway; the bell rings as @Xiaohong pushes in, scanning the room.
3-5s: Cut to a medium shot of @Xiaoming at eye level, waist-up on the left third, coffee cup and phone on the table in the foreground, the rain-streaked window glowing behind him; slow push-in; he looks up toward her, shoulders dropping. Xiaoming says, quiet and flat, not quite forgiving: "You finally made it."
5-7s: Cut to an over-the-shoulder shot past Xiaoming onto @Xiaohong, frame right, the counter and a barista wiping cups out of focus behind her; eyes on his, she exhales, and a late, guilty smile arrives.
7-8s: Insert: her fingers tighten on her bag strap.
```

Header rules:
- Only list the characters who actually appear in this storyboard segment and the bound scene — do not list those who do not appear
- When a prop has a notable appearance, it may be appended to the header (e.g. `; Props: @Letter`)
- The header is its own line, ending with a period
- The second line is `Scene lock:` — copied word for word from the description's `【Scene lock】`: the room's landmarks, each character's exact wardrobe, what they hold, sitting or standing. It must be identical across every segment of the same scene, so never reword or shorten it
- The third line is `Blocking:` — taken from the description's `【Blocking】`: where each person is (frame left/right, foreground/background), how far apart, and who faces whom. Every time slice must stay consistent with it

One time slice per sub-shot, each slice 1-3 seconds and on its own line, with time ranges continuous and adjoining (no overlaps, no gaps). Each slice is two or three concrete sentences, in this order: framing (shot size, angle and height, where the subject sits in the vertical frame, focus); background (what is behind them from this angle — set detail, extras, light sources); performance (where their eyes go, one physical action or emotional tell); then any line spoken, with its delivery, and the listener's reaction.

## Mapping to the Storyboard Description

The `description` is the sole content source of the video_prompt (visuals, actions, dialogue, and narration are all in it). Conversion rules:

- Each `【镜头N】` in the `description` maps to **exactly one time slice of 1-3 seconds** — same order, no omissions, no merging, no new sub-shots
- Dialogue/narration is extracted from the "CharacterName says: "..."" / "Narration: ..." entries inside the corresponding `【镜头N】` and assigned to that sub-shot's mapped segments; **do not invent new dialogue beyond the description**
- Visual actions follow the `description`; `atmosphere` is only used to supplement each segment's lighting, color tone, and mood descriptions

## Within-Segment Structure

Organize each segment's content in this order (items with no content may be omitted, but action/visuals are mandatory):

**Time range + scene @reference + shot size/camera move + character @reference + main action·expression + dialogue/narration + mood and lighting**

- **The first segment must establish the space**: scene + camera position + each character's position and state, so the audience knows at a glance where we are and whom to watch
- **Cuts**: start a post-cut segment with a transition word such as "cut to / cut back", and restate the shot size and subject; cut points should align with the `【镜头N】` structure in the storyboard `description`
- **Shot size/camera move**: one camera state per segment (close shot / medium shot / wide shot / close-up; static / push / pull / pan / tracking); the camera move is continuous within a single sub-shot and may change after a cut
- **Width and cinematic quality**: default to medium and medium-wide framings that keep the performers, their hands and the room in frame; over-the-shoulder two-shots for dialogue; tight close-ups only where the description calls for a peak beat. Describe depth (foreground element, performers, background), the motivated light, and the segment's one deliberate camera move (slow push-in, lateral drift, rack focus)
- **Eyelines and facing**: people who talk to each other face each other and look at each other — write it in the slice ("facing @Alan, eyes on his"). Never leave speakers facing the camera or the same direction unless the description says they avoid eye contact. A character who is frame left stays frame left; conversations alternate shot / reverse shot or over-the-shoulder
- **Action**: one main action per segment, with concrete visible verbs (walk, turn around, look up, clench, pause)
- **All emotion must become visible description**: no abstract words like "he is very sad / the mood is tense" — write it as "he lowers his head, fingers clench the rim of the cup, breathing grows heavier"
- **Voice and reaction**: every line states how it is said — tone, pace, volume ("says, low and dry:", "blurts, too fast:") — and the listener's visible reaction follows in the same slice or the next
- **Dialogue/narration**: write "CharacterName says: "line""; narration as "Narration: content"; a line that cannot be spoken within its slice (about 3 words per second) continues over the next cut as voiceover; a segment without dialogue may note ambient/action sounds (e.g. "machines keep roaring")

## Reference Rules

- `@SceneName` — scene reference; the name must exactly match the location in the scene list
- `@CharacterName` — character reference; the name must exactly match the name in the character list
- `@PropName` — prop reference; the name must exactly match the name in the prop list; reference a prop when it is clearly visible in frame, used, or shown in close-up
- During generation, each `@name` is automatically replaced with the corresponding reference-image marker (e.g. `@Xiaoming` → `@Image1Xiaoming`), so names must match exactly — do not abbreviate or add extra symbols
- **Every segment must have at least one @ reference anchoring the frame**; any segment in which a character appears must @ that character; only reference scenes/characters/props already bound to this storyboard segment

## Timeline Rules

- Number of slices = number of `【镜头N】` sub-shots; each slice is 1-3 seconds and the time ranges must add up exactly to the total segment duration
- Content pacing: the first segment establishes → middle segments advance the action/conflict → the final segment lands on the result or emotional beat

## Prohibitions

- Cross-scene switching, flashbacks (a segment takes place in a single scene only)
- Referencing scene/character names outside the lists
- Abstract psychological description, literary metaphor (the model only recognizes visible imagery)
- Language that does not match the session language directive

## Saving

Call `update_storyboard` to update only this storyboard segment's `video_prompt` field; do not modify any other field, and do not re-breakdown the whole episode.
