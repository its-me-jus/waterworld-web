# Survival paths

What a run can *become*. Nothing here is signposted in-game — these are the
arcs a player can discover by looking, and the order we should build them in.

Re-run the numbers anytime: `npm run sim:starts`.

---

## What already exists

| Path | Status | What it asks of you |
|------|--------|---------------------|
| **Wreck surface** | Live | Swim ~114 m, pry the provision crate, take floating planks / barrel / rope / canvas, open the hatch stash |
| **Wreck depth** | Live | Knife at ~13 m → cut the mate's chest at ~24 m → oilskin memory + spear. Shark starts committing |
| **Island crossing** | Live | ~900 m open-water swim to a wadeable beach. Dry ground refills warmth; coconuts refill water |
| **Open-water forage** | Live | Hand-fish while hanging still; eat kelp / shellfish; drifters recycle in the haze |
| **Raft** | Promised only | Stash collects `plank / barrel / crate / rope / canvas` — HUD counts them, nothing spends them yet |

### Sim snapshot (200 runs, day start 9:30)

| Opening | Reach island | Warmth on arrival |
|---------|--------------|-------------------|
| Straight for the island | 100% | ~25% left (~5:25) |
| Loot wreck surface → island | 100% | **0% — ~40s freeze-grace** (~7:40) |
| Full wreck (knife + chest) → island | 100% | 0% — ~20s freeze-grace |
| Linger ~8 min at wreck, then leave | 0% | Exposure mid-ocean |
| Camp the wreck 20 min (no land) | 0% alive | Exposure — wreck is not a camp |

Hard truth from the sim: **warmth is the open-water budget**. A full in-game day
is only ~8 real minutes, so any long swim or linger hits night cold. Food from
the crate helps stamina; it does not heat you. `onLand` only fires on the
island beach — standing on the wreck does nothing for warmth today.

---

## The fork: island or stay

Two honest first-run choices once you've found the wreck:

```
spawn
  └─ notice the mast / haze
       ├─ swim for the island     ← exists, punishing after loot
       └─ work the wreckage       ← needs a place to stand that isn't sand
            └─ build a raft
                 ├─ live at sea (expand, sail, fish)
                 └─ ferry to the island later (and haul island salvage back)
```

Players who don't want the death-swim should still have a run. The raft is that
run — and the stash already points at it.

---

## Path A — Island (live)

**Fantasy:** notice the shape on the horizon, commit, crawl onto sand before
the cold closes.

**Next polish (not blocking):** clearer beach warmth recovery feedback;
coconut as the "you made it" sip; maybe a first dry-land whisper. The crossing
math works; the last 40 seconds after a wreck-loot start are the drama.

**Later:** island as a *supply loop* — haul wood / coconuts back out on a raft
instead of a one-way swim. That only opens once Path B exists.

---

## Path B — Raft from wreckage (next focus)

**Fantasy:** you never leave the water for long — you *make* a place to leave
it. The Wanderer's debris becomes a deck. More flotsam → a bigger deck. Island
wood / canvas later upgrades what the wreck alone couldn't.

### Why this is next

1. The stash has nowhere to go ("it will build a raft yet").
2. Island is viable but razor-thin after looting — half the players will want
   another answer.
3. A raft turns the ocean from a corridor into a workshop.
4. It unlocks ferry / return trips without softening the naked swim.

### The warmth problem (must solve first)

You cannot build a raft while dying of exposure. Staying near the wreck for the
time it takes to gather + lash needs a warmth answer that isn't "swim to the
island first."

**Proposal — sealed gear locker / ditty box on the bow or in the hatch line:**

- Found like everything else: you notice a lashed box, pry / cut it (knife helps
  but bare hands can struggle longer).
