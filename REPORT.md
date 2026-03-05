# REPORT

This file is the single source of truth for **patch notes + sanity audits** for the **alpha v1** tool.

---

## Patch: headers_reports_alpha_v1
- **Base zip:** `alpha_v1_src.zip`
- **Date:** 2026-02-27
- **Scope:** Header/version-string cleanup + report consolidation
- **Feature changes:** **None** (comments/docs only)

### Sanity findings (no mechanic changes)
- **AoE spread multiplier (×0.75)** is applied **exactly once** in all relevant paths:
  - Fight plan preview (`js/app/app.js`) applies `spreadMult(targetsDamaged)` **once** to the base damage range.
  - Auto x4 scoring (`js/domain/waves.js`) applies `spreadMult(damagedTargets)` **once** during scoring.
  - Battle step resolution (`js/domain/battle.js`) applies `spreadMult(targetsDamaged)` **once** when resolving an AoE hit.
  - `calc.computeDamageRange()` returns **single-target** damage% and does **not** apply spread.
- **Overkill is not clamped pre-spread:** damage% may exceed 100 and is multiplied by spread after (e.g., `150% → 112.5%` still OHKOs).
- **Low Kick / Grass Knot are weight-based (Gen 5 brackets)** via `weightBasedPowerKg()` in `calc.js`:
  - `<10→20`, `<25→40`, `<50→60`, `<100→80`, `<200→100`, `≥200→120` BP.

### Required verification: Simisage + Strength Charm (Low Kick, Gen 5 weight BP)
Assumptions (tool defaults):
- Attacker: **Simisage** Lv50, IV31, **EV85** (Strength Charm), move **Low Kick**
- Defenders: IV0 / EV0, wave levels as listed

Results (single-target, min/max roll):
- **Smeargle (Lv47, 58.0kg → 80 BP):** **194.4% – 229.6%** (min-roll OHKO ✅)
- **Whismur (Lv47, 16.3kg → 40 BP):** **129.1% – 152.1%** (min-roll OHKO ✅)
- **Absol (Lv48, 47.0kg → 60 BP):** **79.2% – 93.3%** (min-roll OHKO ❌)

### Version/header cleanup performed
- Removed all `v1.0.x` strings from headers and comments.
- Standardized JS headers to:
  1. `// <relative path>`
  2. `// alpha v1`
  3. `// short comment`
- Updated non-JS file headers (HTML/CSS) to match **alpha v1** naming.
- Deprecated `reports/*.txt` as authoritative patch notes (kept only as archival docs).

### Touched files
- `calc.js`
- `index.html`
- `js/app/app.js`
- `js/data/loadData.js`
- `js/data/moveFixes.js`
- `js/data/nameFixes.js`
- `js/domain/battle.js`
- `js/domain/items.js`
- `js/domain/roster.js`
- `js/domain/shrineRules.js`
- `js/domain/waves.js`
- `js/main.js`
- `js/services/pokeApi.js`
- `js/services/storage.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`
- `js/state/store.js`
- `js/ui/dom.js`
- `js/ui/eggGame.js`
- `reports/sanity_report.txt`
- `reports/weather_ball_drizzle_report.txt`
- `styles.css`
- `REPORT.md` (new)


---

## Patch: ui_reinf_order_preview_text_alpha_v1
- **Base zip:** `alpha_v1_sim_headers_reports_alpha_v1.zip`
- **Date:** 2026-02-27
- **Scope:** UI clarity in Waves/Battle (reinforcement join order) + remove leftover “sim” wording in user-facing copy
- **Feature changes:** **UI-only** (no battle mechanics / solver changes)

### What changed
- **Selected enemies:** slot labels now read **Lead #1 / Lead #2 / Reinf #3 / Reinf #4** (join order is obvious).
- **Selection summary:** “Order” → **“Join order”** and uses the Lead/Reinf labels.
- **Battle reinforcements:** chooser now **defaults to the next bench entry (join order)** (still overrideable).
- **Copy cleanup:** removed “sim assumes …” and replaced “Simulate/Re-sim” wording with **Preview/Re-run** where it was user-facing.

### Sanity
- `node --check` passes (no syntax errors).
- AoE spread ×0.75 and Low Kick weight brackets are untouched.

### Touched files
- `js/app/app.js`
- `REPORT.md`

---

## Folded archive: REPORT_FEATURES.md (deprecated)
# REPORT_FEATURES.md (DEPRECATED)

This file is kept for archive. Canonical patch notes + audits live in **/REPORT.md**.

## Implemented (Prompt 2 — steps 1–3)

### Step 1 — Default prio strength respects AoE ×0.75 (classification only)
- Updated the **default prio estimator (prioØ)** so **AoE moves use `effectiveBP = BP * 0.75`** when calculating the *strength* used for tiering.
- This is **only inside the default prio assignment** logic and **does not touch damage** (spread is still handled only in the battle sim).

### Step 2 — Bug/Fighting “importance” rule stays
- Kept the existing scalable rules:
  - **STAB Bug/Fighting → P5** (reserve for bosses)
  - **Strong non‑STAB Bug coverage (Megahorn-ish) stays late**

### Step 3 — Dynamic low‑PP prio bump (lazy conserve)
- Added a new setting: **`Auto-bump prio when PP ≤ 5 (lazy conserve)`** (default **ON**).
- Behavior:
  - When a move’s PP becomes **≤ 5**, its **prio increases by +1 tier** (clamped to **max P5**).
  - Only applies if **`prioAuto === true`** and **`lowPpBumped !== true`**.
  - Sets **`lowPpBumped: true`** on the move so it won’t re-trigger.
  - **No auto-revert** when PP rises again.
- Trigger points covered:
  - PP changes from **battle usage** (PP decrement)
  - PP changes from **manual PP editing** (when enabled)

### Migration — ensure updated defaults apply broadly
- Added a one-time migration flag **`state.ui._prioDefaultsAoe075Applied`** to recompute **only auto-managed** priorities (`prioAuto=true`) so the AoE ×0.75 classification change applies to existing saves.
- Manual prios (`prioAuto=false`) are preserved.

## Files touched
- `js/domain/roster.js`
- `js/domain/battle.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`
- `js/app/app.js`

## Follow-up patch — STAB folded into strength (requested)
- Default prio tiering now treats **STAB as a pure math multiplier (×1.5)** inside the same strength formula.
- Typing is only used for **special reserve rules**:
  - **STAB Bug/Fighting → P5**
  - **Non‑STAB Bug ≥100 BP → P4**
  - **Strong non‑STAB Fighting (strength ≥125) → at least P4**
- Added migration flag **`state.ui._prioDefaultsStabMathApplied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — Strength thresholds tuned (requested)
- Updated strength-to-tier thresholds to:
  - **P1**: strength < **85**
  - **P2**: < **100**
  - **P3**: < **115**
  - **P4**: < **130**
  - **P5**: ≥ **130**
- Refined Bug/Fighting reserve rules to stay **type-aware but narrow**:
  - **STAB Bug/Fighting → P5 only if strength ≥ 100** (so very weak Bug/Fighting isn’t forced to P5)
  - **Strong non‑STAB Bug/Fighting** reserve uses **strength ≥ 115** (instead of BP-only)
- Added migration flag **`state.ui._prioDefaultsStrengthThresholdsV2Applied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — prioØ uses effective Level stats (requested)
- Default prio strength now uses **effective offensive stats at the run’s claimed Level** (default L50), including:
  - **IV (claimedIV)**
  - **EV (claimedEV / strengthEV)** depending on Strength Charm toggle
  - **Nature multipliers** (e.g., Adamant/Modest; neutral natures remain 1.0)
  - **Limited deterministic ability multipliers** (Huge/Pure Power, Toxic Boost, Iron Fist, Technician, Reckless, Adaptability)
  - **Stable move power tweaks** (Bonemerang/Dual Chop/DoubleSlap/Acrobatics; Low Kick/Grass Knot treated as BP 60)
