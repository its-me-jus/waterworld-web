# Survival paths

What a run can *become*. Nothing here is signposted in-game — these are arcs a
player might discover by looking.

**Nothing below is committed.** This doc is for weighing options before we pick
a next focus. Re-run opening math anytime: `npm run sim:starts`.

---

## What already exists

| Path | Status | What it asks of you |
|------|--------|---------------------|
| **Wreck surface** | Live | Swim ~114 m, pry the provision crate, take floating debris, open the hatch stash |
| **Wreck depth** | Live | Knife ~13 m → mate's chest ~24 m → memory + spear; shark starts committing |
| **Island crossing** | Live | ~900 m swim to a wadeable beach; dry ground refills warmth; coconuts refill water |
| **Open-water forage** | Live | Hand-fish while still; kelp / shellfish; drifters in the haze |
| **Stash** | Live, unfinished | Counts `plank / barrel / crate / rope / canvas` — nothing spends them yet. README still says they "will build a raft yet" — that line is a promise we can keep, soften, or cut |

### Sim snapshot (200 runs, day start 9:30)

| Opening | Reach island | Warmth on arrival |
|---------|--------------|-------------------|
| Straight for the island | 100% | ~25% left (~5:25) |
| Loot wreck surface → island | 100% | **0% — ~40s freeze-grace** (~7:40) |
| Full wreck (knife + chest) → island | 100% | 0% — ~20s freeze-grace |
| Linger ~8 min at wreck, then leave | 0% | Exposure mid-ocean |
| Camp the wreck 20 min (no land) | 0% alive | Exposure — wreck is not a camp |

**Warmth is the open-water budget.** A full in-game day is ~8 real minutes, so
long swims and long lingers hit night cold. Food helps stamina, not heat.
`onLand` only fires on the island beach today.

The design tension: after the wreck, some players will want to *stay and work
the site*; others will want the horizon. Island covers the second. The first
has no honest home yet — and "build a raft" may not be the right answer.

---

## Parked / doubted ideas

### Expandable craft-a-raft (Raft Survival-like)
**Doubt:** In real water, a lone swimmer is not lashing a growing multi-stage
deck out of flotsam between shark passes. The fantasy is strong in other games;
here it risks feeling like a genre borrow and a big systems bet (craft spend,
platform physics, expansion stages, sail) for a loop we aren't sure we want.

**Status:** Parked. Do not start building expansion stages.

### Cling to a plank / barrel as a swim aid
**Doubt:** Probably not worth the work. A slight stamina or rest buff on a
found float is easy to ship and easy to forget — it doesn't create a *path*,
just a slightly kinder stroke. If we ever want "something under you," prefer a
found object with a clear fantasy (see options below), not +10% swim efficiency.

