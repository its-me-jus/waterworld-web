# WaterWorld (web)

A calm first-person ocean to drift and wander in. Gerstner swell, a sky that
takes its time, a wreck on a reef, and an island on the horizon. Built with
Vite + Three.js.

There is nothing to survive and nothing to collect. You can follow the coast
at your own pace or choose a place and time from the World button.

## The world

- **The arrival.** Glide toward the landing cove under a parachute, or choose
  **Begin on the beach**. Clouds leave a clear window onto the island. A brief
  title and contextual movement hints fade away as you settle in.
- **The lagoon.** Small resident shoals turn through the shallows between the
  landing beach and the reef wreck. Their patches follow the seabed and tide;
  they are places to discover, not fish attached to the camera.
- **The tidal caves.** Two tide pools open in a basalt outcrop off the landing
  cove. Choose **World → Tidal caves** and dive about six metres. The pale
  channel leads straight to the second pool. Take the left arch past the
  shrimp to surface inside a hidden air chamber. Listen for dripping water,
  then dive through its far arch to rejoin the second pool and the sea.
  At night, glowworms light the ceiling and blue plankton wakes around your
  hands. Release the dive control to hold depth in either passage.
- **The ocean.** Real swell you ride rather than fight. Glass-offs come with the
  settled sky; a squall now and then turns the water grey and brings rain and
  distant thunder, but it never gets worse than atmosphere.
- **The day.** A full day is about 20 minutes. Dawn, noon and dusk each have
  room to be looked at; the evening lingers gold and rose before the stars come
  out. Jellies and coral glow after dark.
- **The tide.** Two per day. The foreshore bares and floods, and seals haul out on the cove rocks at low water — fish gather under
  them while they swim.
- **The wreck.** The *Wanderer* lies on a reef off the spawn heading, with a
  climbable rock spire beside her. Swim over her, dive her hull, drift through
  the kelp.
- **The island.** A volcanic island about a kilometre out: a landing cove, a
  palm grove, scrub, cliffs and a worn path inland. Wade up the beach and you
  climb out of the swim into a walk. Gulls, lizards, crabs and butterflies keep
  it alive.
- **The wildlife.** A humpback and her calf cross the deep channel, rising now
  and then to blow a tall mist into the wind before they sound. Spotted eagle
  rays glide in formation over the lagoon sand, blacktip reef sharks patrol both
  wrecks, and flying fish break from the swell. White-tailed tropicbirds wheel
  over the cove; dragonflies dip the inland rain pools. After dark, fireflies
  drift under the palms and every stroke stirs blue sparks in the water.
- **Nothing is signposted.** The wreck, the spar buoy partway across, and the
  island are all found by looking.

A single quiet line of text appears now and then to name something the world is
already doing ("The tide is turning."). That is the whole interface.

## Controls

- **Touch:** left stick to swim · drag anywhere to look · ▲ rise / ▼ dive
- **Desktop:** WASD to swim · click for mouse-look · Space/E rise · Shift/Q dive
- **Under the canopy:** A/D steer · W/S speed/brakes · Space (touch: Flare)
  for a soft landing. Enter begins on the beach.
- **Help:** tap **?** or press **H** to recover the controls for where you are.
  Touch controls change with flight, walking and swimming; resizing or rotating
  the screen updates the interface.
- **World:** tap **World** beside Help or press **G** during mouse-look. Choose
  dawn, noon, dusk or night, or set the clock with the slider. Pick a destination
  to arrive there on foot or swimming. Time continues from the hour you choose.
- **Motion:** the system's reduced-motion preference removes extra head bob,
  sway and camera banking while retaining the physical sea.
- **Detail:** the World panel shows whether this machine is drawing the full
  island or the lighter one, and why, with **Auto / Full / Lighter** to
  overrule it (the world reloads). Auto times the graphics chip for a few
  milliseconds at start: phones, small processors and slow built-in graphics
  get the lighter island. Either way the picture's resolution is trimmed live
  to hold the frame rate, and restored when there is room.

## Local

```powershell
npm install
npm run dev
```

## Dev

- `?quality=full|light|auto` picks the island budget for one load;
  `?governor=0|1` turns the live resolution scaling off or on. Automated runs
  (the screenshot scripts) get the full island with the governor off, so shots
  stay comparable; `?quality=auto&governor=1` tests the real behaviour.
- In a dev build `ww.quality` and `ww.governor` (console) show what was chosen
  and the current resolution scale.

- `node scripts/check-coastmesh.mjs` — checks tidal-band surface accuracy,
  upward face winding, finite normals and bounded phone/desktop geometry.
  Uses Node's built-in TypeScript support (Node 22.18+).
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
