# Survival paths

What a run can *become*. Nothing here is signposted in-game — these are arcs a
player discovers by looking. The one scoreboard is **days alive**: the counter
at the top of the screen turns at world midnight (sleeping through the night
banks a day), the death screen scores the run in days, and the Pack header
shows the current day.

Re-run the numbers anytime: `npm run sim:starts`.
Smoke-test the shelter arcs: `npm run shot:shelter` (needs `npm run dev`).
Feature-test carpentry, raft helm/anchor and the day count: `npm run test:base`.

---

## Where we landed

The question was whether "stay and work the wreck" could be a real path
alongside "swim for the island". It can, and it now is. Four things shipped:

| # | Path | What it does |
|---|------|--------------|
| **1** | **Climb the wreck** | A reef spire beside the Wanderer breaks the swell. Cliffs on every bearing but one long climbable ramp. Standing on it counts as out of the water at ~42% of a beach's warmth |
| **2** | **The immersion suit** | A gear locker one deck down in the bow hold, swollen shut until the knife forces it. Worn, warmth drains at a third the rate, at ~8% off your speed |
| **3** | **Deeper wreck** | The hold's bread tin (a meal you dive for) and the master's log on the sand by the torn stern (the answer to the oilskin) |
| **4** | **The island as home** | Rain caught in rock hollows refills water and slowly fills again. Warmth recovery scales with how far up the beach you are |

Plus **weather in long spells** rather than a squall metronome, and the game's
own **icon / installable manifest**.

### What that did to the numbers (200 runs each)

| Opening | Reach island | Warmth on arrival |
|---------|--------------|-------------------|
| **Knife → suit → island** | 100% | **57%** — never freezing |
| Suit, full wreck (spear + log), then island | 100% | 52% — never freezing |
| Straight for the island | 100% | 33% |
| Knife dive, then island | 100% | 12% |
| Loot wreck surface, then island | 100% | 3% — ~46% arrive freezing |
| Full wreck, no suit | 100% | 2% — ~38% arrive freezing |
| Linger 8 min in open water, then go | 0% | exposure |

| Staying put | Survived |
|-------------|----------|
| **Work the wreck from the spire, 25 min** | **100%** |
| Tread water at the wreck, 20 min | 0% (exposure) |

The suit is the difference between the crossing being a coin flip and being a
decision. The spire is the difference between the wreck being a raid and being
somewhere you can work.

### Weather

Weather draws from a weighted spell table and rolls in over a front, never
turning foul twice in a row:

```
fair 53% · glass 20% · breezy 18% · unsettled 6% · squall 2% · gale 1%
→ swimmable ~91% of the time
```

Glass-offs now only happen under a settled sky, so flat water and clear weather
arrive together and a front ends the calm early — which is the tell.

---

## The shape of a run now

```
spawn
  └─ notice the mast
       ├─ swim for the island        (~5 min, arrive with warmth to spare)
       └─ work the wreck
            ├─ haul out on the spire      → warmth, indefinitely
            ├─ knife (13 m)               → opens the hold
            ├─ gear locker (17 m)         → immersion suit, the clock slows
            ├─ bread tin (16 m)           → a meal
            ├─ mate's chest (24 m)        → spear + memory
            ├─ master's log (25 m)        → who you were
            └─ then cross, warm and armed → island as home
```

Both ends stay valid. The naked swim is still a legend; the suited crossing is
still a kilometre of open water in the dark.

---

## Still parked

**Soft fails** — only if runs start feeling cruel rather than sharp (wash-off
is the first taste; broader recoverables still open).

---

## Logistics & weather cascade

The sea moves between your inputs, and what you carry is not free.

| System | What it does |
|--------|----------------|
| **Current** | Drift along the swell. Fair water nudges; a gale shoves; glass kills it. Softened in the island's lee. Rafts ride it too — pole and sail fight the set |
| **Burden** | Stash weight slows the swim. Crate > barrel > plank > canvas > rope |
| **Swim aid** | A plank or barrel under the arm buys float (head clearer, easier climb out of a wave) — not a raft, just buoyancy |
| **Drop** | When swimming with a load and nothing else in reach: shed the heaviest piece into the water. Stow in a locker is the lasting answer |
| **Wash-off** | Foul weather fills a meter on an open deck; rail cuts it hard; locker mass helps. Over the side, Climb again |
| **Dive window** | Glass-offs clear murk, ease the stroke and the lungs — dive the wreck while it holds |
| **Camp cascade** | Rain pools and rain-catches fill faster in a front; lean-to / fire warmth reads higher in foul weather; resting through a gale earns its keep |

