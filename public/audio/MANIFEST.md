# Audio assets

Offline-generated beds and SFX. The game loads these from `src/audio.ts`
and falls back to procedural Web Audio if a file is missing.

## Generated (2026-08-03)

### Lyria beds (not currently played)
The in-world mix is the procedural ocean plus the SFX below; these four were
only ever audible behind the old Pack menu, so `src/audio.ts` no longer loads
them. They are kept in case we want a very quiet in-world bed later.

| File | Size |
|---|---|
| `surface-bed.mp3` | ~727 KB |
| `underwater-bed.mp3` | ~726 KB |
| `storm-bed.mp3` | ~727 KB |
| `shore-bed.mp3` | ~727 KB |

### ElevenLabs SFX
| File | Size |
|---|---|
| `rain.mp3` | ~251 KB |
| `wind.mp3` | ~251 KB |
| `shore-lap.mp3` | ~189 KB |
| `heavy-surf.mp3` | ~251 KB |
| `thunder.mp3` | ~44 KB |
| `foot-sand.mp3` / `foot-rock.mp3` | ~9 KB each |
| `splash.mp3` | short one-shot |

## Regenerate

```powershell
npm run audio:lyria -- --force
npm run audio -- --force
npm run audio -- --only rain,thunder
```

Keys live in `.env` (never commit). See `docs/audio-handoff.md`.