- Added migration flag **`state.ui._prioDefaultsEffectiveL50Applied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).
- Settings changes to claimed Level/IV/EV/Strength EV now trigger a **live auto-prio refresh** for all roster mons.

## Follow-up patch — Secret Sword + meta-tuned prio bands + Normal tier shift
- **Keldeo move correction**: uses **Secret Sword** and it is modeled as **Special** that **targets Def**.
- **Secret Sword power** set to **90 BP** (tool rules).
- Updated strength-to-tier thresholds to meta-tuned bands:
  - **P1**: strength < **75**
  - **P2**: < **105**
  - **P3**: < **140**
  - **P4**: < **190**
  - **P5**: ≥ **190**
- Updated reserve rules:
  - **STAB Bug/Fighting → P5** when **strength ≥ 115**
  - **Non‑STAB Bug with BP ≥ 100 → at least P4**
  - **Non‑STAB Fighting**: **strength ≥ 160 → at least P4**, **≥ 200 → P5**
- New default-only bias: **Normal-type attacking moves** shift **1 tier earlier** for stronger bands (**P3–P5 → P2–P4**).
- Added migration flag **`state.ui._prioDefaultsMetaBandsApplied`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — Retuned bands (75/110/160/220/260)
- Updated strength-to-tier thresholds to:
  - **P1**: strength < **75**
  - **P2**: < **110**
  - **P3**: < **160**
  - **P4**: < **220**
  - **P5**: ≥ **220** (very strong moves are often ≥ **260**, but remain P5)
- Kept reserve rules + Normal-tier shift unchanged.
- Added migration flag **`state.ui._prioDefaultsMetaBandsAppliedV2`** to refresh **auto** prios without overwriting manual prios (and skipping `lowPpBumped` moves).

## Follow-up patch — Hard roster cap + Dex back reliability
- Enforced a **hard roster size cap of 16** (the tool now prevents adding a 17th mon).
  - Add buttons are disabled when full; Add modal shows a “Roster is full” hint.
  - Migration clamps imported/legacy saves to the first **16** roster entries.
- Fixed Pokédex **Back to Roster** behavior:
  - Navigating within Pokédex (opening other entries) no longer overwrites the original return target.
  - Back button always prefers returning to roster when the Dex session started from a roster mon.

## Follow-up patch — Dex back fix for starters (robust return)

- Persist `ui.dexReturnRosterBase` alongside `ui.dexReturnRosterId` when opening Dex from a roster entry.
- Dex back now resolves the return roster entry by **id** first, then by **base species** as a fallback.
- Switching away from Dex to the Roster via the top nav also preserves this selection.

Files touched:
- `js/app/app.js`

## Patch — UI copy cleanup (remove remaining “Sim” wording)

- Base zip: `alpha_v1_sim_ui_reinf_order_preview_text_alpha_v1.zip`
- Date: 2026-02-27
- What changed:
  - Removed outdated references to a **Sim tab** and replaced “simulate” wording with **run/step/preview** wording.
  - Fight plan log toggle label now says **“Show battle log”** (no “simulated”).
- No feature/mechanics changes.

Files touched:
- `js/app/app.js`
- `js/state/migrate.js`

## Follow-up patch — Deterministic Dex origin + remove duplicate Dex button

- Replaced fragile Dex return inference with a deterministic `ui.dexOrigin` state:
  - Top-nav Pokédex starts a fresh **browsing** session (`dexOrigin='unlocked'`).
  - Opening Dex from a roster mon sets `dexOrigin='roster'` with roster id + base fallback.
  - Dex detail back button now routes strictly based on origin:
    - `roster` → returns to **Roster** (and reselects the originating mon when possible)
    - otherwise → returns to **Pokédex grid**
- Removed the duplicate **Dex** button in the roster list rows (next to **Edit**). Opening Dex is still possible via:
  - clicking the roster sprite, or
  - using the Dex button next to **Remove** in the details panel.

Files touched:
- `js/app/app.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`

## Follow-up patch — Fix “Back” buttons that sometimes do nothing (lost click on rerender)

- Back buttons in Pokédex detail now trigger on **pointerdown/mousedown** (not just click), to prevent lost-click issues when the Dex detail view re-renders due to async cache updates.
- Same pointerdown wiring added to **open Dex** actions from Roster (sprite + row title + details Dex button) to make navigation reliable for starters and any species.
- Open-Dex routing now uses a safe base fallback: `baseSpecies || effectiveSpecies`.

Files touched:
- `js/app/app.js`

## Patch — UI layout pack (Roster details grid + Bag tabs + Fight log actions)

- Base zip: `alpha_v1_sim_ui_copy_cleanup_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Roster**: Roster details panel now uses a **two-column layout** (left: charms/items/mods, right: move pool + add move) to reduce wasted space.
  - **Bag**: Added simple **category tabs** (All / Charms / Held / Plates / Gems). This is UI-only filtering.
  - **Waves → Fight log**: Each entry now shows **status + turns + PP spent**, and adds quick actions:
    - **Set starters** (apply attackers from that log entry)
    - **Select enemies** (apply defenders from that log entry)
  - No solver / mechanics changes.

Files touched:
- `js/app/app.js`
- `styles.css`

## Patch — Waves toolbar (non-clutter) + Fight log PP breakdown

- Base zip: `alpha_v1_sim_ui_layout_pack_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Waves**: Moved the wave-level controls (**Undo**, **Auto x4**, **All combos**, **Expand/Collapse all**) into a compact **wave toolbar** inside the **Fight plan** panel (keeps the Fight log panel simpler for newbies).
  - **Fight log**: Added per-attacker **PP breakdown** (shown in the expanded entry as `PP spent: Keldeo-1 · Virizion-1`, and as a tooltip on the `PP -X` pill).
  - **Fight log**: When item overrides are used, expanded entries now show an `Items: ...` line (UI metadata only).
  - No solver / prio / PP mechanics changes.

Files touched:
- `js/app/app.js`

## Patch — IN tooltip min–max + optional crit worst-case (UI-only)

- Base zip: `alpha_v1_sim_wave_toolbar_pp_breakdown_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Waves → Fight plan (Incoming pills)**: Tooltip now shows **min–max damage range** (and for AoE, worst-target range + per-target breakdown when available).
  - **Settings → Threat model**: Added a toggle **“IN tooltip: show crit worst-case (approx ×2)”**.
    - This is **display-only** and explicitly notes that crits are not modeled by the core engine.
  - No solver / prio / PP mechanics changes.

Files touched:
- `js/app/app.js`
- `js/state/defaultState.js`

## Patch — Crit + risk view (incoming), PP log clarity, outgoing crit tooltip (optional)

- Base zip: `alpha_v1_sim_in_tooltip_minmax_crit_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Threat model**: Added real **crit-aware damage ranges** (no more “approx ×2”).
    - Default crit multiplier: **1.5** (PokeMMO standard).
    - Optional selector: **1.5** or **2.0**.
  - **Incoming (IN) tooltip** (default ON): Added **risk view** using the true 16-roll distribution:
    - OHKO chance (roll)
    - OHKO chance (crit)
    - Total OHKO chance (includes crit at 6.25%)
    - Crit range line (worst-case range)
  - **Outgoing**: Display remains **min% (no crit)**; optional **late-game tooltip** can show roll+crit ranges (default OFF).
  - **Battle log**: PP lines now show **before→after** (e.g. `PP 12→11/12`) to make multi-fight PP behavior unambiguous.
  - No changes to solver scoring, AoE spread rules, or move mechanics.

Files touched:
- `calc.js`

## Patch — Incoming damage uses your held items + prevent phantom enemy actions

- Base zip: `alpha_v1_sim_shell_bell_calc_fix_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - **Battle sim + fight logs**: Incoming damage (enemy → you) now correctly applies **your held item** (and per-wave **item override**) for defensive/speed effects.
  - **Threat model**: Incoming threat calculations now also respect per-wave **item overrides** for your held item.
  - **Battle sim UI**: “Incoming:” on enemy cards now reflects the **last executed** enemy action (prevents showing a move from a defender that fainted before acting).
  - No changes to AoE spread rules, solver scoring, prio tiers, or PP mechanics.

