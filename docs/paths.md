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

**Expandable craft-a-raft.** A lone swimmer lashing a growing multi-stage deck
out of flotsam is a genre borrow, not this ocean. The spire and the suit answer
"where do I stand?" and "how long have I got?" without a vehicle.

**Plank/barrel as a swim aid.** A buff, not a path.

**Stash as craft currency.** `plank / barrel / crate / rope / canvas` still has
no sink. That's now a deliberate open question rather than an unkept promise —
the README no longer says it builds a raft. Options: burden and jettison, a
one-off spend (wedge a door, weight a dive), or island building.

---

## Backlog (nothing committed)

- **Shark & spear mid-game** — better telegraph, wound readability, maybe a pass
  that only comes after you've lingered. Half-built already.
- **Island workshop** — fire, cooked fish, a lean-to. The rain pools opened this
  door; fire is the next honest step.
- **Memory spine** — the log was one beat. More papers, a name, a reason.
- **Second landmark** — a spar buoy or rock stack to break the 900 m binary.
- **Night economy** — biolum, glass-off dive windows, a lantern in the wreck.
- **Currents** — swell that carries you, so the sea moves between inputs.
- **Soft fails** — only if runs start feeling cruel rather than sharp.

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