---

## Food across the map

Nothing points at dinner. Places do:

| Where | Window | What |
|-------|--------|------|
| Wreck surface | Always | Provision crate, hatch stash, drifting kelp/shellfish |
| Foreshore rocks | **Low tide** (exposed) or dive when covered | Limpets, mussels |
| Tide pools | **Low tide only** (hollow exposed); life returns after high-tide flush | Anemones, periwinkles, starfish — rain + lively swell refill faster |
| Island shelf drop-off wall | Dive — steep face ~250–340 m out; **wreck approach plunges into abyss** | Urchins; swim-along reef wall; blue goes black toward the wreck |
| Coral gardens (wreck reef + shelf wall) | Dive; **night biolum** | Oysters, coral snails; brain / stag / plate coral |
| Wreck reef | Dive | Edible kelp, mussels on rock |
| Open water schools | Hang still / spear / rod / net / trap | Fish (denser under swimming seals) |
| Wet sand | Ashore | Crabs |
| Cove rocks | Low tide haul-out | Seals (presence — they slip if you close in; while swimming they pull schools in) |

Tide is real mean sea level (±0.72 m), two cycles per day on the climate clock.
Tide pools flush when the sea covers the lip; rain and a lively swell settle
life back for the next low. Between the wreck and the island the shelf falls
into a real abyss on the approach — deep blue from above, black when you look
down. Bottle traps stock faster while the water is working (low / changing)
than at slack high water. Coral gardens take the night bioluminescence the
jellies already know.

---

## Improvise (sandbox)

The stash is a spend currency. Recipes announce themselves the same way
everything else does — F-to-use when you're standing where they'd work, with
the materials on you. Pack → **Camp** also lists whatever is ready right now,
so you can Raise / Dig / Lash from the bag without hunting the prompt. No
markers in-world, no "correct" build order.

| Recipe | Cost | Where | What it does |
|--------|------|-------|--------------|
| **Raise frame** | 2 plank + 1 rope | Dry ground | Posts and a ridge — the start of a shelter. Walls and roof still to fashion. |
| **Lash wall** | 1 plank | At a frame | One side closed (twice for both). Wind finds less of you. |
| **Roof fronds** | 2 frond | At a frame | Leaf thatch — enough shade to **Rest** |
| **Roof tarp** | 1 canvas | At a frame | Canvas stretched taut — the proper roof |
| **Roof scrap** | 3 bottle + 1 rope | At a frame | Ugly bottle-and-rope cover when you have nothing better |
| **Set fish trap** | 1 bottle + 1 rope | Shallows | Passive stock; Check when the tide has worked (faster at low water) |
| **Fashion fishing rod** | 1 plank + 1 rope | Dry ground | Cast from shore / surface into nearby schools |
| **Lash cast net** | 1 rope + 2 frond | Dry ground | Scoop fish while wading the wash |
| **Set barrel** | 1 barrel | At a frame | Cistern under the eaves; rain fills it; **Drink** |
| **Fill barrel** | hands / tin can | At barrel + pool or catch | Scoop rock-pool or rain-catch water into the cask (can scoops better) |
| **Lay mat** | 2 frond + 1 rope | Roofed shelter | Softer ground; warmer **Rest** |
| **Lash crate** | 1 crate | Dry ground | Shore locker — **Stow** / **Fetch** like the raft hold |
| **Plant cistern** | 1 barrel | Dry ground | Open barrel alone — rain store without a shelter |
| **Fire** | 1 plank | Dry ground | Heat, cook/smoke fish, and a warm light at night. **Take** it as a brand to carry; **Plant** it to set camp again. Diving puts it out. |
| **Rain-catch** | 1 canvas + 1 rope | Higher dry ground | Refilling fresh water |
| **Raft** | 3 plank + 1 rope (+1 barrel) | Waterline | A real deck: gunwales, push pole, climb-aboard. Walk the centre to work; pole from the edge to steer. |
| **Rig sail** | 1 plank + 1 canvas + 1 rope | On the raft | Mast and canvas — slow trade-wind drift while you're aboard. A gale can tear it; **Mend** with canvas + rope. |
| **Lash rail** | 1 plank + 1 rope | On the raft | Higher rails, wider deck, harder to wash off |
| **Lash locker** | 1 crate | On the raft | Dry storage. **Stow** / **Fetch** your pack. A torn sail in a gale can flood it. |
| **Lash deck** | 2 plank | On the raft | Widen the deck (up to three times). Room to work. |
| **Lash oar** | 1 plank + 1 rope | On the raft | Better pole bite and a cleaner turn |
| **Lash floats** | 2 bottle | On the raft | Plastic under the deck — she rides higher |
| **Scratch stern** | Mate's spear (memory) | On the raft | The Wanderer's mark — your watch, your deck |
| **Sit thwart** | — | On the raft | Built-in stern seat. Stamina back. |
| **Rest under sail** | sail rigged | On the raft | A nap under canvas — lighter than a lean-to, finishes deck smoke |
| **Take the helm** | sail rigged | Stern of the raft | Look down (or hold dive) and push — the tiller steers her where you look, faster than the pole |
| **Drop anchor** | — | Afloat raft | Stone over the side, line made fast — the set can't take her. Ignores current and auto-beach until weighed |
| **Weigh anchor** | — | Anchored raft | Stone up. The sea has her again |
| **Haul ashore** | — | Shallows / beach | Ground the hull on sand. Walk off onto the island. |
| **Shove off** | — | Beached raft | Push her clear of the shelf into deep water — then pole |
| **Seat** | 1 plank | Dry ground | Driftwood seat. **Sit** to get stamina (and a little warmth) back |
| **Drying rack** | 1 plank + 1 rope | Dry ground | Hang fish without a fire — ~48s per fish, up to 3. **Hang** / **Take** |
| **Signal** | 1 plank + 1 canvas | Higher dry ground | Smoke column on the ridge — readable from the water. One per ~40 m |
| **Dig hollow** | hands (look down) | Soft sand | A rain-holding pit. Slow refill; brackish but drinkable |
| **Tin drip** | 1 can + 1 rope | Dry ground | A can on a stake that catches rain by the mouthful |