- Inside: a **folded wetsuit** (or the ship's spare dive skins).
- Putting it on is a one-time diegetic action — suit appears on the body you
  already wear in first person, warmth drain in water drops hard (e.g. ~0.35×
  current `WARMTH_IN_WATER` rate while worn).
- Night + storm still bite; the suit buys *hours of work*, not immortality.
- Without it, raft-building at the wreck is a speedrun against freeze — possible
  for experts, hostile for the intended path.

Optional sibling finds in the same box or nearby: a **float bladder / life ring**
(lets you rest with less stamina drain) or a **small tarp** (first canvas if you
missed drifters). Keep the box to one memorable reveal.

### Raft loop (expandable)

Spend stash in place — no menu tree, just an interact when you're at your
deck (or at a floating "keel" plank you've claimed):

| Stage | Costs (sketch) | What you get |
|-------|----------------|--------------|
| **Keel** | 3 plank + 1 rope | A lashable float you can stand / kneel on — first `onRaft` warmth relief (wet but out of full swim drain) |
| **Deck** | +4 plank + 1 rope + 1 barrel or crate | Wider platform; stash chest; craft point |
| **Shelter** | +2 canvas + 1 rope | Shade / spray break — further warmth + rain/storm help |
| **Mast & sail** | +1 plank + 2 canvas + 1 rope | Weak downwind push; island becomes a *voyage*, not a stroke contest |
| **Outriggers / second bay** | more plank + rope + island timber later | Expand footprint; carry more salvage |

Island salvage later feeds the same recipe table (palm trunk ≈ plank+, coconut
fiber ≈ rope, etc.) so a raft that visited land comes back *changed*.

### Feel targets

- First keel: findable within one suited day at the wreck without a checklist.
- Expansion is visible — the deck grows under your feet, not a level-up chime.
- Storms threaten to break loose lashings (optional later): rope condition, or
  a piece washes off if you leave a fresh stage unsecured.
- Shark still circles; a raft is not a fortress — spear still matters.

### Sim additions once built

Add paths to `scripts/sim-starts.mjs`:

- `wetsuit → keel → survive 20 min at wreck`
- `wetsuit → deck → sail toward island`
- `no suit → rush a keel before freeze` (expert / fail rate)

---

## Other paths (backlog — pick after raft keel)

Candidates to keep on the board. None are committed; they hang off A/B.

### C — Reef perch
Climb / haul onto the reef rock or bow deck as **micro-land** (partial warmth
refill, no full island). Softer than a wetsuit, weaker fantasy. Could pair with
B as a stopgap, or stay cut if the suit ships.

### D — Spear & shark
Already started. Next beats: wound feedback, a second pass that learns, maybe
a rare "fin at the raft edge" once B exists. Combat is seasoning, not the meal.

### E — Memory / identity
Oilskin pouch already fires one beat. More wreck papers / names / a reason you
were on the Wanderer — diegetic, findable, never a quest log. Feeds emotional
stakes for whatever path you pick.

### F — Island as workshop
Once ashore (A) or ferried (B): fire, cooked fish, palm-frond lean-to, better
rope from fiber. Makes the island a *second base*, not a finish line. Depends
on A working and preferably B for return cargo.

### G — Night economy
Biolum jellies, glass-off dive windows, colder math. Reward staying awake /
diving smart. Mostly tuning + one find (e.g. lantern glass in the wreck).

### H — Current & drift
Lean into swell orbital push / seasonal amp: a raft without a sail still
*travels*. Quiet way to make the sea feel alive between player inputs.

### I — Soft fail / second chance
A broken keel that becomes a plank again; washing up on a random scrap after
drown-adjacent exposure. Easy to cheapen the ocean — only add if runs feel
cruel rather than sharp.

---

## Recommended build order

1. **Wetsuit find + warmth multiplier** — unblocks every "stay in the water" fantasy; small, testable, sim-able.
2. **Keel craft from stash** — first time the HUD numbers *do* something; first `onRaft` state.
3. **Deck expansion stages** — barrel/crate/rope/canvas sinks; visible growth.
4. **Sail / weak propulsion** — bridges B → A without deleting the hard swim.
5. **Island salvage recipes** — return trips matter.
6. Then pick from C–H based on what the raft made feel thin (combat, story, night).

---

## Design rules (keep these while building)

- Still no objective marker. The box, the keel site, the island — found by looking.
- Stash spends in the world (hands on the deck), not in a craft UI grid.
- Warmth stays the honest cost of water life; the suit and the raft are *answers*, not cheats.
- Island swim stays valid forever — raft is another path, not a replacement.
- When in doubt, re-run `npm run sim:starts` and add a path before shipping a loop that can't outrun exposure.
