# Audio assets

Offline-generated beds and SFX. The game loads these from `src/audio.ts`
and falls back to procedural Web Audio if a file is missing.

## Generated (2026-08-03)

### Lyria beds
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
| `foot-sand.mp3` / `foot-rock.mp3` / `foot-wood.mp3` | ~9 KB each |
| `lash.mp3` / `wood-knock.mp3` / `splash.mp3` / `sail-flap.mp3` | short one-shots |

## Regenerate

```powershell
npm run audio:lyria -- --force
npm run audio -- --force
npm run audio -- --only rain,thunder
```

Keys live in `.env` (never commit). See `docs/audio-handoff.md`.
