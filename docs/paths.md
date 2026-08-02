# Survival paths

What a run can *become*. Nothing here is signposted in-game — these are arcs a
player discovers by looking.

Re-run the numbers anytime: `npm run sim:starts`.
Smoke-test the shelter arcs: `npm run shot:shelter` (needs `npm run dev`).

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

## Improvise (sandbox)

The stash is a spend currency. Recipes announce themselves the same way
everything else does — F-to-use when you're standing where they'd work, with
the materials on you. No craft menu, no markers, no "correct" build order.

| Recipe | Cost | Where | What it does |
|--------|------|-------|--------------|
| **Lean-to** | 2 plank + 1 rope | Dry ground (beach or spire) | Local shelter / warmth; **Rest** under it to nap or sleep until dawn |
| **Fire** | 1 plank | Dry ground | Heat, cook/smoke fish, and a warm light at night. **Take** it as a brand to carry; **Plant** it to set camp again. Diving puts it out. |
| **Rain-catch** | 1 canvas + 1 rope | Higher dry ground | Refilling fresh water |
| **Raft** | 3 plank + 1 rope (+1 barrel) | Waterline | A real deck: gunwales, push pole, climb-aboard. Pole to steer. |
| **Rig sail** | 1 plank + 1 canvas + 1 rope | On the raft | Mast and canvas — slow trade-wind drift while you're aboard |
| **Lash rail** | 1 plank + 1 rope | On the raft | Higher rails, wider deck, harder to wash off |
| **Lash locker** | 1 crate | On the raft | Dry storage. **Stow** / **Fetch** your pack |
| **Lash deck** | 2 plank | On the raft | Widen the deck (up to three times). Room to work. |
| **Lash oar** | 1 plank + 1 rope | On the raft | Better pole bite and a cleaner turn |
| **Lash floats** | 2 bottle | On the raft | Plastic under the deck — she rides higher |
| **Scratch stern** | Mate's spear (memory) | On the raft | The Wanderer's mark — your watch, your deck |
| **Seat** | 1 plank | Dry ground | Driftwood seat. **Sit** to get stamina (and a little warmth) back |
| **Drying rack** | 1 plank + 1 rope | Dry ground | Hang fish without a fire — ~48s per fish, up to 3. **Hang** / **Take** |
| **Signal** | 1 plank + 1 canvas | Higher dry ground | Smoke column on the ridge — readable from the water. One per ~40 m |
| **Dig hollow** | hands (look down) | Soft sand | A rain-holding pit. Slow refill; brackish but drinkable |
| **Tin drip** | 1 can + 1 rope | Dry ground | A can on a stake that catches rain by the mouthful |

Fall off and **Climb** the raft from the water (F when near). Kindle a fire on the deck if you want heat under sail. Deck fires ride with the raft.

Island harvest sits on top of the scenery: **Break** driftwood into a plank, **Fell** a palm once you have the galley knife (two planks), **Pull** long grass and twist it into rope. Ocean junk adds **bottles** and **cans** to the drifter pool — bottles are a light swim aid and lash into raft floats; cans hang as a tin drip ashore.

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
Stow gear you cannot swim with. A camp on the island is another — seat, drying
rack, signal smoke, dug hollows, tin drips, rain pools, shore crabs on the wash,
palms you can fell, grass you can twist, and one inland cairn with rope left
under the stones. Working the spire with a lean-to and a fire is a third. The
sandbox is the point.

### Shark

Armed with the mate's spear, an encounter can tighten into a run: the circle
closes, it banks and aims (**It turns on you.**), then commits (**It comes.**).
Jab answers the telegraph or the rush. A bite opens a **Bleeding** meter that
taxes strength until it clots; a second bite while open ends the run.

---

## Backlog (nothing committed)

- **Memory spine** — the log was one beat. More papers, a name, a reason.
- **Second landmark** — a spar buoy or rock stack to break the 900 m binary.
- **Night economy** — biolum, wreck lantern. (Glass-off dive windows shipped with the cascade.)
- **Soft fails** — recoverable disasters beyond wash-off, only if runs feel cruel.
- **Crate sink** — kindling or dry storage beyond the raft locker.

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