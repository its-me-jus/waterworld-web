# Audio handoff — Waterworld sound design

Runtime audio is **procedural Web Audio** in `src/audio.ts`, with optional
MP3 beds/SFX under `public/audio/` loaded when present.

## What's in the repo now

Generated assets (2026-08-03) live under `public/audio/` — see
`public/audio/MANIFEST.md`. Beds (surface / underwater / storm / shore) and
SFX (rain, wind, thunder, footsteps, build foley, splash, …) are committed.

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

`src/audio.ts` → `createOceanAudio()` mixes surface/underwater beds, rain,
wind, shore proximity, footsteps, thunder after lightning, and build/raft foley
hooks from `improvise` / `main`.
