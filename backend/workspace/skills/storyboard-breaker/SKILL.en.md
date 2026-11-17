---
name: storyboard-breaker
description: Professional rules for storyboard breakdown — splitting a script into storyboard segments that each carry multiple sub-shots
---

# Storyboard Breakdown Guide

## Core Definition: Storyboard Segment

One storyboard = one **storyboard segment** = one video-generation task.

- This is vertical short-form drama and it is cut fast: each segment is **10-15 seconds** long and internally carries **4-6 sub-shots**. Segments run long; the cuts inside them stay tight. Fewer, longer segments hold continuity better: inside one generation the model keeps the room, wardrobe and positions consistent by itself, and every join between segments is where they drift. So start a new segment only when the scene changes, the staging changes (someone arrives, leaves, sits, stands or moves across the room), or the segment would pass the video model's maximum length — never just because a line or a beat ended
- Cuts between sub-shots **are allowed**: change shot size, angle, or subject, joined with hard cuts
- Sub-shots **never cross scenes**: a segment takes place in a single scene (`scene_id` is a segment-level binding)
- Each sub-shot is **1-3 seconds**, focused on one visual unit (one action, one reaction, one close-up); never hold a sub-shot longer than 3 seconds (except the scene's one held beat, up to 4) — cut to a reaction or a detail instead

## Breakdown Process (Four Steps)

1. Call `read_storyboard_context` to read the script, characters, scenes, props, and existing storyboard summaries. The script may open with a `## Characters` sheet: it is reference for how characters look, not a scene — make no segment from it and do not count its words
2. **Beat identification**: first identify the script's narrative beats — markers such as [Opening] [Trigger] [Climax] [Resolution], or narrative turning points (location changes, rule reveals, emotional eruptions, reversals). Beats shape the sub-shots inside a segment; **a segment boundary is forced only by a scene change or a staging change** — keep consecutive beats in the same staging together in one segment up to the length limit, and do not scatter a causal chain (setup-event-reaction) across different segments
3. **Total-volume anchoring**: target total duration = spoken word count (dialogue + narration in the script) ÷ 2.8 words/second, plus about 1 second for each silent action beat; a whole episode normally lands at 60-120 seconds; segment count ≈ target total duration ÷ 12 seconds, with ±20% tolerance. Do not significantly overshoot — when in doubt, go shorter
4. **Split sub-shots within each segment**: cut sub-shots at action-change points, viewpoint-change points, and subject-change points; after filling in all fields for each segment, call `save_storyboards` to save them in one go

## Pacing-Tier Durations

Determine duration by the segment's function — do not use one size for all:

| Segment type | Duration | Notes |
|---|---|---|
| Hook / transition segment | 5-8 s | The opening beat, traveling, empty shots, environment establishment, transitions |
| Narrative segment | 10-15 s | Regular plot advancement, dialogue |
| Payoff segment | 10-15 s | Close-ups, reveals, emotional eruptions, reversals; a single sub-shot may hold for up to 3 s |

## Dialogue Duration Floor (Hard Rule)

**Segment duration ≥ total word count of dialogue and narration within the segment (the part written in description) ÷ 3 words/second + 1 second**

Dialogue that does not fit in 15 seconds is trimmed or moved to the next segment; never make a segment longer to hold it, and never cram unperformable dialogue into one segment.

## Scene Lock and Continuity (Hard Rules)

Each segment is generated as a separate video that cannot see the others. Anything not restated will change.

- **Scene lock**: every `description` opens with a `【Scene lock】` line before `【Blocking】`. Decide it once per scene and **copy it word for word into every segment with the same scene_id**: the room's fixed landmarks and where they are (bar along the right wall, windows behind, one round table), each character's exact wardrobe from the character sheet (never reworded), what each person holds, and whether they sit or stand
- **State changes carry forward**: when a segment shows a change (someone sits, puts a glass down, takes a jacket off), that segment's lock keeps the old state and every later segment's lock is updated to the new one. Nobody goes from sitting to standing between segments without a sub-shot that shows it
- **Sides are fixed per scene**: a character who is frame left in the scene's first segment stays frame left for the whole scene, in every segment's blocking
- **Each segment starts where the last one ended**: its first sub-shot matches the previous segment's final position, posture and eyeline

## Rhythm (Hard Rules)

- **Open on the hook**: the first sub-shot of the episode is 1-2 seconds and already in motion or mid-line. Never open on a held establishing shot
- **Vary cut lengths**: no three consecutive sub-shots of the same length. Mix quick 1-second reaction cuts with 2-3 second lines
- **One held beat per scene**: at the scene's emotional peak, one sub-shot may hold for up to 4 seconds. Everything else stays 1-3 seconds
- **No dead air at the end**: a segment ends on a line, an action or a reaction of at most 1.5 seconds. Never end on a silent look longer than that; if the beat needs longer silence, make it the held beat and say what happens in it
- **Dialogue fills the segment**: lines are spread across the sub-shots so that speech or meaningful action runs to the last second

## Blocking and Performance (Hard Rules)

Video models place people at random unless told. Every segment must say where people are and where they look.

- **Blocking line**: the `description` opens with `【Blocking】` before `【镜头1】` — who stands or sits where in the space (frame left/right, foreground/background), how far apart, and **who faces whom**. Example: `【Blocking】Chris and Alan stand at the bar, an arm's length apart, turned toward each other; Chris frame left, Alan frame right; Theo behind them, out of focus.`
- **People talking to each other look at each other.** State it in every sub-shot with dialogue: "Chris, facing Alan, eyes on Alan's, says: ...". Never leave two speakers both facing the camera or the same direction unless the script says they avoid eye contact — and then say so explicitly
- **Keep screen direction**: once a character is frame left, they stay frame left through the segment (do not cross the line). Conversations use shot / reverse shot and over-the-shoulder shots: "over Alan's right shoulder onto Chris"
- **Every sub-shot names**: shot size, whose face we see, where their eyes go, and one physical action
- **Emotion is physical and specific**: one visible tell per sub-shot — a swallow, a breath held, a glance to the lips, fingers tightening on a glass, a smile that arrives late. No abstract words ("nervous", "tension")
- **Stay a little wide by default**: most sub-shots are medium or medium-wide — waist-up or knees-up, with both people of an exchange, their hands and the key action in frame, and the room visible around them. Use over-the-shoulder two-shots instead of single close-ups for dialogue. Save tight close-ups and inserts for the one or two peak beats of a segment
- **Cinematic quality**: compose in depth (a foreground element, the performers, a living background); light with motivated sources (practical lamps, window light, rim light separating people from the background); give each segment one deliberate camera move (slow push-in, lateral drift, a rack focus between two people, a handheld breath) rather than a locked-off frame; shallow focus, restrained film color
- **Framing**: shot size, camera angle and height, where the subject sits in the vertical frame, and focus ("tight close-up at eye level, Chris on the left third, background soft")
- **Background**: what is behind the subject in this exact angle — set detail, what extras are doing, the light sources. A reverse shot shows the opposite side of the room; keep it consistent with the scene across cuts
- **Voice**: every line carries its delivery — tone, pace and volume ("says, low and dry, almost under his breath:", "blurts, too fast:"). Never a bare "says"
- **Reaction**: every line gets a visible reaction from the listener, in the same sub-shot or the next cut (a blink held too long, a breath out through the nose, a smile he tries to hide)
- **Cut for emotion**: cover each line of dialogue with the speaker, then cut to the listener's reaction; add inserts (hands, a glass, eyes) on the beats that matter. A two-person exchange is at least speaker → reaction → speaker, never one held two-shot

## Shot Elements

1. **Shot title**: a 3-5-character summary of the segment's core content (e.g. "Nightmare Awakening")
2. **Time**: specific time of day + lighting description
3. **Location**: full scene description + spatial layout + environmental details
4. **Shot size**: the dominant shot size of the segment; for multi-size segments write a combination, e.g. "medium shot + close-up"
5. **Angle**: eye-level / low angle / high angle / side / back
6. **Camera move**: static / push-in / pull-back / pan / tracking / dolly (different sub-shots within a segment may differ)
7. **Visual description** `description`: open with the `【Scene lock】` line and the `【Blocking】` line, then describe sub-shot by sub-shot as `【镜头1】…【镜头2】…` what the audience actually sees and hears — the visuals (who + specific action + body-language details + expression) come first; when a sub-shot has dialogue, write it inside the corresponding `【镜头N】` as "CharacterName says: "line"", and narration as "Narration: content"
8. **Visual result** `result`: the immediate consequence at the end of the segment + visual details
9. **Atmosphere** `atmosphere`: lighting + color tone + sound + overall mood
10. **Duration** `duration`: total segment duration 10-15 seconds (never above the video model's maximum; 5-8 only for a standalone hook or transition) (4 is the shortest most video models can make), and it must satisfy the dialogue duration floor
11. **Scene binding**: if it can be matched to an existing scene, `scene_id` must be filled in
12. **Character binding**: fill in `character_ids`, binding 0 to multiple characters involved in this segment
13. **Prop binding**: fill in `prop_ids`, binding 0 to multiple key props appearing in this segment

## Scene Binding Rules

- Prefer the `scenes` returned by `read_storyboard_context`
- When `location + time` can be clearly matched, the correct `scene_id` must be filled in
- Do not fabricate scene IDs that do not exist
- If the script content clearly falls within an existing scene, do not create a duplicate new scene description

## Character Binding Rules

- `character_ids` must be chosen from the character list returned by `read_storyboard_context`
- A segment may have no characters, or may bind multiple characters
- Any character with a clear appearance in the segment — seen, acting, or speaking — should be bound
- Pure-environment segments, empty shots, and object close-ups may pass an empty array

## Prop Binding Rules

- `prop_ids` must be chosen from the prop list (`props`) returned by `read_storyboard_context`
- When a prop is used by a character, handed over, shown in close-up, or clearly visible in frame and meaningful to the narrative, it must be bound to that segment
- Prop close-up segments (without characters) should also bind the prop; `character_ids` may be empty
- Do not bind background items or set dressing irrelevant to the plot; segments with no props pass an empty array
- Bound props serve as reference images for video generation (white-background product shots), keeping the prop's appearance consistent across segments

## Quality Requirements

- `description` should be human-readable, describing sub-shot by sub-shot what the audience actually sees and hears; dialogue/narration is written directly inside the corresponding `【镜头N】`
- `image_prompt` should highlight the single-frame composition, character appearance, environment, and lighting (corresponding to the segment's first sub-shot)
- `bgm_prompt` and `sound_effect` may be concise phrases, but must not be as vague as just "tense" or "sad"
- To make adjustments, call `update_storyboard` to modify the specific segment
