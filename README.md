# WaterWorld (web)

A calm first-person ocean to drift and wander in. Gerstner swell, a sky that
takes its time, a wreck on a reef, and an island on the horizon. Built with
Vite + Three.js.

There is nothing to survive and nothing to collect. No meters, no score, no
menus — just somewhere to move around.

## The world

- **The ocean.** Real swell you ride rather than fight. Glass-offs come with the
  settled sky; a squall now and then turns the water grey and brings rain and
  distant thunder, but it never gets worse than atmosphere.
- **The day.** A full day is about 20 minutes. Dawn, noon and dusk each have
  room to be looked at; the evening lingers gold and rose before the stars come
  out. Jellies and coral glow after dark.
- **The tide.** Two per day. The foreshore bares and floods, tide pools open and
  close, and seals haul out on the cove rocks at low water — fish gather under
  them while they swim.
- **The wreck.** The *Wanderer* lies on a reef off the spawn heading, with a
  climbable rock spire beside her. Swim over her, dive her hull, drift through
  the kelp.
- **The island.** A volcanic island about a kilometre out: a landing cove, a
  palm grove, scrub, cliffs and a worn path inland. Wade up the beach and you
  climb out of the swim into a walk. Gulls, lizards, crabs and butterflies keep
  it alive.
- **Nothing is signposted.** The wreck, the spar buoy partway across, and the
  island are all found by looking.

A single quiet line of text appears now and then to name something the world is
already doing ("The tide is turning."). That is the whole interface.

## Controls

- **Touch:** left stick to swim · drag anywhere to look · ▲ rise / ▼ dive
- **Desktop:** WASD to swim · click for mouse-look · Space/E rise · Shift/Q dive

## Local

```powershell
npm install
npm run dev
```

## Dev

- `npm run shot` — headless vantage points into `shots/`, fails loudly on
  console or shader errors. Needs `npm run dev` running.
  `SHOT_BASE=http://localhost:5174` follows the dev server if it moved port;
  `SHOT_ONLY=dusk,night` re-shoots matching views (comma-separated).
- `npm run shot:look` — the look-around check.
- `npm run icons` — rasterises `public/favicon.svg` into the install icons.
- `?x=&z=&yaw=&pitch=&depth=` spawns anywhere.
- `?hour=18` starts at that time of day · `?storm=1` locks a full squall ·
  `?calm=1` pins a glass-off.
- In dev, `window.ww` exposes the player, camera, climate, sea, island, wreck,
  shore, littoral and underwater world.

## Assets

Everything in the scene is generated — hands (own Blender script → GLB, with a
procedural fallback), swimmer, ocean, wreck, textures. The app icon is our own
SVG. No third-party models or textures, so there are no licence restrictions on
commercial use.

**Audio** is mostly live Web Audio (`src/audio.ts`): surface/underwater
crossfade, shore lap, rain and wind, footsteps, lightning→thunder. Optional MP3
SFX under `public/audio/` layer in when present (`npm run audio` — see
`public/audio/MANIFEST.md` and `docs/audio-handoff.md`). AI-generated clips
credit ElevenLabs per their terms; keys stay in `.env`, never in the client.
