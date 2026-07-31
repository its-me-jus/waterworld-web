# WaterWorld (web)

First-person open-ocean survival — Gerstner waves, swim and island-walk
controls, underwater murk, and a body that keeps score. Built with Vite + Three.js.

## The run

An open-ocean survival sandbox. There is no objective, no quest marker and no
save — you last as long as you can keep breath, warmth, water and food off the
floor, and when you drown you start again in the same water.

Nothing is signposted. The wreck, the drifting salvage, and the island on the
horizon are all found by looking. Actions only announce themselves once
whatever they act on is already within reach.

The body is read two ways at once: quiet meters when they're worth worrying
about, and diegetic cues — a closing vignette on a held breath, a heartbeat,
a growl, slower arms, whispers that only name what you already feel.

## The ocean

The day turns (~8 real minutes). Night drains warmth faster and the jellies
glow. Storm squalls roll through every few minutes — swell climbs, the sky
closes, swimming costs more. Under all of it the sea breathes slower: seasons
and sudden glass-off calm spells, which are the natural dive windows.

And every few minutes something large takes one circle through your water and
leaves. Until it doesn't.

## The wreck's depth

The Wanderer gives up her past in dives. A galley knife lies on the bow deck at
~13 m — it cuts rope. The mate's chest sits roped shut on the sand by the torn
stern at ~24 m, where the light gives up. Inside: an oilskin pouch that gives
back the first memory of who you were, and the mate's spear. Once armed, the
shark's slow circle tightens, and about two passes in three it commits to a run
at you — jab it with the spear inside ~4 m and it turns; let the run connect
and it takes a piece of you. One wound clots. A second bite, while it hasn't,
is the one the ocean keeps.

The surface tells its own story: a provision crate still floating by the wreck
is a first meal; after that, hang still underwater and grab fish by hand. The
debris that drifts by — planks, barrels, crates, rope, canvas — goes in the
stash. What that stash is *for* is still open — see the path options in
[`docs/paths.md`](docs/paths.md). Opening-run math: `npm run sim:starts`.

## The island

A volcanic island ~1.2 km off the spawn heading's right shoulder: beach, scrub,
cliffs and palms. Wade far enough up the beach and you climb out of the swim
into a walk — slope-aware, with real gravity off the ledges. Cliffs past ~50°
refuse you; a storm face that closes over your head knocks you back into the
sea. Coconuts on the sand are worth the crossing.

## Controls

- **Touch / on-screen:** left stick move · drag anywhere to look · ▲▼ depth ·
  action button appears when something is in reach
- **Desktop:** WASD · click for mouse-look · Space/E up · Shift/Q dive · **F**
  to take, eat, drink, open, pry, cut or jab

## Live

- **Phone / share:** https://waterworld-web.vercel.app
- **Repo:** https://github.com/its-me-jus/waterworld-web

## Local

```powershell
npm install
npm run dev
```

## Dev

- `npm run shot` — headless vantage points into `shots/`, fails loudly on
  console or shader errors. Needs `npm run dev` running.
  `SHOT_BASE=http://localhost:5174` follows the dev server if it moved port;
  `SHOT_ONLY=storm,night` re-shoots matching views (comma-separated).
  `scripts/shot-survival.mjs` / `shot-salvage.mjs` cover the shark and loot arcs.
- `npm run sim:starts` — Monte Carlo over opening paths (wreck loot, island
  swim, linger/camp). See `docs/paths.md` for how to read it.
- `?x=&z=&yaw=&pitch=&depth=` spawns anywhere.
- `?hour=22` starts at night · `?storm=1` locks a squall · `?calm=1` pins a
  glass-off · `?breath=0.3` / `?food=0.2` / `?wound=1` pre-set vitals ·
  `?shark=8` summons a pass · `?knife=1` / `?spear=1` start armed ·
  `?commit=1` every armed pass runs at you.
- In dev, `window.ww` exposes player, vitals, salvage, climate, shark and the
  interaction registry; `__spots` marks the loot spots.

## Assets

Everything in the scene is generated — hands (own Blender script → GLB, with a
procedural fallback), swimmer, ocean, wreck, textures. No third-party models or
textures, so there are no licence restrictions on commercial use.

Brain notes: `../agenticiallyjus/projects/waterworld.md`