### Stash as a craft currency (for its own sake)
Collecting without a sink is fine for a while (trophy / "I cleared the
flotsam"). Inventing a sink just to justify the HUD is how we end up with raft
tech trees. Better to decide the fantasy first, then see whether stash belongs.

---

## Options on the table

Each option is scored roughly on: *fantasy fit*, *build size*, *does it answer
"stay at the wreck?"*, *does it need new systems*.

### 1 — Climb the wreck (use what's already unbroken)

**Fantasy:** The Wanderer still breaks the surface — mast, yard, scraps of
deck. Real castaways climb wreckage; they don't invent shipwrighting in hour one.

**Play:** Haul onto bow plating / reef crest / mast stump that sits in air.
Those spots count as `onLand` (or a wet-perch with slow warmth refill). The
wreck becomes a vertical camp: dive, surface, climb, warm a little, dive again.

**Pros:** Diegetic, small-to-medium build, no craft UI, makes existing geometry
matter, answers "stay" without a second vehicle.
**Cons:** Need standable collision + walk/climb on irregular mesh; mast may be
too narrow; storm wash already knocks you off beaches — same problem here.
**Stay answer:** Yes.
**Size:** Medium.

### 2 — Found warmth gear (wetsuit / oilskin) — no raft attached

**Fantasy:** One sealed box. Spare dive skins or a deckhand's oilskin. You put
it on; the sea steals heat slower.

**Play:** Warmth drain multiplier while worn. Unlocks longer wreck work and a
less suicidal island swim. No craft loop.

**Pros:** Tiny, sim-able, helps *every* path; matches the body you already see.
**Cons:** Doesn't spend stash; doesn't create a new place to *be* — only buys
time. Easy to tune into "the cold stopped mattering."
**Stay answer:** Partial (time, not a base).
**Size:** Small.

### 3 — Deepen the wreck (dungeon, not shipyard)

**Fantasy:** The Wanderer is the destination. More holds, a second chest, a
name on a locker, a flooded cabin you can barely turn around in.

**Play:** More dive loops, more memory beats, knife/spear remain the keys.
Island stays optional folklore on the horizon.

**Pros:** Lean into what already sings; no vehicle; stash can stay flavor or
become "wedged door / float a hatch" one-off spends.
**Cons:** Doesn't solve warmth camping; more art/collision; shark + breath
already gate depth.
**Stay answer:** Yes, as content — not as a dry base.
**Size:** Medium–large (content).

### 4 — Make the island the only base (tune the crossing)

**Fantasy:** There is one place that saves you. The wreck is a raid; the island
is home. Own that.

**Play:** Soften or sharpen with tuning — slightly shorter distance, a
glass-off that drifts you toward land, a found float *once* for the crossing,
clearer warmth recovery on sand, island fire later. Stash might become island
building (lean-to), not sea building.

**Pros:** Clear fantasy; less split focus; island workshop (fire, cook, shelter)
has somewhere to live.
**Cons:** "I don't want to swim 1 km" players get less of a run unless tuning
helps; wreck must stay rewarding as a *raid*, not a home.
**Stay answer:** No (by design).
**Size:** Small (tune) to medium (island workshop).

### 5 — Drift & weather as the skill

**Fantasy:** You don't out-muscle the ocean; you wait for it. Glass-offs are
dive windows; a following swell is free miles; night is a different country.

**Play:** Stronger feedback for calm/storm/swell direction; maybe a rare
current set that trends toward the island or past a second landmark. Mastery
without inventory.

**Pros:** Uses systems we already have; unique; no craft.
**Cons:** Easy to feel random or unread; may need HUD-adjacent tells we refuse;
doesn't create a base.
**Stay answer:** No.
**Size:** Small–medium (tuning + feedback).

### 6 — Memory / identity spine

**Fantasy:** Who were you on the Wanderer? The oilskin was beat one.

**Play:** More findable papers, a name, a reason. Emotional path that sits
beside whatever spatial path we pick.

**Pros:** Cheap systems-wise; raises stakes for shark and cold.
**Cons:** Not a survival *path*; writing-heavy; can feel like cutscenes if
overplayed.
**Stay answer:** No.
**Size:** Small–medium.

### 7 — Shark & spear as the mid-game

**Fantasy:** Once armed, the ocean answers. The run's middle is the fin, not a
building project.

**Play:** Better telegraph, wound/clot readability, rare aggression spikes,
maybe a pass that only happens after you've lingered at the wreck.

**Pros:** Already half-built; high drama per hour of work.
**Cons:** Combat-centric; doesn't house players who want to gather and dwell.
**Stay answer:** No.
**Size:** Small–medium.

### 8 — Second landmark (another wreck, rock, fog bank)

**Fantasy:** The horizon has more than one shape. Choice of *where*, not
*what you craft*.

**Play:** A spar buoy, a second mast, a rock stack closer than the island —
stepping stones so "stay" and "go" blur into a route.

**Pros:** Explores space; can break the 900 m binary; still found by looking.
**Cons:** More world art; risk of tourist trail if too many dots.
**Stay answer:** Partial (shorter hops).
**Size:** Medium.

### 9 — One found float (not a build loop)

**Fantasy:** A life raft canister, a fish-hold hatch cover, a netted barrel
cluster — already made. You free it, climb on, paddle poorly.

**Play:** Single mountable object near the wreck. Slow warmth relief, weak
locomotion, can break free in a storm. Not expandable.

**Pros:** More believable than shipwrighting; one object; stash unused or used
once (cut the lashings).
**Cons:** Still "a boat," just smaller; physics + mount camera; might still feel
like a toy if it doesn't change decisions.
**Stay answer:** Yes, lightly.
**Size:** Medium.

### 10 — Stash as story weight / jettison

**Fantasy:** Carrying wreckage costs you. Swim slower with a full arms-load;
ditch planks in a panic; leave a trail.

**Play:** Stash becomes burden and breadcrumb, not currency.
**Pros:** Makes counts matter without craft; diegetic.
**Cons:** Punishment-heavy; may encourage never picking up — then why have them.
**Stay answer:** No.
**Size:** Small.

---

## How these answer the fork

```
spawn → wreck
         ├─ go for the island     (exists)
         │     strengthened by: 2, 4, 5, 8
         └─ stay / work the site  (missing)
               answered by: 1, 2 (time only), 3, 9
               not answered by: craft-raft (parked), plank buff (doubted)
```

---

## Useful combinations (if we pick later)

| Pair | Why |
|------|-----|
| **1 + 2** | Climb to warm a little; suit to dive longer — wreck as raid base |
| **2 + 4** | Suit makes the island crossing humane after loot; island becomes home |
| **3 + 6** | Deep wreck + memory — story dungeon |
| **4 + 6 + 7** | Island home, memory stakes, shark as the thing you left behind |
| **8 + 5** | Stepping-stone landmarks + readable weather between them |
| **9 alone** | Only if we still want "something under you" without a genre raft |

Avoid stacking **1 + 9 + craft-raft** — three ways to get out of the water is
muddy.

---

## Decision criteria (use these before committing)

1. **Believable in this ocean** — would a cold, tired person actually do this?
2. **Creates a path, not a buff** — changes where you go and what a run *is*.
3. **Size vs learning** — can we feel it in a week of build, then sim it?
4. **Stash** — either earns a real sink, becomes burden/flavor, or we stop
   implying a raft in the README.
5. **Doesn't delete the island swim** — even if we tune it, the naked crossing
   should stay a valid legend.

---

## Current leaning (soft — change freely)

No build order yet. Soft read from the doubts above:

- **Cut or rewrite** the README raft promise until we mean it.
- **Plank-as-kickboard** — skip.
- **Expandable raft** — stay parked.
- Strongest "stay at wreck" answer that still feels real: **climb the wreck (1)**,
  maybe with **found warmth gear (2)** so dives between perches work.
- Strongest "simplify the game" answer: **own the island as the only base (4)**
  and treat the wreck as a dive raid; spend design time on crossing feel +
  island life instead of a second home.

Next step when ready: pick one primary fantasy sentence and kill the rest for
a milestone — not a second brainstorm.
