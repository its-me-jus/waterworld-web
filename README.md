# WaterWorld (web)

First-person open-ocean survival — Gerstner waves, swim and island-walk
controls, underwater murk, and a body that keeps score. Built with Vite + Three.js.

## The run

An open-ocean survival sandbox. The one score it keeps is **days alive** —
the quiet counter at the top of the screen, turning over each midnight you
are still breathing. Sleeping through a night is how you bank one: a roof
you raised yourself, dawn, Day 2. Death scores the run in days and keeps
your longest drift; there is no quest marker, only the count.

A living camp (stash, builds, where you stood) persists in the browser so
closing the tab does not wipe a shelter you made; death, or **Start again**
in the Pack, clears it and begins a new run.

Nothing is signposted. The wreck, the drifting salvage, and the island on the
horizon are all found by looking. Actions only announce themselves once
whatever they act on is already within reach.

The body is read two ways at once: quiet meters when they're worth worrying
about, and diegetic cues — a closing vignette on a held breath, a heartbeat,
a growl, slower arms, whispers that only name what you already feel. And it
keeps a tired timer: a day of wakefulness spends your Energy, hard work
spends it faster, and only sleep buys it back — a nap takes the edge off, a
night under a roof (your own hall sleeps best) brings you back whole.

## The ocean

The day turns (~8 real minutes). Night drains warmth faster and the jellies
glow — coral gardens take the same soft light. Weather runs in spells rather than on a timer: long fair stretches, a
breezy afternoon, and now and then something that closes over you — swell
climbs, the sky shuts, every stroke costs more. Fair weather holds about nine
tenths of a run, fronts roll in slowly enough to read, and it never turns foul
twice in a row. Glass-offs come with the settled sky and are the dive windows.

And every few minutes something large takes one circle through your water and
leaves. Until it doesn't.

## The wreck's depth

The Wanderer gives up her past in dives. A galley knife lies on the bow deck at
~13 m — it cuts rope. One deck below that a hold door has swelled shut on the
ship's immersion suit and a sealed diving lantern; force it with the knife and
the cold stops being the thing that ends every run. Take the lantern for night
dives — a local beam in the murk, not a free pass on warmth or breath. A soldered bread tin rolled into the same corner is
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
is a first meal; after that, hang still underwater and the schools drift back
in — grab fish by hand, or answer them properly with the mate's spear (reach
and near-sure odds instead of a coin toss). Set a bottle **fish trap** in the
shallows and the tide stocks it while you work; Check it when you pass again.
Keep fish raw to eat, or cook them once you've kindled a fire. Fashion a
**fishing rod** (plank + rope) to Cast from shore into schools you can see, or
**Lash a cast net** (rope + fronds) and Scoop the wash while wading. The sea
itself keeps a **tide** — two per day — so limpets and mussels on the foreshore
bare at low water and drown at high; **tide pools** trap anemones, periwinkles
and starfish until the sea returns — high water flushes them, rain and a lively
swell refill life for the next low; urchins and coral cling to a **drop-off wall**
you can swim along past the shelf; between wreck and island that wall plunges
into an **abyss** (blue goes black); oysters and coral snails want a dive on the
gardens (which glow at night). Seals haul out on cove rocks when the
tide is low and slip when it makes — while they swim, fish schools thicken
under them. The debris that drifts
by — planks, barrels, crates, rope, canvas, bottles, cans — goes in the stash, and from there
you improvise: a lean-to you can rest under, a fire to cook or smoke fish (and
carry as a brand at night), a rain-catch, a raft you Climb aboard and fit with
sail, rail, locker, oar, floats and a wider deck — sit the thwart, rest under
sail, take the **helm** from the stern and steer her where you look, **Drop
anchor** when the set would take her, Haul ashore and Shove off, Mend a sail a
gale tore — and ashore a seat, drying rack,
signal smoke, dug rain hollows and tin drips. A spar buoy stands partway to the
island so the crossing has a shape. Shelters are fashioned in stages —
Raise a frame, Lash walls, Roof with fronds or a canvas tarp (or scrap bottles),
then Rest once covered. And a shelter grows if you keep giving it mornings:
**Raise the ridge** turns the crawl-in frame into a hut you can stand inside,
then **Add a room** bolts another bay on, up to three — each stage is hours of
work on the day clock, and the body pays for the labour. Barrels plant as cisterns or sit under the eaves;
Fill them from rock pools or a rain-catch (a can scoops cleaner). A frond mat
warms sleep; a crate ashore stows gear like the raft locker. Island wood and
grass are workable — Pull palm fronds, Break
driftwood, Fell a palm with the knife, Pull grass into rope. Caught
fish show in the Pack until you eat, cook, smoke, or hang them to dry. A heavy
stash slows the swim; a plank, barrel or bottle under the arm buys a little float; Drop
sheds the heaviest piece when nothing else is in reach. The sea itself carries
you on a swell-set current — glass-offs are dive windows, and a foul deck can
wash you over the side. Nothing is the "right" path; see [`docs/paths.md`](docs/paths.md).
Opening-run math: `npm run sim:starts`.

## Your own two hands

Past the fixed recipes there is carpentry — freeform pieces that snap to a
grid so you can architect your own base instead of inheriting one:

- **Lay platform** — a stilt deck tile. On dry sand, in the wash, or piled
  over the shallows. Stand on a deck and face the next empty square to join
  another — a faint ghost shows where it lands. Tiles chain flush into docks,
  piers and stilt houses.
- **Raise wall** — hangs on the edge of the tile you're on (or facing), or
  stands free as a windbreak. Solid: it stops the wind and it stops you.
- **Hang door** — the wall you walk through. It blocks its cheeks and lets
  the middle pass, and still counts toward a closed-in room.
