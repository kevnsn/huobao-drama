---
name: script-rewriter
description: Methodology and rules for rewriting a novel into a formatted script
---

# Script Rewriting Guide

## Rewriting Principles

1. **Preserve the core plot**: do not change the main storyline or character relationships
2. **Strengthen visual quality**: turn narrative prose into visualizable scene descriptions
3. **Dialogue-driven**: use dialogue to advance the plot and reduce narration
4. **Pacing control**: keep each scene at 10-20 seconds — 1-3 action beats and at most 3 lines of dialogue. This is vertical short-form drama: the first scene is the hook, and every scene must turn the story
5. **Concise by default**: one sentence per action beat; a line of dialogue is 12 words or fewer; cut greetings, small talk, repeated information, and anything the picture already shows. Narration is a last resort, one short sentence at a time
6. **No camera language**: no shot sizes, angles, or camera moves — those belong to the storyboard-breakdown step

## Formatted-Script Format

```
## S01 | INT · Coffee Shop | Dusk

Dusk light pours through the floor-to-ceiling windows into the coffee shop; steam rises from coffee cups on the counter.

Xiaoming sits alone in a corner booth, head down over his phone, looking somewhat anxious.

The doorbell chimes as Xiaohong pushes the door open. She sees Xiaoming and walks over with a smile.

Xiaohong: (smiling) Have you been waiting long?
Xiaoming: (looking up) Not really, just got here.
```

### Format Rules

- `## S<number> | INT/EXT · Location | Time period` — scene heading
- Action description in natural paragraphs — no camera language of any kind
- `CharacterName: (state/expression) line content` — dialogue format

### Content-Volume Reference

The formatted script should be no longer than the original content, and usually shorter: compress exposition into one visible action or one line. A whole episode normally plays in 60-120 seconds, which is roughly 150-300 spoken words — if the source is longer, keep the hook, the turns, and the payoff, and drop the rest. Never expand.

## Rewriting Steps

1. First call `read_episode_script` to read the original content
2. Analyze the content structure (the proportions of dialogue, narration, and inner monologue)
3. Call `rewrite_to_screenplay` to perform the rewriting
4. Check the rewritten result and confirm it conforms to the formatted-script format
5. Call `save_script` to save the final result

## Notes

- Inner monologue can be converted into character expressions/actions or voiceover
- Compress long narrative passages into a few short scenes; do not dramatize every sentence of the source
- Make sure every scene has a clear emotional turning point
- Keep each character's language style consistent
- Scene numbers increase consecutively (S01, S02, S03...)
- Time periods must be specific (dusk, late night, early morning) — do not write a vague "daytime"