### Carpentry (freeform)

The architect-your-own-base layer. Tiles snap to a 2.4 m world grid so pieces
always meet flush; every piece **Strike**s down for a full refund.

**How to operate it**

1. Carry **2 planks** (Break driftwood, Fell palms with the knife, or Fetch from
   a woodpile).
2. Stand on dry sand / the wash / shallows (stilts reach ~2 m down) and face
   the empty square you want — a faint ghost shows the next deck.
3. **Lay Platform** (F, or Pack → Camp). Standing on a deck, facing out always
   aims the empty neighbour so rooms grow. Looking back at your own floor
   hides the prompt on purpose.
4. Stand on the tile, face an edge → **Raise Wall** / **Hang Door**. Pitch a
   **Roof** (1 plank + 1 frond) per tile. A closed-in, roofed tile is a bedroom.
5. Join more decks the same way. Each bay needs its own lid — bigger houses
   are more tiles, more walls, more roofs (and more planks).
6. Stock materials: **Stack Woodpile** (1 plank to plant) then **Stow on pile**
   / **Fetch from pile**, or **Lash Crate** for mixed salvage.

When the F-prompt shows Strike / Sleep / Fire instead, Pack → **Camp** still
lists every recipe that's ready right now.

| Recipe | Cost | Where | What it does |
|--------|------|-------|--------------|
| **Lay platform** | 2 plank | Land, wash, or shallows (to ~2 m) | Stilt deck tile. Walkable; skirts to a ramp on land; **Climb** aboard from the water |
| **Raise wall** | 1 plank | Tile edge (or free-standing) | Solid panel — blocks wind and body. Free walls are windbreaks (0.5 shelter) |
| **Hang door** | 1 plank | Tile edge | Wall with a walk-through gap; blocks its cheeks, passes the middle, counts toward the room |
| **Pitch roof** | 1 plank + 1 frond | Over a tile | Shed lid. Roofed + walled (shelter ≥ 0.7) makes a bedroom: **Sleep** skips to dawn like the lean-to |
| **Stack woodpile** | 1 plank | Dry ground or a deck | Shore stockpile (up to 24). **Stow on pile** / **Fetch from pile** (handfuls of 4) |
| **Strike** | hands | Any piece | Dismantle for a full refund |

A tile's shelter sums what's hung on it: 0.18 base, +0.11 per wall, +0.08 per
door, +0.26 for the roof — a closed room with a lid reads 0.88, better than
any lean-to. Fires burn on deck tiles; the day counter turns at world
midnight, so sleeping the night away in your own room is how a day gets
banked.

