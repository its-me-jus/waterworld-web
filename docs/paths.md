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

**Plank/barrel as a swim aid.** A buff while carrying them, not a build —
different from the lashed raft below.

**Burden and jettison.** Heavy stash slowing the swim is still an open lever.

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
| **Raft** | 3 plank + 1 rope (+1 barrel if you have it) | Waterline | A small deck you can stand on that rides the swell |

Hand-caught fish stay in hand — shown in the Pack and the HUD stash strip —
until you **Eat** them raw, **Cook** them at a fire for a meal now, or **Smoke**
them (~30s, or overnight under a lean-to) into portable smoked fish. Cooking is
immediate; smoking is the road meal. A planted fire throws real light onto the
sand at night; **Take** it and the brand travels with you (warmth and a pool of
orange light), **Plant** it on dry ground to set it down. Submerge and it
hisses out — kindle another when you're ashore.

**Rest** under a lean-to: a short nap by day, or sleep through to dawn at night.
Warmth and strength come back; food and water tick down. A fire nearby helps,
and finishes any fish still hanging in the smoke. Too empty to sleep if the
tanks are nearly dry.

A raft at the wreck is one path — **pole it from the deck** (move while standing
on it) toward the island or along the reef. A camp on the island is another.
Working the spire with a lean-to and a fire is a third. The sandbox is the point.

---

## Backlog (nothing committed)

- **Shark & spear mid-game** — better telegraph, wound readability, maybe a pass
  that only comes after you've lingered. Half-built already.
- **More workshop pieces** — driftwood furniture, signal smoke. Same F-to-use
  pattern.
- **Memory spine** — the log was one beat. More papers, a name, a reason.
- **Second landmark** — a spar buoy or rock stack to break the 900 m binary.
- **Night economy** — biolum, glass-off dive windows, a lantern in the wreck.
  (Fire brands cover the beach walk; wreck lantern still open.)
- **Currents** — swell that carries you, so the sea moves between inputs.
- **Soft fails** — only if runs start feeling cruel rather than sharp.
- **Burden and jettison** — heavy stash slowing the swim.
- **Crate sink** — kindling, a seat, or dry storage.

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
