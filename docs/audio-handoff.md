# Audio handoff — Waterworld sound design

Attach this in the **dymondiq** (or M3) chat that has API keys. Goal: generate and wire richer ambience + SFX, then differentiate water / shore / land / storm.

---

## TL;DR — how sound works today

| Layer | Source | Stored in repo? | Runtime |
|---|---|---|---|
| Interactive ocean (surface wash, underwater hush, bob, splash, bubbles, heartbeat, hunger growl, shark drone, impact) | **Procedural Web Audio** in `src/audio.ts` | No files | Synthesized every session |
| Optional music/atmosphere beds | **Google Lyria** offline script → MP3 | Expected under `public/audio/` but **missing** | Loaded if present; silent if not |
| ElevenLabs ocean loops / splash | Offline script exists | Would write `public/audio/*.mp3` | **Not loaded by game** |

**There are currently zero audio files in this repo.** What you hear in-game is 100% procedural synthesis. Lyria/ElevenLabs are offline generators only — they do not run in the browser and must never get `VITE_*` keys.

---

## Repo facts (this package: `waterworld-web`)

- Runtime: `src/audio.ts` → `createOceanAudio()`
- Frame mix from `src/main.ts`:  
  `oceanAudio.update(dt, submersion, depth, heave, weather.storm)`  
  Also: `setVitals`, `setSeaWeight`, `setDanger`, `dim`, `impact`
- **Not passed to audio today:** `onLand`, `onRaft`, shore proximity, walk stride, rain, lightning
- Climate (`src/climate.ts`): regimes glass→gale via `storm` 0..1. **No rain particle/audio, no lightning/thunder**
- Shore foam visuals: `src/shore.ts` (no audio hook)
- Raft / build verbs: `src/improvise.ts` (no SFX emit)

### Generator scripts (need keys in parent monorepo)

```bash
npm run audio        # scripts/gen-audio.mjs        → ElevenLabs sound_generation
npm run audio:lyria  # scripts/gen-audio-lyria.mjs  → Google Lyria 3 clip
```

| Env var | Used by |
|---|---|
| `ELEVENLABS_API_KEY` | `npm run audio` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | `npm run audio:lyria` |

Scripts also sniff sibling project `.env*` files (fragile). Prefer real env / dymondiq secrets. ElevenLabs model: `eleven_text_to_sound_v2`. Lyria model: `lyria-3-clip-preview`.

### Files the generators target today

| Path | Generator | Used at runtime? |
|---|---|---|
| `public/audio/surface-bed.mp3` | Lyria | Yes (optional bed) |
| `public/audio/underwater-bed.mp3` | Lyria | Yes (optional bed) |
| `public/audio/surface.mp3` | ElevenLabs | **No** |
| `public/audio/underwater.mp3` | ElevenLabs | **No** |
| `public/audio/bob.mp3` | ElevenLabs | **No** |
| `public/audio/splash.mp3` | ElevenLabs | **No** |

Note: an older ElevenLabs “Respect” key lacked `sound_generation` — that’s why Lyria beds were added. Justin said Google Lyria credits are funded; alternatively a new ElevenLabs key with sound-effects permission.

---

## What’s wrong / missing (product intent)

1. **Land still sounds like open ocean** — dry / inland state never reaches audio.
2. **Rough vs calm** — only gain/filter tweaks from `storm` + `sea.weight`; no distinct character.
3. **Shoreline** — visual lap foam exists; no close lapping / surf proximity bed.
4. **Storms** — gameplay uses `storm` for swim cost, waves, rain-catch fill; **no rain SFX, wind, thunder, or lightning flash**.
5. **Footsteps** — walk `stroke` / `speed` / `moving` exist on player; unused by audio.
6. **Raft / build** — Lash / Climb / Haul / Shove / Mend / sail-tear / wash-off have no foley.
7. **Asset pipeline** — generators orphaned or half-wired; no committed `public/audio/`, no attribution note, no `.env.example`.

---

## Recommended split (do this in the keyed monorepo)

### A. Keep procedural for reactive layers (always)

Keep synthesizing (or lightly drive from samples):

- Surface ↔ underwater crossfade, depth murk, heave bob
- Splash on surface cross
- Bubbles, heartbeat, hunger, shark proximity, combat impact
- Footstep *timing* from stride phase (sample or synth the hit)
- Thunder *timing* after lightning (sample or synth the boom)

Reason: these must react every frame; pure sample beds alone won’t feel right.

### B. Generate & commit beds / one-shots (offline with keys)

**Lyria (atmosphere beds, ~30s loops)** — musical/sparse, not literal SFX:

- `surface-bed.mp3` (already prompted)
- `underwater-bed.mp3` (already prompted)
- `storm-bed.mp3` — tense wind/swell pad under squalls
- `shore-bed.mp3` — soft near-shore atmosphere (optional)

**ElevenLabs Sound Effects** — literal loops / one-shots:

| File | Kind | Purpose |
|---|---|---|
| `rain.mp3` | loop ~12–20s | Storm precipitation bed |
| `wind.mp3` | loop ~12–20s | Squall / gale wind |
| `shore-lap.mp3` | loop ~8–12s | Close waterline lap |
| `heavy-surf.mp3` | loop ~12–20s | Rough open water / whitecaps |
| `calm-surface.mp3` | loop ~12–20s | Glass / fair surface (or keep procedural) |
| `thunder.mp3` | one-shot | Distant→close variants OK as 1–2 clips |
| `foot-sand.mp3` | short | Beach footstep |
| `foot-wood.mp3` | short | Raft / plank footstep |
| `foot-rock.mp3` | short | Spire / rock |
| `lash.mp3` | short | Rope / lash build |
| `wood-knock.mp3` | short | Plank / crate / haul |
| `splash.mp3` | short | Already prompted — **wire it** |
| `sail-flap.mp3` | short/loop | Optional sail stress |

Commit generated MP3s under `public/audio/` (or git-LFS if large). Document prompts + model + date in `public/audio/MANIFEST.md`.

### C. Runtime wiring (code — same repo as game)

1. Expand `AudioFrame` passed from `main.ts`:
   - `submersion`, `depth`, `heave`, `storm`, `seaWeight`
   - `rain` (derive from storm), `shore` (0..1 proximity to `island.shore`)
   - `onLand`, `onRaft`, `walking`, `moving`, `speed`, `stroke`
   - `ground: 'sand' | 'wet-sand' | 'rock' | 'wood' | 'water'`
2. Buses: ambience / music beds / foley / danger — soft land duck of open-ocean wash.
3. Climate: add `rain`, `lightning` flash residual; schedule thunder with distance delay; sky brightens on bolt (`src/sky.ts`).
4. `improvise.ts`: optional `sfx?: (kind, intensity?) => void` on deps — emit on Lash Raft, Climb, Haul Ashore, Shove Off, Mend, sail tear, wash-off, shelter lash, fire light.
5. Load optional samples with existing `tryLoadBed` pattern (content-type gate); fall back to procedural if missing.
6. Either wire ElevenLabs `surface/underwater/bob/splash` **or** delete unused targets from `gen-audio.mjs` so credits aren’t wasted.

### D. Hygiene

- Add `.env` / `.env.*` to `.gitignore`; ship `.env.example` with key names only
- Stop cross-project key sniffing once dymondiq secrets exist
- README Assets section: note AI-generated audio + Google/ElevenLabs attribution as required by ToS
- Never expose provider keys to Vite client

---

## Suggested agent prompt (paste into dymondiq / M3 chat)

```text
Read docs/audio-handoff.md in waterworld-web (or this attached copy).

Context: game audio is procedural Web Audio today; public/audio/ is empty.
We have Google Lyria credits and/or can mint an ElevenLabs key with sound_generation.

Please:
1. Confirm API keys (GEMINI_API_KEY and/or ELEVENLABS_API_KEY with sound_generation).
2. Expand gen scripts for the bed/SFX list in the handoff doc; generate into public/audio/; add MANIFEST.md.
3. Expand src/audio.ts + main.ts so land/shore/storm/rain/footsteps/raft differ; load samples with procedural fallback.
4. Add lightning flash + delayed thunder to climate/sky; rain/wind layers from storm.
5. Emit build/raft SFX from improvise interactions.
6. Wire or remove orphan ElevenLabs clips; update .gitignore + .env.example + README attribution.
7. Smoke with ?storm=1 and a beach/raft spawn; commit generated audio + code.
```

---

## Quick verification checklist

- [ ] Open ocean calm vs `?storm=1` sounds different (rain/wind/thunder, not just louder wash)
- [ ] Walk inland: ocean ducks; sand footsteps
- [ ] Near waterline: shoreline lap present
- [ ] Underwater: hush + optional bed; rain/wind attenuated
- [ ] On raft: wood footsteps; lash/climb/beach/shove one-shots
- [ ] Lightning visible flash; thunder follows with delay
- [ ] No API keys in client bundle / committed secrets
- [ ] `public/audio/` present and referenced files exist or fail soft

---

## Key file map

```
src/audio.ts              # Web Audio director (expand)
src/main.ts               # frame state → audio
src/climate.ts            # add rain + lightning/thunder schedule
src/sky.ts                # lightning flash on lights/horizon
src/improvise.ts          # sfx emits on build/raft verbs
src/shore.ts / island.ts  # shore points for proximity
src/player.ts             # stroke / walking / speed already exist
scripts/gen-audio.mjs     # ElevenLabs SFX
scripts/gen-audio-lyria.mjs
public/audio/             # commit generated assets here (empty today)
```

---

## Decision for Justin

| Choice | Use when |
|---|---|
| **Lyria only** | Atmosphere beds; keep SFX procedural |
| **ElevenLabs only** | Literal rain/wind/shore/foot/thunder/lash; keep beds procedural or skip music beds |
| **Both (recommended)** | Lyria = sparse beds; ElevenLabs = concrete SFX loops/one-shots; procedural = reactive glue |

This cloud agent did **not** generate assets (no keys in the waterworld-only environment). Implementation should happen where `GEMINI_API_KEY` / `ELEVENLABS_API_KEY` resolve.
