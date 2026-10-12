# Audio handoff — Waterworld sound design

Runtime audio is **procedural Web Audio** in `src/audio.ts`, with optional
MP3 beds/SFX under `public/audio/` loaded when present.

## What's in the repo now

Generated assets (2026-08-03) live under `public/audio/` — see
`public/audio/MANIFEST.md`. SFX (rain, wind, thunder, footsteps, splash, shore lap, …) are committed. The
four Lyria beds are also in the repo but are not currently played in-world.

If a file is missing at runtime, `createOceanAudio()` falls back to synthesis.

## Regenerate (needs API keys — never commit `.env`)

```bash
npm run audio:lyria -- --force
npm run audio -- --force
```

| Env var | Used by |
|---|---|
| `ELEVENLABS_API_KEY` | `npm run audio` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `npm run audio:lyria` |

## Runtime wiring

`src/audio.ts` → `createOceanAudio()` mixes the surface/underwater ocean chain,
rain, wind, shore proximity, footsteps, and thunder after lightning, driven
once per frame from `main`.