Files touched:
- `js/domain/battle.js`
- `js/domain/waves.js`
- `REPORT.md`
- `js/app/app.js`
- `js/domain/waves.js`
- `js/domain/battle.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`
- `styles.css`

## Patch — Add Shell Bell to item catalog (UI-only)

- Base zip: `alpha_v1_sim_crit_risk_ppfix_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - Added **Shell Bell** to the selectable held item catalog.
  - No shop/economy pricing was introduced; item effect is not simulated yet (selection + bag tracking only).
  - No solver / prio / PP / battle mechanics changes.

Files touched:
- `js/domain/items.js`
- `REPORT.md`

## Patch — Fix calc.js minPct ReferenceError (hotfix)

- Base zip: `alpha_v1_sim_shell_bell_alpha_v1.zip`
- Date: 2026-02-27
- What was changed / checked:
  - Fixed a runtime crash in `computeDamageRange()` where `minPct` was referenced but never defined.
  - No mechanics changes; damage values and guarantees remain the same.

Files touched:
- `calc.js`

## Patch — Helping Hand tag no longer boosts damage (opt-in only)

- Base zip: `alpha_v1_sim_incoming_items_phantom_fix_alpha_v1.zip`
- Date: 2026-02-28
- What was changed / checked:
  - Fixed an incorrect damage multiplier where the `HH` tag (used to mean “has Helping Hand in moveset”) was treated as “Helping Hand is active now”.
  - Helping Hand is now **opt-in only** via `settings.helpingHandActive` (default false; no UI toggle added).
  - Sanity check (matches in-game): Panpour Lv50 → Torchic Lv47 with Hidden Power (Ground) shows **74.7% min** (no HH). With HH active it becomes **113.1% min**.

Files touched:
- `calc.js`
- `REPORT.md`


---

## Patch: 2v34_turnflow_stu_multihit_alpha_v1
- **Base zip:** `alpha_v1_sim_incoming_items_hh_optin_alpha_v1.zip`
- **Date:** 2026-02-28
- **Scope:** 2v3/2v4 correctness (join order + PP spend) + stop phantom actions + STU multi-hit sanity

### What changed / checked

#### Battle engine (2v3 / 2v4)
- **Deterministic reinforcements**: both sides now auto-fill empty active slots from bench in **join order** (#3/#4).
  - Replacements are available for targeting immediately after a faint.
  - Replacements do **not** get an action in the same turn (action list is built from turn-start actives).
- **No phantom actions**: action execution now stops as soon as the battle is decided (prevents "late" enemy lines and prevents PP spend when no targets remain).
- **Enemy retargeting**: for single-target enemy actions, if the chosen target fainted earlier in the turn, the enemy redirects to another alive active attacker.
- **Dev-facing audit hooks**: battle state now records lightweight `_audit` info (JSON-safe) to help catch PP double-spend / duplicate execution keys.

#### Damage calc (STU + deterministic multi-hit)
- **STU (Sturdy) percent outputs fixed**: returned `min/max/minPct/maxPct` are now derived from the (possibly STU-capped) **16-roll distribution**.
  - This makes displayed min% and solver decisions reflect STU correctly.
- **Deterministic multi-hit beats STU**: for fixed-hit moves modeled deterministically (currently **Bonemerang, Dual Chop, DoubleSlap**), the STU "leave 1 HP" cap is **skipped**.
  - This fixes the common "Bonemerang shows 99%" issue against full-HP STU targets.

### Sanity invariants
- AoE spread ×0.75 is still applied **exactly once** (calc stays single-target; battle applies spread at execution).
- Outgoing display remains **min roll, no crit** (unchanged).
- HH tag still does **not** auto-apply Helping Hand (unchanged).

### Touched files
- `js/domain/battle.js`
- `calc.js`
- `REPORT.md`


---

## Patch: global_intimidate_merge_alpha_v1
- **Base zip:** `alpha_v1_sim_2v34_turnflow_stu_multihit_alpha_v1.zip`
- **Date:** 2026-02-28
- **Scope:** Global INT (lead-only) applied consistently (preview + autoscore + sim)

### What changed / checked
- **Global INT semantics implemented (lead-only):** if either enemy **lead** has `INT`, your physical attackers get `-1 Atk stage` for the fight start **regardless of which defender is targeted**.
  - Reinforcement INT does **not** trigger (per spec).
- **Damage calc support:** `calc.computeDamageRange()` now applies INT if either:
  - target has `INT` tag, **or**
  - `settings.globalIntimidate === true`
- **Battle sim:** `initBattleForWave()` computes `battle.globalIntimidate` from the selected lead pair and propagates it into outgoing damage ranges.
- **Autoscore + Fight plan:** lead INT is detected from the wave's selected defenders and passed to outgoing move evaluation and the 1-turn plan simulator.
- **Incoming damage unchanged:** incoming uses `applyINT:false` already; global INT is not applied to enemy→you threat checks.

### Sanity invariants
- AoE spread ×0.75 still applied exactly once.
- Outgoing display remains min-roll, no-crit (unless user enables outgoing tooltip; default OFF).
- HH tag remains non-buffing by default.

### Touched files
- `calc.js`
- `js/domain/battle.js`
- `js/domain/waves.js`
- `js/app/app.js`
- `REPORT.md`


---

## Patch: intimidate_stack_join_competitive_alpha_v1
- **Base zip:** `alpha_v1_sim_global_intimidate_merge_alpha_v1.zip`
- **Date:** 2026-02-28
- **Scope:** INT stacking + reinforcement triggers + Competitive reaction (preview + autoscore + sim parity)

### What changed / checked
- **INT stacking (leads):** if *both* enemy leads have `INT`, Intimidate now applies **twice** at battle start (equivalent to `-2 Atk stage` on affected attackers).
- **INT triggers on defender entry:** when an `INT` defender joins as a reinforcement (#3/#4), Intimidate triggers again immediately and affects the currently active attackers.
- **Competitive / Defiant reactions (modeled for INT only):**
  - **Competitive**: affected attacker gains `+2 SpA stage` per Intimidate activation.
  - **Defiant**: affected attacker gains `+2 Atk stage` per Intimidate activation (optional support; harmless if unused).
- **Refactor: INT is no longer applied inside calc by tags/settings:**
  - `calc.js` no longer auto-decrements Atk from `INT` tags or `settings.globalIntimidate`.
  - Instead, callers pass the effective `atkStage/spaStage` (derived from battle state or lead-pair assumptions), eliminating double-count risk and enabling stacking.
- **Parity guarantee:**
  - **Battle sim** applies INT via `battle.stageDelta` at init and on defender joins.
  - **Autoscore + Fight plan** apply the same lead-pair INT count and Competitive/Defiant adjustments when evaluating moves.

### Sanity invariants
- AoE spread ×0.75 still applied exactly once.
- Outgoing display remains min-roll, no-crit (unless user enables outgoing tooltip; default OFF).
- HH tag remains semantics-only (no auto Helping Hand buff).

### Touched files
- `calc.js`
- `js/domain/battle.js`
- `js/domain/waves.js`
- `js/app/app.js`
- `REPORT.md`

---

## Patch: outspeed_items_incoming_abilities_alpha_v1
- **Base zip:** `alpha_v1_sim_bundle_allnext_alpha_v1.zip`
- **Date:** 2026-02-28
- **Scope:** Speed-aware Auto x4 ranking + Fight plan item tips + incoming ability immunities (threat model)

### What changed / checked
- **Auto x4 now respects outspeeding more (prio cap rule):**
  - When a schedule is already in the *good* band (`prioØ ≤ 3.5`), schedule ranking prefers **fewer executed enemy actions** (proxy for outspeed / no-damage clears), before tie-breaking by turns/PP.
  - Added per-fight `defActs` metric and schedule aggregates `defActsTotal/defActsMax`.
  - Added a *local* speed preference in attacker-pair tuple scoring: when `avgPrio ≤ 3.5`, prefer fewer `SLOW` matchups (enemy acts first).
- **Fight plan now recommends AVAILABLE bag items when they materially improve the lead matchup:**
  - Tips trigger only when an item can flip **SLOW→FAST** (e.g., Choice Scarf), enable **OHKO**, or allow a **lower-prio OHKO**.
  - Tips respect bag availability using `availableCountWithItemOverrides()` (no ghost suggestions).
- **Incoming ability effects (threat model) now account for defender ability immunities + Thick Fat:**
  - `waves.js` passes `settings.defenderAbility` for incoming computations.
  - `calc.js` applies minimal defender-ability modifiers (when provided):
    - immunities: Levitate (Ground), Lightning Rod/Motor Drive/Volt Absorb (Electric), Flash Fire (Fire), Water Absorb/Storm Drain/Dry Skin (Water), Sap Sipper (Grass)
    - Thick Fat: halves Fire/Ice damage
- **INT immunity parity:**
  - `Clear Body / White Smoke / Hyper Cutter / Full Metal Body` now block Intimidate consistently in `waves.js` + Fight plan (and therefore also block Competitive/Defiant triggers).
- **Parity fix:** Fight plan 1-turn preview now orders attacker actions by **speed-desc** (matches battle engine; move "prio" is a planning tier).

### Sanity invariants
- AoE spread ×0.75 still applied exactly once.
- Outgoing display remains min-roll, no-crit (unless user enables outgoing tooltip; default OFF).
- HH tag remains semantics-only (no auto Helping Hand buff).
- Enemy IV baseline unchanged.

### Touched files
- `js/app/app.js`
- `js/domain/waves.js`
- `calc.js`
- `REPORT.md`

---

## Patch: cleanup_shellbell_gems_alpha_v1
- **Base zip:** `working build.zip` (apply on top of: `alpha_v1_sim_sprite_assets_patch.zip` when available)
- **Date:** 2026-02-28
- **Scope:** Standards cleanup + real Shell Bell healing + real Gem consumption semantics (battle engine)

### What changed / checked
- **Cleanup:** removed deprecated legacy logs: `reports/*.txt` (REPORT.md remains the only history log).
- **Shell Bell (battle sim):** after a damaging attacker action, heal attacker by `floor(totalDamage/8)` (HP% space), clamped to max.
  - **AoE note:** totalDamage is summed across all *opponent* targets damaged by the move (partner damage is ignored).
- **Gems (battle sim):** modeled as true consumables:
  - If attacker holds `<Type> Gem` and uses a move whose *computed* `moveType` matches (incl. Weather Ball), apply **×1.5** power for that action.
  - Gem is then consumed for the rest of the battle via `battle.itemOverrideRuntime` (roster is not mutated).
  - Planner / preview remains simplified (calc keeps always-on ×1.3 gem modeling unless the battle engine is used).
- **Calc support:** added optional `settings.powerMult` (alias `settings.gemMult`) so the battle engine can apply consumable boosts without rewriting item logic.

### Sanity invariants
- AoE spread ×0.75 still applied exactly once.
- Outgoing display remains min-roll, no-crit (tooltip default OFF).
- Crit mult remains 1.5.
- HH tag remains semantics-only (no auto Helping Hand buff).
- Enemy IV baseline unchanged.

### Touched files
- `reports/sanity_report.txt` (deleted)
- `reports/weather_ball_drizzle_report.txt` (deleted)
- `calc.js`
- `js/domain/battle.js`
- `REPORT.md`

---

## Patch: icons_items_autox4_sandhail_sheerforce_alpha_v1
- **Base zip:** `alpha_v1_sim_patch_cleanup_shellbell_gems.zip` + `alpha_v1_sim_sprite_assets_patch_borderless.zip`
- **Date:** 2026-03-01
- **Scope:** Merge borderless icon patch + item-aware Auto x4 + Sand/Hail chip + Sheer Force from metadata (with fallback)

### What changed / checked
- **Merged borderless icon patch:**
  - Added lightweight icon loader and item icon map.
  - Included `styles.css` tweaks from the overlay.
- **Auto x4 (bag-aware items):**
  - Auto x4 signature now includes **bag inventory** so cached alts invalidate correctly when bag changes.
  - During candidate scoring, if a fight would otherwise fail, Auto x4 now attempts a **bag-available item override** (per-wave) for the two attackers to salvage the win.
  - Respects inventory counts via `availableCountWithItemOverrides()` (no ghost assignments).
  - Chosen alt now stores `itemOverride`, and applying an alt also applies those overrides before simming fights.
- **Battle sim: Sand/Hail chip**
  - End-of-turn residual damage modeled as **1/16 max HP** in HP% space.
  - Immunities:
    - Sand: Rock / Ground / Steel
    - Hail: Ice
  - Chip can KO and will trigger immediate reinforcement fill.
- **Sheer Force eligibility from metadata:**
  - Added a small PokéAPI-backed move meta cache for Sheer Force detection (cached in `localStorage`).
  - Calc uses metadata when available, falling back to the existing approximation set when offline / missing.

### Sanity invariants
- AoE spread ×0.75 applied exactly once.
- Outgoing display remains min-roll, no-crit (tooltip default OFF).
- Crit mult remains 1.5.
- HH tag remains semantics-only (no auto Helping Hand buff).
- Enemy IV baseline unchanged.

### Touched files
- `js/app/app.js`
- `js/domain/battle.js`
- `calc.js`
- `js/main.js`
- `js/services/moveMeta.js` (new)
- `js/ui/icons.js` (from overlay)
- `assets/pokeicons/itemIconMap.json` (from overlay)
- `styles.css` (from overlay)
- `REPORT.md`


## Patch — Auto x4 full item optimization toggle
- **Base zip:** `alpha_v1_sim_patch_items_autox4_sandhail_sheerforce_icons.zip`
- **Date:** 2026-03-01
- **Scope:** Make Auto x4 item overrides optimize already-winning fights (optional toggle)

### What changed / checked
- **Auto x4: full optimization mode**
  - When enabled, Auto x4 now suggests **bag-held item overrides even for fights that already win**, aiming to improve prioØ / turns / PP.
  - Uses a **strict improvement** rule so it won’t churn/allocate scarce items on ties.
- **Settings UI**
  - Added toggles:
    - `autoSolveUseItems` (enable/disable item usage entirely)
    - `autoSolveOptimizeItems` (enable/disable full optimization; can be slower)
- **Defaults**
  - Added both settings to the default state with safe defaults (`true`).

### Touched files
- `js/app/app.js`
- `js/state/defaultState.js`
- `REPORT.md`

---

## Patch: autox4_signature_iovr_deepsearch_toggle
- **Base zip:** `alpha_v1_sim_FULLSANITY.zip`
- **Date:** 2026-03-01
- **Scope:** Auto x4 cache correctness + deep-search escape hatch (UI-only)
- **Feature changes:** **Yes** (new setting toggle; defaults preserve existing behavior)

### What changed
- **Auto x4 cache signature now includes**
  - `wave.itemOverride` (bag-held item overrides per attacker)
  - solver toggles: `autoSolveUseItems`, `autoSolveOptimizeItems`, `autoSolveDeepSearch`
  - This prevents reusing cached alternatives after changing overrides/settings.
- **New setting:** `autoSolveDeepSearch` (default **ON**)
  - When ON, Auto x4 keeps the existing behavior: for **≤8 defenders**, it forces the generation cap to **≥20k**.
  - When OFF, Auto x4 respects **Max combos generated** exactly (helps avoid slow/stuck solves).

### Touched files
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `js/state/defaultState.js`
- `js/ui/tabs/settingsTab.js`
- `REPORT.md`

---

## Patch: fightplan_inline_item_slow_warnings
- **Base zip:** `alpha_v1_sim_FULLSANITY.zip` + Patch 1 overlay
- **Date:** 2026-03-01
- **Scope:** Fight plan UI warnings (visual emphasis only)
- **Feature changes:** **No** (UI-only)

### What changed
- **Fight plan: stronger warnings near item selectors**
  - If an item tip exists, show a **red inline warning** next to the item override slots.
  - If any matchup is **SLOW** (enemy acts first), show a **red inline warning** next to the item override slots.
- **SLOW pill + speed warning line are now red** (more visible).
- **Item tips line is no longer muted** (now uses a red warning style).

### Touched files
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `styles.css`
- `REPORT.md`

## Patch 1a hotfix — Fix JS syntax error in item warning tooltip
- Fix invalid newline token in wavePlannerPanel.js itemWarnInline.title (use \\n + join("\\n")).


---

## Patch: autox4_weather_pruning_and_prio_gating
- **Base zip:** `alpha_v1_sim_FULLSANITY.zip` + Patch 1 + Patch 1a + Patch 2 overlays
- **Date:** 2026-03-01
- **Scope:** Auto x4 schedule generation correctness (weather-aware pruning + prio gating consistency)
- **Feature changes:** **Yes** (Auto x4 results can change on weather waves and in-speed-pruning cases)

### Why
Auto x4 had two correctness drifts:
- Early tuple pruning used a speed tie-break **inside** the good prio band (prioØ ≤ 3.5), even though the final schedule comparator ignores speed when any in-band solution exists.
- Early best-move selection (`bestMoveFor2`) did not apply inferred weather and cached only by `(attId, defKey)`, which can mis-rank/prune weather-dependent solutions (Weather Ball + rain/sun boosts).

### What changed
- **Prio gating parity:** `betterT()` now considers `slowerCount` **only when both tuples are out of band** (avgPrio > 3.5). In-band comparisons ignore outspeed penalties.
- **Weather-aware best-move caching:** `bestMoveFor2(attId, defKey, weather)`
  - cache key now includes weather
  - applies `withWeatherSettings(...)` before calling `calc.chooseBestMove(...)`
- **Pair-context weather inference:** `getPairChoicesByKeys(...)` now infers weather from the **attacker pair + defender pair** leads and passes it into `bestMoveFor2(...)`.

### Touched files
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `REPORT.md`


---

## Patch: planner_gems_1p5_and_defender_ability_fallback
- **Base zip:** `alpha_v1_sim_FULLSANITY.zip` + Patch 1 + Patch 1a (+ hotfix) + Patch 2 + Patch 3 overlays
- **Date:** 2026-03-01
- **Scope:** Planner/calc consistency (Gems magnitude + defender immunity previews)
- **Feature changes:** **Yes** (planner preview numbers can change; battle sim unchanged)

### Why
Two preview drifts were still causing "planner said X, sim did Y" moments:
- Gems were modeled as ×1.3 in planner while the battle sim uses ×1.5.
- Defender immunities (Levitate / Lightning Rod / Motor Drive / etc.) can be missed in planner previews when `defenderAbility` isn’t passed.

### What changed
- **Gems in planner are now ×1.5** to match the battle sim magnitude. (Still modeled as always-on in `calc.js` for speed; consumption remains battle-sim-only.)
- **Defender ability fallback in calc:** when `settings.defenderAbility` is missing and the defender has no explicit ability, `calc.js` falls back to the pinned ability from `data.claimedSets[species].ability`.

### Touched files
- `calc.js`
- `REPORT.md`


---

## Patch: applyINT_toggle_is_real
- **Base zip:** `alpha_v1_sim_FULLSANITY.zip` + Patch 1 + Patch 1a (+ hotfix) + Patch 2 + Patch 3 + Patch 4 overlays
- **Date:** 2026-03-01
- **Scope:** Make **Apply Intimidate (INT tag)** setting functional across planner + battle sim
- **Feature changes:** **No by default** (only changes behavior when the user turns the toggle OFF)

### Why
The Settings UI exposed `settings.applyINT`, but INT stage drops were applied unconditionally wherever INT logic runs.
That made the toggle feel "dead" and caused confusion.

### What changed
- **Planner / solver settings:** INT application now respects `settings.applyINT`.
  - `applyEnemyIntimidateToSettings(...)` returns the input settings unchanged when `applyINT === false`.
- **Battle sim:** enemy Intimidate triggers are skipped when `settings.applyINT === false`.
  - Lead-start INT and defender-join INT no longer apply stage drops or log "Enemy Intimidate activated" when disabled.

### Touched files
- `js/domain/waves.js`
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `js/domain/battle.js`
- `REPORT.md`


---

## Patch: air_balloon_pops_on_hit
- **Base zip:** `alpha_v1_sim_FULLSANITY.zip` + Patch 1 + Patch 1a (+ hotfix) + Patch 2 + Patch 3 + Patch 4 + Patch 5 overlays
- **Date:** 2026-03-01
- **Scope:** Implement **Air Balloon pops on hit** (battle sim), and make immunity checks item-override/runtime-correct
- **Feature changes:** **Yes** (battle-sim item realism; planner unchanged)

### Why
Air Balloon is defined as: **Ground immunity until hit, then consumed**.
The sim previously treated Air Balloon as a persistent Ground immunity item within a battle, and some immunity checks didn’t consistently respect wave item overrides or runtime-consumed items.

### What changed
- **Battle sim:** When a roster mon holding **Air Balloon** takes a **successful damaging hit**, the balloon **pops** and is removed for the rest of that battle.
- **Immunity checks:** Updated ally/enemy targeting paths to use the **effective held item** (including wave item overrides and runtime consumption) when determining ability/item immunities.

### Touched files
- `js/domain/battle.js`
- `REPORT.md`


---

## Patch: consumables_across_fights_bag_ledger
- **Base zip:** `alpha_v1_sim_FULLSANITY.zip` + Patch 1 + Patch 1a (+ hotfix) + Patch 2 + Patch 3 + Patch 4 + Patch 5 + Patch 6 overlays
- **Date:** 2026-03-01
- **Scope:** Make **consumables** (Gems + Air Balloon) debit the **Bag across fights/waves** when a fight is logged
- **Feature changes:** **Yes** (run economy realism; planner unchanged)

### Why
The battle sim already models real in-battle semantics (Gems consumed on use, Air Balloon pops on hit), but this consumption was **battle-local** only.
That allowed the same consumable to be reused across the wave's 4 fights (and later waves), which is misleading for shrine economy planning.

### What changed
- **Battle sim:** now records consumable usage in `battle.consumed[]` whenever:
  - a matching **Type Gem** activates, or
  - **Air Balloon** pops.
- **Wave fight log (when a fight is logged):**
  - debits `state.bag[item]` by 1 per consumed item,
  - removes the consumed held item assignment (from wave itemOverride first, otherwise from the roster held item),
  - stores `bagDelta` + `consumedItems` on the fight entry so **Undo** can restore them.

### Touched files
- `js/domain/battle.js`
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `REPORT.md`

---

## Patch: items_critstage_focussash_loadedice_orb_leftovers_metronome
- **Base zip:** current mainline (FULLSANITY + Patches 1/1a/hotfix/2/3/4/5/6/8)
- **Date:** 2026-03-01
- **Scope:** Implement missing held-item combat effects + crit-stage display
- **Feature changes:** **Yes** (battle-sim item realism + calc support)

### Why
Several core items were present in the catalog/UI but had no combat effect (selection-only), and crit-stage items (Scope Lens) weren’t reflected anywhere.
This patch implements the most important missing effects while keeping deterministic planning defaults.

### What changed
- **calc.js**
  - Added **crit stage + crit chance** derivation (Scope Lens = +1 stage) and exposes `critStage`/`critChance` in results.
  - Added **Light Ball** (Pikachu only: doubles Atk/SpA) and **Thick Club** (Cubone/Marowak: doubles Atk).
  - Added **Loaded Dice** approximation for multi-hit moves (non–Skill Link: treat 2–5 hit moves as 4 hits).
  - Added **Focus Sash** defensive cap when at full HP (STU-like leave-1-HP behavior; multi-hit can still break it).
- **battle.js**
  - **Focus Sash** triggers on a KO-from-full hit: leaves at 1% in HP% space, consumes the sash, and records it in `battle.consumed[]` so Bag-ledger (Patch 8) debits it when the fight is logged.
  - **Life Orb** recoil: -10% HP after a successful damaging action (post Shell Bell).
  - **Leftovers** heal: +6.25% HP at end-of-turn for active attackers.
  - **Metronome** stacking: +20% per consecutive use of the same move (up to +100%), applied via `otherMult`.
- **wavePlannerPanel.js**
  - Outgoing crit tooltip now includes a **Crit chance** line (when outTipCrit is enabled).
  - Incoming risk tooltip shows the computed crit% instead of a hard-coded 6.25% label.
- **waves.js**
  - Risk math uses `r.critChance` (defaults to 1/16 if absent) instead of hard-coded 1/16.

### Touched files
- `calc.js`
- `js/domain/battle.js`
- `js/domain/waves.js`
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `REPORT.md`

## Patch 10 — Choice items lock + Eviolite (evo-aware)

- **Choice Band/Specs/Scarf** now enforce **move lock** in the battle engine:
  - Once an attacker acts while holding a Choice item, they are locked into that move for the rest of the battle (unless the move becomes unusable; we release the lock rather than modeling Struggle).
  - Manual picks cannot break the lock; AUTO respects it.
  - STU coordinated plan respects lock too.
- **Eviolite** implemented as a defensive 1.5× multiplier (Def/SpD) **only if the current species can still evolve**:
  - Eligibility (`canEvolve`) is fetched lazily via PokéAPI evolution chain and cached in `state.dexMetaCache[species].canEvolve`.
  - App render loop ensures evo meta is requested for any roster mon (or wave itemOverride) holding Eviolite.
  - Incoming damage / risk preview passes `defenderCanEvolve` into calc so Eviolite affects threat math.



## Patch 11 — UI polish: Roster loadout editors + Bag vertical split

- **Roster details:** show **all 4 Pokémon of the selected player at once** (each slot gets its own move editor + quick toggles), reducing whitespace and removing the need to click-switch between mons.
- **Bag tab:** changed the Bag/Shop layout to a **vertical split** (side-by-side columns on wide screens; stacks on small screens).
- **Shop ordering:** **Evo Charm** and **Strength Charm** are now the first two shop cards.

### Touched files
- `js/ui/tabs/rosterTab.js`
- `js/ui/tabs/bagTab.js`
- `styles.css`
- `REPORT.md`

## Patch 11a — Hotfix: Roster tab JS syntax

- Fixed a duplicate `const used` declaration in `js/ui/tabs/rosterTab.js` introduced by the multi-panel loadout editor.

### Touched files
- `js/ui/tabs/rosterTab.js`
- `REPORT.md`


---

## Patch: ui_roster_cards_2x2_bag_shop_layout_undo
- **Base:** alpha_v1_sim_mainbuild + recent patch stack
- **Date:** 2026-03-01
- **Scope:** UI-only layout + clarity improvements (no mechanics)
- **Feature changes:** none (presentation only)

### Changes
- Roster details:
  - Removed redundant top detail header controls (A/Evo/Str/Item/Mods/Dex/Remove).
  - Added per-card **Mods** foldout (battle modifiers) and per-card **Remove (✕)**.
  - Item selector now shows a small **Item** label for clarity.
  - Move names show tooltips on hover (full name when truncated).
  - Loadout details grid stays **2×2** on normal screens (4-col only on ultra-wide).
- Bag:
  - Left column (Bag) narrower; right column (Shop) wider.
  - Shop grid targets **4 cards per row** on normal screens.
  - Item/type icons slightly larger for readability.
- Undo buttons:
  - Changed label to **↩ Undo** and added a stronger visual style.


---

## Patch: ui_roster_strip_remove_autotoggle_typeicons_shop_icons
- **Base:** alpha_v1_sim_mainbuild + recent patch stack
- **Date:** 2026-03-01
- **Scope:** UI-only polish (no mechanics)

### Changes
- Roster details:
  - Removed the redundant **loadout strip** above the 4-card editor (the 4 cards *are* the loadout).
  - Made the move-row **auto prio** badge clickable:
    - `auto` → click disables auto (keeps current prio)
    - `!auto` → click resets prio to the derived default and re-enables auto
  - Move type badges now carry `type-*` classes so they can render **type icons**.
- Type icons:
  - Added CSS-based **type icons** for type chips / dex type plates / move type badges (uses the existing `assets/pokeicons/types/*` files).
- Bag/Shop:
  - Bag column slightly narrower; Shop column wider.
  - Shop item/type icons bumped up in size for readability.

### Touched files
- `js/ui/tabs/rosterTab.js`
- `styles.css`
- `REPORT.md`


## PATCH 14 — Waves log controls + defender mods foldout + roster AUTO/MANUAL + UI polish

- Waves: moved **All combos** + **Expand/Collapse all** to the Fight log header; made them prominent.
- Waves: added per-entry expand/collapse chevron button; entries remain clickable.
- Waves: defender modifiers are now foldable (Mods ▼) to reduce clutter.
- Roster: replaced confusing auto badge with explicit **AUTO / MANUAL** prio mode; prio is locked while AUTO.
- Shop: slightly larger icons; shop card titles can wrap to avoid truncation.

## PATCH 14a — Hotfix: rosterTab syntax

- Fixed a syntax error in `js/ui/tabs/rosterTab.js` introduced in Patch 14 (removed stray duplicate closing block after prio mode toggle handler).
## PATCH 15 — UI polish (waves controls + defender mods + roster clarity + shop layout + type icons)

- Waves:
  - Fight log header controls (All combos + Expand/Collapse all) now have clearer active/pressed styling.
  - Per-entry chevron expander button is larger and more obvious.
  - Defender Mods foldout shows a clearer non-neutral indicator dot and a chevron.
  - Fight button styling strengthened as the primary CTA (disabled state remains subdued).
- Shop:
  - Dropdown shop cards (Gem/Plate/Rare Candy) are now stacked (title row + selector row) for a cleaner layout.
- Settings:
  - Renamed Auto solver section to **Auto x4 behavior** and clarified optimize-items label.
- Type icons:
  - Type icons now appear on **all** `.dex-plate.type-*` chips (including Type matchups), not only `dex-type` plates.

### Touched files
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `js/ui/tabs/bagTab.js`
- `js/ui/tabs/settingsTab.js`
- `styles.css`
- `REPORT.md`


## PATCH 16 — UI polish final + Dex API unification + README refresh

- Waves:
  - Fight button label uses a clear **⚔ Fight** CTA and stronger enabled styling.
  - Fight log per-entry chevron button is more obvious (bigger hitbox + clearer styling).
  - Defender Mods foldout: non-neutral state is highlighted more clearly.
- Dex/Unlocked:
  - Removed duplicated PokéAPI caching from `unlockedTab.js`; Unlocked now uses the shared helpers in `js/ui/dexApi.js`.
  - Kept the grid batching job intact to avoid jitter; only detail/meta fetching routes through shared helpers.
- Docs:
  - README rewritten with correct paths and clearer run/persistence notes.

### Touched files
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `styles.css`
- `js/ui/tabs/unlockedTab.js`
- `README.md`
- `REPORT.md`


## PATCH 17 — Data cleanup: canonicalize Lightning Rod ability

- Data:
  - Fixed a legacy typo in `data/claimedSets.json`: `Lightningrod` → `Lightning Rod` (Cubone/Marowak/Rhyhorn/Rhydon/Rhyperior).
- Runtime polish:
  - Removed the now-unneeded claimedSets ability normalizer from `js/data/loadData.js` (data is canonical).
  - Kept a tiny legacy mapping in `js/state/migrate.js` to auto-fix old localStorage saves that may still contain `Lightningrod`.

### Touched files
- `data/claimedSets.json`
- `js/data/loadData.js`
- `js/state/migrate.js`
- `REPORT.md`


## PATCH 18 — Roster UI: constrain long player names (ellipsis + tooltip)

- Roster / Party:
  - Player name pill no longer expands the Party header; long names stay one line and **ellipsize** (including unbroken strings).
  - Full player name remains accessible via hover tooltip.
- Roster details:
  - The `<playerName> — loadout` title is constrained to one line and ellipsizes without pushing layout.

### Touched files
- `js/ui/tabs/rosterTab.js`
- `styles.css`
- `REPORT.md`


## PATCH 19 — Roster / Party: slightly reduce name row height

- Party panel:
  - Reduced spacing on the Party card header (gap + bottom margin).
  - Slightly reduced padding/font-size on the player label + name pill for a more compact header row.

### Touched files
- `styles.css`
- `REPORT.md`


## PATCH 20 — Fixes: AoE ally-damage crash, weather preview consistency, undo Bag correctness

- Battle sim:
  - Fixed a P0 crash when AOE moves can damage the ally (e.g. Discharge/Surf/Earthquake) and Focus Sash logic runs.
    - Root cause: `nextHp` was declared `const` and then reassigned.
- UI correctness:
  - Weather preview inference now matches the battle engine behavior (slowest weather setter wins; defenders win speed ties).
  - Undo (fight log) now reverses only the logged Bag delta, so later shop buys/sells are not overwritten.
- PokeAPI helpers:
  - Centralized move fetch in `pokeApi` (`fetchMove`) and routed the Unlocked tab move description fetch through it.
- State hygiene:
  - `ensureWavePlan()` now prunes stale `attackMoveOverride` keys that reference missing attackers.
- Export:
  - Hardened download helper: Blob URL is revoked on the next tick to avoid rare browser download cancellations.

### Touched files
- `js/domain/battle.js`
- `js/ui/battleUiHelpers.js`
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `js/services/pokeApi.js`
- `js/ui/tabs/unlockedTab.js`
- `js/domain/waves.js`
- `js/services/storage.js`
- `REPORT.md`


## PATCH 21 — Move Run order control to Settings

- UI: moved the "Run order" control (start wave animal) from the Waves tab into Settings (left column), under Credits & Impressum.
- The setting continues to rotate wave display order within each phase (data unchanged).

### Touched files
- `js/ui/tabs/wavesTab.js`
- `js/ui/tabs/settingsTab.js`
- `REPORT.md`


## PATCH 22 — Credits + branding title

- Credits: added PokéSprite (msikma) attribution for inventory/item icon assets.
- Branding: updated the main site title to “Shrine Run Copilot” (document title + top-left header).

### Touched files
- `js/ui/tabs/settingsTab.js`
- `index.html`
- `README.md`
- `REPORT.md`


## PATCH 23 — Fix Easter egg mini-game (movement + robustness)

- Easter egg: the “Wild Encounter” mini-game is now playable again.
  - The Poké Ball relocates around the arena (periodically + on click), instead of staying stuck.
  - Hardened optional storage usage: localStorage failures won’t break binding.
  - Added guards so missing modal nodes fail silently (egg is optional and should never crash the app).

### Touched files
- `js/ui/eggGame.js`
- `REPORT.md`


## PATCH 24 — Easter egg: Settings code trigger + 30s upgrade

- Easter egg trigger: removed the title-click binder and added a small password field in Settings (code: `0220`).
- Mini-game: upgraded to 30 seconds with streak → multiplier scoring, difficulty ramp (faster moves + slightly smaller ball), decoys, and occasional “golden” bonus hits.

### Touched files
- `js/main.js`
- `js/ui/eggGame.js`
- `js/ui/tabs/settingsTab.js`
- `index.html`
- `styles.css`
- `REPORT.md`


## PATCH 25 — Easter egg: Share/download highscore plate

- Mini-game: added a **Share** button that downloads a PNG “score plate” (current score + best + accuracy + max streak/mult, plus timestamp).

### Touched files
- `index.html`
- `styles.css`
- `js/ui/eggGame.js`
- `REPORT.md`


## PATCH 26 — Pokédex: search input no longer loses focus after 1 character

- Fixed a UX regression where typing into the Pokédex Search field would drop focus after the first character due to full-tab re-rendering.
- The search box now preserves focus and caret position across the re-render triggered by `store.update()`.

### Touched files
- `js/ui/tabs/unlockedTab.js`
- `REPORT.md`


## PATCH 27 — Pokédex: search matches Pokémon, abilities, and moves + compact search field

- Pokédex Search now matches **Pokémon names**, **claimed abilities**, and **claimed moves** (token-based, includes Hidden Power/HP aliasing).
- UX: search field is now visually compact (no more full-width “3 miles long” input).
- Added a small “No matches” hint instead of an empty grid.

### Touched files
- `js/ui/tabs/unlockedTab.js`
- `styles.css`
- `REPORT.md`

## PATCH 28 — Battle sim parity fixes + weather preview hardening

- **Battle engine correctness (multi-action turns):** attacker single-target damage is now recomputed at execution time (prevents stale min% when reinforcements/join triggers change INT/weather mid-turn).
- **AoE attacker moves:** now apply Metronome tracking and Life Orb recoil (with recoil KO handling), matching single-target semantics.
- **AoE partner immunity boosts:** when your AoE would hit an immune partner (e.g., Lightning Rod / Motor Drive / Storm Drain / Sap Sipper), the +1 stage boost is applied immediately so later actions in the same turn reflect it.
- **Gems + Weather Ball parity:** AoE execution captures the computed moveType and uses it for gem logic (handles weather-dependent typing).
- **Friendly-fire safety:** ally immunity checks are now case-insensitive (battle + waves), preventing false warnings from casing drift.
- **Waves Fight-plan preview:** deterministic preview sim now applies the inferred wave weather explicitly (prevents planner vs sim drift in dual-setter matchups).
- **Pokédex move text:** removed direct PokéAPI fetch fallback; move descriptions always route through the canonical `pokeApi.fetchMove()` helper.
- **Startup hardening:** move meta cache now guards localStorage access with try/catch (privacy modes won’t crash boot).
- **DOM helper hardening:** `el({ html: ... })` renamed to `el({ unsafeHtml: ... })` (no callsites used `html`).
- **Boot-order hardening:** removed `defer` from `calc.js` (script already at end of body).
- **Comment clarity:** migration comment marker renamed from `v20` → `PATCH`.

### Touched files
- `js/domain/battle.js`
- `js/domain/waves.js`
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `js/ui/tabs/unlockedTab.js`
- `js/services/moveMeta.js`
- `js/ui/dom.js`
- `js/state/migrate.js`
- `index.html`
- `REPORT.md`

## PATCH 29 — Waves preview weather parity (complete)

- Waves preview calculations now **always apply the inferred wave weather explicitly** (AOE side-hit preview, friendly-fire preview, crit tooltip, Auto x4 local sim helpers, STU AoE solve helper, and suggested lead pairs scoring).
- Fixes remaining planner/preview drift where `calc` could fall back to ability OR-order weather inference instead of the already-correct speed-resolved `waveWeather`.

### Touched files
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `REPORT.md`


## PATCH 30 — Save-size hardening + PokéAPI fetch unification

- **Persistence bloat fix:** battle `_audit` payload is now **non-enumerable** (won’t serialize into localStorage) to prevent save growth / quota failures during long sessions.
- **State cleanup on load:** any persisted `battles[*]._audit` blobs are removed during `hydrateState()` (keeps existing saves small).
- **Single canonical PokéAPI helper:** move-meta priming now prefers `pokeApi.fetchMove()` (shared path) with a small timeout guard to avoid hanging forever on bad networks.

### Touched files
- `js/domain/battle.js`
- `js/state/migrate.js`
- `js/services/moveMeta.js`
- `js/main.js`
- `REPORT.md`


## PATCH 31 — Pokédex move text: resolve effect chance placeholders

- PokéAPI move effect text often includes a **$effect_chance** placeholder (e.g., Flamethrower burn chance).
- The Pokédex detail view now replaces **$effect_chance** with the numeric chance from the PokéAPI move payload when available, so the UI shows proper percentages.

### Touched files
- `js/ui/tabs/unlockedTab.js`
- `REPORT.md`


## PATCH 32 — Nian checkpoint PP logger: roster-id correctness + clean-plan baseline + claimed overview

- **Fix:** Nian checkpoint selectors now use **rosterMon.id** (not array indices). This makes PP debit / undo update the same canonical IDs used by Roster + planner.
- **Compatibility:** older saves that stored party IDs as array indices are normalized on load/render.
- **Clean plan baseline:** default clean run assumes **Empoleon Scald×2 + Flash Cannon×1** (matches the intended “good RNG” baseline; use Advanced to deviate).
- **Overview cue:** checkpoint dividers now show a **LOGGED** status pill and a claimed-tinted divider after a successful PP log; Undo clears it when it was created by the last action.

### Touched files
- `js/ui/tabs/wavesTab.js`
- `styles.css`
- `REPORT.md`


## PATCH 33 — Wave overview: LOGGED status when fights + loot are logged

- Wave cards now show a **LOGGED** pill (and a subtle claimed tint) when the wave has **4 fights logged** AND its **wave loot item is claimed**.
- This gives a fast collapsed overview of “fully logged” waves (fights + loot), similar to the Nian checkpoint overview cue.

### Touched files
- `js/ui/tabs/waves/wavePlanner.js`
- `styles.css`
- `REPORT.md`


## PATCH 34 — Bonus boss Politoed: paid unlock checkpoint (no sim yet)

- Added a **BONUS BOSS** checkpoint at the end of Waves as a simple **paid unlock**:
  - Button **Pay 10g & unlock Politoed** (requires `shop.gold >= 10`).
  - Marks the divider **logged** for overview and unlocks **Politoed** in the roster add list.
  - **Undo** refunds the gold and removes the unlock (Undo is disabled while Politoed is already in roster to avoid confusing state).
- Added a migration cleanup that removes experimental invalid unlock keys like `BONUS_POLITOED_*` from older dev patches.

### Touched files
- `js/ui/tabs/wavesTab.js`
- `js/state/migrate.js`
- `REPORT.md`


## PATCH 35 — Boss dividers: normalize LOGGED pill casing

- Nian checkpoint dividers and the bonus boss divider now display the overview pill as **LOGGED** (uppercase) for consistency with wave cards and checkpoint headers.

### Touched files
- `js/ui/tabs/wavesTab.js`
- `REPORT.md`


## PATCH 36 — Auto starters: include worstPrio tie-breaker (no drift vs Suggested)

- Auto starter picking now uses the same tie-break ordering as the Suggested lead pairs list:
  - `clearAll desc` → `ohkoPairs desc` → `worstPrio asc` → `prioØ asc` → `overkill asc`
- This eliminates rare tie cases where Auto could pick a different pair than the top Suggested entry.

### Touched files
- `js/domain/waves.js`
- `REPORT.md`


## PATCH 37 — Boss checkpoints: expand/collapse style alignment + cp1..cp7 support

- Nian checkpoint panel is now available after **every** NIAN BOSS divider (cp1..cp7).
- Boss divider toggle now uses the same **Expand/Collapse** wording + button style as wave cards.
- Nian + bonus boss checkpoint cards are styled to match normal wave cards:
  - consistent border/background
  - LOGGED cards get the same green “logged” tint
- Primary CTA wording aligned with the wave planner: **Fight** / **Fight (N turns)**.

### Touched files
- `js/ui/tabs/wavesTab.js`
- `styles.css`
- `REPORT.md`


## PATCH 38 — Evolution ability parity + AoE preview parity

- Fixed claimed-set abilities for evolution lines where the ability changes on evolution:
  - Herdier/Stoutland now use **Intimidate** (base Lillipup remains Vital Spirit).
  - Mightyena now uses **Intimidate** (base Poochyena remains Rattled).
- Evo toggle now applies the **effective species** claimed-set ability (when available), so battle engine + previews reflect the correct evolved ability.
- Fight plan AoE preview now prefers the per-turn `planSim` side-target info, so it won’t show a phantom “also X” (or wrong spread label) when the other lead was already KO’d before the AoE user acts.

### Touched files
- `data/claimedSets.json`
- `js/domain/roster.js`
- `js/ui/tabs/waves/planner/wavePlannerPanel.js`
- `REPORT.md`


## PATCH 39 — Sucker Punch BP fix + Move BP override debug tool

- Fixed **Sucker Punch** base power to **70** (PokeMMO expectation).
- Added a Settings debug tool to hotfix move base power without editing data files:
  - Toggle: **Enable move BP overrides (debug)**
  - Editor: set/clear per-move BP overrides (stored in save state)
- Move BP overrides affect damage calcs **and** default prio estimation (so auto prios can be recomputed consistently).

### Touched files
- `data/moves.json`
- `calc.js`
- `js/domain/roster.js`
- `js/state/defaultState.js`
- `js/state/migrate.js`
- `js/ui/tabs/settingsTab.js`
- `REPORT.md`


## PATCH 39b — Show BP overrides in UI

- When **Enable move BP overrides (debug)** is ON, move lists display the overridden BP so UI matches the calc.

### Touched files
- `js/ui/tabs/rosterTab.js`
- `js/ui/tabs/unlockedTab.js`
- `REPORT.md`


## PATCH 39c — Prevent stale JSON cache on reload

- GitHub Pages (and some browsers) can keep serving cached JSON assets after deployment.
- Data loads now use `fetch(..., { cache: 'no-store' })` so a normal refresh reliably picks up updated `moves.json` (and other data) without needing a hard refresh.

### Touched files
- `js/data/loadData.js`
- `REPORT.md`


## PATCH 41 — Nian checkpoint 2 reward + TM Fling placeholder

- Added **Checkpoint 2** reward: **+10 gold + 1× TM - Fling (once)**. Reward is granted only if PP was actually logged and is undoable.
- Added **Fling** to `data/moves.json` (placeholder BP=50; use BP override debug tool if needed).

### Touched files
- `js/ui/tabs/wavesTab.js`
- `data/moves.json`
- `REPORT.md`