- **Pitch roof** — plank-and-frond lid over a tile. A roofed, walled tile is
  a bedroom: **Sleep** there and the night skips to dawn like any lean-to —
  which is how the day counter turns. Bigger houses are more bays — each
  platform still takes its own lid.
- **Stack woodpile** — shore stockpile for planks (Stow / Fetch) so a long
  build doesn't depend on swimming every stick.
- **Strike** — every piece dismantles for a full refund. Rethink freely.

If the world prompt is busy (Strike, Sleep, Fire), Pack → **Camp** still lists
every carpentry recipe that's ready where you're standing.

**Raft:** Climb aboard · on a phone **tap POLE** (toggle — stays labeled while
you're on deck, including beached / anchored; reads **POLE ON** when engaged) +
MOVE to drive · face a fitting or open **Pack → Camp → Raft** for sail, rail,
locker, oar, floats, **cask** (rain water for the crossing), **Stow Food**
(smoked / raw for the voyage), and **Lash Deck** (up to five times) · **Shove**
if she's beached (action button or Pack → Raft) · with sail, stand aft and tap
**HELM**. A gale can tear the sail — or wash an unrailed oar overboard.

**Base life:** on a roofed, closed-in platform **Lay Bed** for softer Sleep;
**Hang Shelf** on a wall for a small shore stash. Rest / Sleep closes the eyes
briefly (lids meet, dawn opens them) instead of a hard cut.

Fires burn on platform decks, rain gear and lockers work the same ashore, and
the whole base persists with the rest of the camp.

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

- **Touch (primary):** left stick move · drag anywhere to look · ▲ rise / ▼ dive ·
  action button appears when something is in reach (same verbs as desktop **F**).
  Pack opens from the hub button.
- **Raft on a phone:** Climb aboard · tap **POLE** to toggle drive on (reads
  **POLE ON**) · push MOVE to go · tap POLE again to walk the deck · face a
  fitting for **Lash Deck / Rail / Sail…** (or Pack → Camp → Raft) · stand aft
  with a sail and tap **HELM** · **Shove** / **Haul** / **Anchor** also live
  under Pack → Camp → Raft
- **Desktop:** WASD · click for mouse-look · Space/E up · Shift/Q dive · **F**
  to take, eat, drink, open, pry, cut, jab, lash, dig, kindle or cook · **Tab**
  opens the Pack hub (Body, Stash, Camp builds, Field kit: Island / Wreck / Start again)
- **Raft on desktop:** look down (or hold Dive) anywhere aboard and walk to pole ·
  with canvas rigged, stand at the stern tiller and do the same to **helm** ·
  face fittings (or Pack → Raft) to widen the deck, add rail, oar, floats ·
  **Drop/Weigh anchor** · **Shove** / **Haul**

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
- `npm run test:base` — headless feature coverage for the player-freedom work:
  carpentry (lay/raise/hang/pitch/strike), sleeping in a self-built room, the
  day counter, raft helm + anchor, and save/restore. Needs `npm run dev`.
- `npm run test:camp` — camp life coverage: shelter growth (frame → ridge →
  rooms, across a reload), the tired timer (drain, sleep, HUD), and fishing
  (trap set/stock/check, the spear prompt). Needs `npm run dev`.
- `npm run test:save` — living-world save fidelity: littoral, salvage, wreck,
  weather/sea, smoking timers, wash meter, fishing equip. Needs `npm run dev`.
- `npm run shot:camp` — beauty shots of the three-room hut inside and out,
  the trap riding the wash, and the tired HUD into `shots/`. Needs
  `npm run dev`.
- `npm run shot:base` — beauty shots of a walled room, a stilt deck and the
  anchored raft under sail into `shots/`. Needs `npm run dev`.
- `npm run shot:shelter` — checks the climbable spire, the immersion suit, the
  hold's deep finds and that a weather spell holds. Needs `npm run dev`.
- `npm run sim:starts` — Monte Carlo over opening paths (wreck loot, suited
  crossing, spire camp, island swim) plus the weather balance. See
  `docs/paths.md` for how to read it.
- `npm run icons` — rasterises `public/favicon.svg` into the install icons.
- `?x=&z=&yaw=&pitch=&depth=` spawns anywhere.
- `?hour=22` starts at night · `?storm=1` locks a squall · `?calm=1` pins a
  glass-off · `?breath=0.3` / `?food=0.2` / `?energy=0.3` / `?wound=1` pre-set
  vitals · `?shark=8` summons a pass · `?knife=1` / `?spear=1` start armed ·
  `?suit=1` starts in the immersion suit · `?lantern=1` starts with the diving lantern · `?commit=1` every armed pass runs at you.
- In dev, `window.ww` exposes player, vitals, salvage, climate, shark and the
  interaction registry; `__spots` marks the loot spots.

## Assets

Everything in the scene is generated — hands (own Blender script → GLB, with a
procedural fallback), swimmer, ocean, wreck, textures. The app icon is our own
SVG, rasterised by `npm run icons`. No third-party models or textures, so there
are no licence restrictions on commercial use.

**Audio** is mostly live Web Audio (`src/audio.ts`): surface/underwater
crossfade, shore lap, rain/wind in storms, footsteps, lightning→thunder,
vitals and shark drone. Optional MP3 beds/SFX under `public/audio/` layer in
when present (`npm run audio:lyria` / `npm run audio` — see
`public/audio/MANIFEST.md` and `docs/audio-handoff.md`). AI-generated clips
credit Google Lyria / ElevenLabs per their terms; keys stay in `.env`, never
in the client.

Brain notes: `../agenticiallyjus/projects/waterworld.md`