Fall off and **Climb** the raft from the water (F when near). Kindle a fire on the deck if you want heat under sail. Deck fires ride with the raft. An empty raft keeps her heading — she won't spin to chase leftover pole speed. Walk the centre to work; **look down** (or hold dive on a phone) at the gunwale to pole and steer. On sand she sits still — **Shove** clear of the shelf, then pole again. **Haul** her up the beach when you mean to camp. A gale can tear the sail — **Mend** it.

Island harvest sits on top of the scenery: **Pull** palm fronds for thatch,
**Break** driftwood into a plank, **Fell** a stripped palm once you have the
galley knife (two planks), **Pull** long grass and twist it into rope. Ocean junk
adds **bottles** and **cans** to the drifter pool — bottles are a light swim aid
and lash into raft floats or a scrap roof; cans hang as a tin drip ashore.
**Barrels** plant as cisterns or sit under a shelter eave and fill with rain.

A shelter is fashioned in pieces, not summoned whole: **Raise** a frame, **Lash**
walls, **Roof** with fronds / canvas tarp / scrap bottles, then **Rest** once
something is over your head. Swap in a better tarp later if you started with
leaves. Set a barrel under the eaves, **Fill** it from a rock pool or rain-catch
(a tin can scoops cleaner), and **Lay** a frond mat if you want the ground to
give warmth back when you sleep. A crate on dry sand is the shore locker.

Hand-caught fish stay in hand — shown in the Pack and the HUD stash strip —
until you **Eat** them raw, **Cook** them at a fire for a meal now, or **Smoke**
them (~30s, or overnight under a lean-to) into portable smoked fish. A drying
rack ashore does the same job slower, without fire. Cooking is
immediate; smoking is the road meal. A planted fire throws real light onto the
sand at night; **Take** it and the brand travels with you (warmth and a pool of
orange light), **Plant** it on dry ground to set it down. Submerge and it
hisses out — kindle another when you're ashore.

**Rest** under a lean-to: a short nap by day, or sleep through to dawn at night.
Warmth and strength come back; food and water tick down. A fire nearby helps,
and finishes any fish still hanging in the smoke. Too empty to sleep if the
tanks are nearly dry.

A raft at the wreck is one path — **Climb** aboard from the water, **pole** (or
**oar**) it from the deck, then **Rig** a sail, **Lash** rail, locker, deck and
floats, **Scratch** the stern once the mate's spear has given you a name to cut.
Take the **helm** from the stern to steer under canvas, and **Drop anchor** when
the set would carry her off. Stow gear you cannot swim with. A camp on the
island is another — seat, drying
rack, signal smoke, dug hollows, tin drips, rain pools, shore crabs on the wash,
palms you can fell, grass you can twist, and one inland cairn with rope left
under the stones. Working the spire with a lean-to and a fire is a third. And
past all three there is the architect's path: platform tiles over the shallows,
walls and a door of your own placing, a roof you pitched, and a bed that is
simply the floor of the room you made. The sandbox is the point.

### Shark

Armed with the mate's spear, an encounter can tighten into a run: the circle
closes, it banks and aims (**It turns on you.**), then commits (**It comes.**).
Jab answers the telegraph or the rush. A bite opens a **Bleeding** meter that
taxes strength until it clots; a second bite while open ends the run.

---

## Backlog (nothing committed)

- **Memory spine** — the log was one beat. More papers, a name, a reason.
- **More soft fails** — beyond sail-tear / locker flood, only if runs feel cruel.

~~Night economy / wreck lantern~~ — shipped: sealed diving lantern in the gear
locker beside the suit; local beam underwater at night, no warmth/breath buff.
Save fidelity now covers littoral, seals, salvage finds, wreck progression,
weather, sea glass-offs, smoking/drying, carried fire, and raft wash/fail state.
Rod/net carry first-person cast/scoop feedback.

---

## Design rules

- No objective marker. The spire, the locker, the pools — found by looking.
- Warmth is the honest cost of water life. The suit and the spire are answers,
  not cheats: both still lose to a gale at night.
- Anything planted on the island uses the surface the mesh actually draws, not
  the analytic height, or it floats and sinks on slopes.
- Never let one rock's collider quietly floor a diver over the wreck — that
  failure looks like nothing and breaks every deep find.
- Re-run `npm run sim:starts` before shipping a loop that has to outrun exposure.
- The stash is a choice, not inventory padding: carry, Drop, Stow, or build.
- Weather should change plans mid-run — never only meters.
- A living camp persists locally across reloads; death and Start again wipe it.