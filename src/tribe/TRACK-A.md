# Track A hand-off: the world side of the heist + tribe story

For whoever wires this into `src/main.ts` (Antigravity, as planned). Written 22 Nov 2026.

Everything here is new files in `src/story/` and `src/tribe/`. No existing file was changed, nothing is committed,
and `npx tsc --noEmit` is clean. Until `main.ts` imports these, the live game is unchanged.

## Files

| File | What it is |
|---|---|
| `src/tribe/types.ts` | The shared contract with Track B: `NpcId`, `NpcPose`, `NpcAction`, `PlayerGesture`, `HeldItem`, `NpcPerceptionSnapshot`, plus `TribePlayerState`, `TribeWeather`, `NpcInfo`, `BagState`, `Interactable`, `IslandLike`, `TidalCavesLike`. |
| `src/tribe/places.ts` | `getTribePlaces(island, reefWreckPos, cavesEntrance)`: finds the landing, totem, camp fire, sacred circle, Tala's reef spot and the cave mouth on the real terrain. Cached per island. Every module reads it, so the fire, its smoke and the islanders agree. |
| `src/story/heist-intro.ts` + `.css` | `createHeistIntro` (16 s overlay + synthesized sound over the real parachute drop) and `createIslandSmoke` (the camp's smoke column, visible from the drop). |
| `src/story/cash-bag.ts` | `createHeistProps`: the $2.4M duffel, wet $100 bills, totem, footprints, camp fire pit with its light, and the salvage (compass, flare, spear, radio battery). |
| `src/tribe/npc-mesh.ts` | `buildIslander('kael' / 'tala' / 'oru')`: articulated low-poly bodies with every `NpcPose`; `countTriangles`. |
| `src/tribe/tribe-sim.ts` | `createTribeSim`: schedules, walking, perception, Kael's warn-before-chase rules, and the brain's control surface (`applyAiDecision`, `getPerceptionSnapshot`, `getNearestNpc`, `resetEncounters`). |

## Where things are on today's island

Island centre (980, -680). Landing beach (769, -520). Totem 6 m up the beach from it. Camp fire (756, 8, -754)
by the south-west rain pool, in an open sandy clearing, ~215 m down the coast. Reef coaster (680, -544); Tala works
the reef crest beside it (679, -1, -538), knee-deep at low tide. Cave mouth (671, -480), 6 m down; the air-chamber
stash shelf is at (652.5, 0.85, -497.5). Flare and spear on the Wanderer's perch (-68, 6.8, -108).
Kael patrols (740,-650) (748,-581) (772,-603) (806,-557) (842,-502).

## Wiring for main.ts

Build all three before `start()`: the camp fire's PointLight has to be in the scene before `post.compile`, or every
lit shader recompiles once (the freeze `cave-life.ts` warns about). Use `reefWreck.position` everywhere for the
reef wreck (`getTribePlaces` caches on the first call).

```ts
import { createHeistIntro, createIslandSmoke } from './story/heist-intro'
import { createHeistProps } from './story/cash-bag'
import { createTribeSim } from './tribe/tribe-sim'
import { getTribePlaces } from './tribe/places'
import type { HeldItem, TribePlayerState } from './tribe/types'

// After reefWreck, tidalCaves and hud exist:
const places = getTribePlaces(island, reefWreck.position, tidalCaves.entrance)
const campSmoke = createIslandSmoke(scene, places.campFire, lowPower)
const heistProps = createHeistProps(scene, {
  island, reefWreckPos: reefWreck.position, reefWreckStandAt: reefWreck.standAt, reefWreckYaw: reefWreck.yaw,
  wreckPos: wreck.group.position, wreckPerch: wreck.perch, wreckStandAt: wreck.standAt, tidalCaves, lowPower,
})
const tribe = createTribeSim(scene, {
  island, reefWreckPos: reefWreck.position, tidalCaves, lowPower,
  onWhisper: (text) => hud.whisper(text),
  onPlayerCaptured: (id) => { /* ending card (Track B); then tribe.resetEncounters(); heistProps.resetProps() */ },
  onProximityEnter: (id, snapshot) => { /* hand to the brain (Track B) */ },
})

// After arrival and skipChute:
const heistIntro = createHeistIntro(app, {
  enabled: wantChute,
  getAltitude: () => (chute.active ? chute.height : 0),
  onSkip: () => void oceanAudio.unlock(),   // the skipping Enter never reaches audio.ts's unlock listener
  onDone: () => arrival.begin(),            // arrival's own title otherwise sits on top of the intro
})
// cutAwayToBeach() and travelTo(): call heistIntro.skip() before chute.cut()
// start(): call heistIntro.start() in place of arrival.begin(); if (!heistIntro.playing) arrival.begin()

const tribePlayer: TribePlayerState = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, crouched: false, mode: 'walk' }
let heldItem: HeldItem = 'none'

// frame(), after `view` is known (climate.update has run at the top):
heistIntro.update(dt)
if (!heistIntro.playing) arrival.update(dt, /* same args as now */)  // keeps the control hint off the subtitles
campSmoke.update(dt, t, weather)
heistProps.update(dt, t, weather, camera.position)
tribePlayer.x = player.x; tribePlayer.y = player.y; tribePlayer.z = player.z; tribePlayer.yaw = player.yaw
tribePlayer.speed = view.speed
tribePlayer.crouched = false   // main has no crouch input yet
tribePlayer.mode = chute.active ? 'glide' : view.walking ? 'walk' : 'swim'
tribe.update(dt, t, tribePlayer, weather, heldItem, heistProps.bag.state === 'carried', camera)
```

In DEV, add `places`, `heistProps` and `tribe` to `window.ww`. `ww.tribe.getNpcState('kael')` shows his state,
warning time and grace left.

### The carried bag slows you down: needs a player.ts change

`heistProps.getMovementModifiers()` returns `{ swimSpeedMult, sinkBias, walkSpeedMult }` (0.82 / 0.18 m/s down /
0.93 while carried; 1 / 0 / 1 otherwise). Pass it into `updatePlayer` and multiply the swim `maxSpeed` and the
`WALK_SPEED` target by the mults, and subtract `sinkBias` from the vertical-velocity target in the swim branches.

## Exports, in short

- `createHeistIntro(app, { enabled?, getAltitude?, onSkip?, onDone? })` -> `{ start(), skip(), update(dt), playing, dispose() }`.
  Off with `?film`, `navigator.webdriver` or `enabled: false`. While it plays, Enter skips only the intro (a capture
  listener stops it reaching main's skip-the-drop); afterwards Enter is main's again.
- `createIslandSmoke(scene, pos, lowPower)` -> `{ group, update(dt, t, { daylight, storm }), setVisible(on), dispose() }`.
  240 puffs (120 low power), all moved in the shader; no lights. It shows in `?film` shots: call
  `campSmoke.setVisible(!film.on)` if the homepage re-film should not have it.
- `createHeistProps(scene, opts)` -> `{ group, places, bag, spots, getMovementModifiers(), burstCashBills(origin, n),
  burnCashBills(origin, n), getNearbyInteractable(pos, maxDistance = 3), pickUp(id), isInWorld(id), resetProps(), update(dt, t, weather, eye?) }`.
  `bag`: `state`, `object`, `position`, `drop(at)`, `pickUp()`, `stashInCaves()`, `canStashAt(pos)`.
  Interactable kinds: `salvage_compass`, `salvage_flare`, `spear`, `radio_battery`, `cash_bag`, `campfire` (burn cash
  here), `cave_stash` (in the air chamber with the bag), `totem`.
- `buildIslander(id, { lowPower? })` -> rig `{ root, id, triangles, drawCalls, height, pose, setPose, update, lookAt, snapPose }`.
  Root at the feet, faces local -Z, `root.rotation.y = yaw` (same convention as `player.yaw`).
- `createTribeSim(scene, opts)` -> `{ group, update(...), applyAiDecision(id, action, pose?), getNearestNpc(pos),
  getPerceptionSnapshot(id, player, heldItem, weather, carryingBag?), resetEncounters(), getNpcState(id), npcs, places,
  layout, playerGesture(g), testRoute(...) }`.

## What the brain can and cannot make Kael do

Every chase goes through one gate. Kael must have given a warning (spear raised) that has stood at least 3.5 s while
the player kept coming inside 9 m (1 s if the player sprints at him). No chase in the first 45 s after the player first
stands on land (restarted by `resetEncounters`), none while the player is in water deeper than 0.6 m or swimming (he
holds at the waterline), and a chase gives up after 20 s. `applyAiDecision('kael', 'attack_chase')` with no recent
warning only makes him warn. Tala and Oru never attack. A brain decision holds about 12 s, then local behaviour resumes.

## Budgets

Islanders: Kael 2,540 triangles / 17 draw calls, Tala 2,628 / 19, Oru 2,634 / 17 (under 3,000 each; confirmed in the
browser with `countTriangles`). Props: ~4,000 triangles, 11 meshes + 1 instanced bill mesh + 1 PointLight. Smoke:
one draw.

## Checked in the running game (22 Nov, built-in browser, light quality)

- Smoke column from the drop's opening point (290 m up) and from above the camp.
- Intro: every beat shows over the real descent; Enter skips only the intro, then skips the drop again; the overlay
  removes itself.
- Totem, footprints, camp fire at night, duffel on the sand, bill burst landing flat, compass on the reef, flare and
  spear on the perch. No console errors.
- All three islanders in sun, and the warn, beckon and laugh poses.
- Kael on the real island: unseen from behind; after the grace, notices at 14 m, warns, stalks after 3.5 s, charges,
  captures once. Brain-ordered attack with no warning: warning only, and he calms when the player stands still.

Fixed during the check: footprints were invisible (sunk under the terrain and too faint); Oru's beard and hair read
as a white face mask and his mantle and wrap as a black-and-white chessboard; the totem read as a grey concrete post.

## Not checked

- The intro's sound, and any of it on a real phone or Safari.
- Frame rate with everything wired in, on a phone.
- The wiring itself, the brain (Track B) and the ending screens.
- Bag-carrying movement (needs the player.ts change above).

## Known leftovers

- `reefWreck.standAt` always returns -1000, so the radio battery sits on the reef by the coaster's bow, not on deck.
- There are now two spears: the old one in the Wanderer's locker and the salvage one on its perch.
- Tala leads to the caves by treading water ~10 m from the mouth (the rock channel is narrower than the sim's grid).
- Oru's shell mantle is still mostly white with brown squares; fine at a distance, plain up close.
- `WIND_HEADING` (0.62) is copied into the smoke and the props; exporting it from island.ts would remove the copies.
