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
glow. Weather runs in spells rather than on a timer: long fair stretches, a
breezy afternoon, and now and then something that closes over you — swell
climbs, the sky shuts, every stroke costs more. Fair weather holds about nine
tenths of a run, fronts roll in slowly enough to read, and it never turns foul
twice in a row. Glass-offs come with the settled sky and are the dive windows.

And every few minutes something large takes one circle through your water and
leaves. Until it doesn't.

## The wreck's depth

The Wanderer gives up her past in dives. A galley knife lies on the bow deck at
~13 m — it cuts rope. One deck below that a hold door has swelled shut on the
ship's immersion suit; force it with the knife and the cold stops being the
thing that ends every run. A soldered bread tin rolled into the same corner is
a meal. The mate's chest sits roped shut on the sand by the torn
stern at ~24 m, where the light gives up. Inside: an oilskin pouch that gives
back the first memory of who you were, and the mate's spear. The master's log
lies out on the sand beside her broken ribs, and it answers the pouch. Once armed, the
shark's slow circle tightens, banks and aims (a short telegraph you can read),
then commits to a run — jab it with the spear on the telegraph or the rush and
it turns; let the run connect and it takes a piece of you. One wound shows as
Bleeding until it clots. A second bite, while it hasn't, is the one the ocean
keeps.

The surface tells its own story: a provision crate still floating by the wreck
is a first meal; after that, hang still underwater and grab fish by hand — keep
them raw to eat, or cook them once you've kindled a fire. The debris that drifts
by — planks, barrels, crates, rope, canvas, bottles, cans — goes in the stash, and from there
you improvise: a lean-to you can rest under, a fire to cook or smoke fish (and
carry as a brand at night), a rain-catch, a raft you Climb aboard and fit with
sail, rail, locker, oar, floats and a wider deck, and ashore a seat, drying rack,
signal smoke, dug rain hollows and tin drips. Shelters are fashioned in stages —
Raise a frame, Lash walls, Roof with fronds or a canvas tarp (or scrap bottles),
then Rest once covered. Barrels plant as cisterns or sit under the eaves and
catch rain. Island wood and grass are workable — Pull palm fronds, Break
driftwood, Fell a palm with the knife, Pull grass into rope. Caught
fish show in the Pack until you eat, cook, smoke, or hang them to dry. A heavy
stash slows the swim; a plank, barrel or bottle under the arm buys a little float; Drop
sheds the heaviest piece when nothing else is in reach. The sea itself carries
you on a swell-set current — glass-offs are dive windows, and a foul deck can
wash you over the side. Nothing is the "right" path; see [`docs/paths.md`](docs/paths.md).
Opening-run math: `npm run sim:starts`.

## Dry ground

Two places in the world are not the ocean.

The nearer one is a reef spire off the wreck's port bow, standing a few metres
clear of an ordinary sea. It is cliff on every bearing but one, where a long
shoulder shelves down far enough to climb. Sitting on it gives heat back at
about half the rate dry sand does, and a gale still comes over the top — but it
turns the wreck from a raid into somewhere you can work.

The far one is a volcanic island ~1.2 km off the spawn heading's right
shoulder: beach, scrub, cliffs and palms. The spawn-facing shore shelves into
a landing cove — palm grove, tide wrack, and a worn path inland — so landfall
is a beach you can work, not a cliff. Wade far enough up and you climb out
of the swim into a walk — slope-aware, with real gravity off the ledges. Cliffs
past ~50° refuse you; a storm face that closes over your head knocks you back
into the sea. Coconuts lie on the sand, crabs scuttle the wash (grab one when
you're quick enough), rain stands in hollows in the rock above the beach, and
inland a small cairn holds rope someone left under the stones. Driftwood
breaks into planks, palms fell once you have the knife, and long grass twists
into rope. Gulls, lizards and butterflies keep the place from reading empty.
Bring salvage ashore and you can improvise a frame and fashion it into a
shelter (walls, leaf or canvas roof), a fire, a rain-catch, a seat, a drying
rack, a signal on the ridge, dig a hollow for rain, hang a tin drip, plant a
barrel as a cistern — a camp you made, not one the world planted for you.

## Controls

- **Touch / on-screen:** left stick move · drag anywhere to look · ▲▼ depth ·
  action button appears when something is in reach (take, eat, drink, lash,
  dig, chop, cook, take/plant fire — same verbs as desktop **F**)
- **Desktop:** WASD · click for mouse-look · Space/E up · Shift/Q dive · **F**
  to take, eat, drink, open, pry, cut, jab, lash, dig, kindle or cook

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
- `npm run shot:shelter` — checks the climbable spire, the immersion suit, the
  hold's deep finds and that a weather spell holds. Needs `npm run dev`.
- `npm run sim:starts` — Monte Carlo over opening paths (wreck loot, suited
  crossing, spire camp, island swim) plus the weather balance. See
  `docs/paths.md` for how to read it.
- `npm run icons` — rasterises `public/favicon.svg` into the install icons.
- `?x=&z=&yaw=&pitch=&depth=` spawns anywhere.
- `?hour=22` starts at night · `?storm=1` locks a squall · `?calm=1` pins a
  glass-off · `?breath=0.3` / `?food=0.2` / `?wound=1` pre-set vitals ·
  `?shark=8` summons a pass · `?knife=1` / `?spear=1` start armed ·
  `?suit=1` starts in the immersion suit · `?commit=1` every armed pass runs at you.
- In dev, `window.ww` exposes player, vitals, salvage, climate, shark and the
  interaction registry; `__spots` marks the loot spots.

## Assets

Everything in the scene is generated — hands (own Blender script → GLB, with a
procedural fallback), swimmer, ocean, wreck, textures. The app icon is our own
SVG, rasterised by `npm run icons`. No third-party models or textures, so there
are no licence restrictions on commercial use.

Brain notes: `../agenticiallyjus/projects/waterworld.md`
