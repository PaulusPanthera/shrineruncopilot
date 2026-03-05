// js/domain/roster.js
// alpha v1
// Roster modeling and move pool utilities.

import { EVO_OVERRIDES, EVO_PRESET } from '../services/pokeApi.js';
import { applyMovesetOverrides, defaultNatureForSpecies } from './shrineRules.js';

export const STARTERS = new Set(['Cobalion','Keldeo','Terrakion','Virizion']);

export function isStarterSpecies(species){
  return STARTERS.has(species);
}

function uniq(arr){
  return Array.from(new Set(arr));
}

export function moveInfo(data, moveName){
  if (!moveName) return null;
  return data.moves?.[moveName] || null;
}

export function isStabMove(data, species, moveName){
  const d = data.dex?.[species];
  const mi = moveInfo(data, moveName);
  if (!d || !mi) return false;
  return Array.isArray(d.types) && d.types.includes(mi.type);
}

// --- Stat helpers (prio defaults only) ---
// We intentionally keep these local (and lightweight) so default prio logic can be run
// without importing the full damage engine.
function floor(n){ return Math.floor(n); }

// Non-HP stat formula (Gen 3+). Nature multiplier applied after the base stat calc.
function statOther(base, level, iv, ev, natureMult=1.0){
  const evq = floor((Number(ev)||0)/4);
  const b = Number(base)||0;
  const L = Number(level)||50;
  const I = Number(iv)||31;
  const raw = floor(((2*b + I + evq) * L)/100) + 5;
  return floor(raw * (Number(natureMult)||1));
}

const NATURES = {
  // +Atk
  Adamant: {plus:'atk', minus:'spa'},
  Lonely: {plus:'atk', minus:'def'},
  Brave: {plus:'atk', minus:'spe'},
  Naughty: {plus:'atk', minus:'spd'},
  // +Def
  Bold: {plus:'def', minus:'atk'},
  Impish: {plus:'def', minus:'spa'},
  Relaxed: {plus:'def', minus:'spe'},
  Lax: {plus:'def', minus:'spd'},
  // +SpA
  Modest: {plus:'spa', minus:'atk'},
  Mild: {plus:'spa', minus:'def'},
  Quiet: {plus:'spa', minus:'spe'},
  Rash: {plus:'spa', minus:'spd'},
  // +SpD
  Calm: {plus:'spd', minus:'atk'},
  Gentle: {plus:'spd', minus:'def'},
  Sassy: {plus:'spd', minus:'spe'},
  Careful: {plus:'spd', minus:'spa'},
  // +Spe
  Timid: {plus:'spe', minus:'atk'},
  Hasty: {plus:'spe', minus:'def'},
  Jolly: {plus:'spe', minus:'spa'},
  Naive: {plus:'spe', minus:'spd'},
  // Neutral
  Bashful: null,
  Docile: null,
  Hardy: null,
  Quirky: null,
  Serious: null,
};

function natureMultiplier(nature, statKey){
  const n = NATURES[String(nature||'').trim()] ?? null;
  if (!n) return 1.0;
  if (n.plus === statKey) return 1.1;
  if (n.minus === statKey) return 0.9;
  return 1.0;
}

function prioSettingsFallback(){
  return {claimedLevel:50, claimedIV:31, claimedEV:0, strengthEV:85};
}

function getPrioCtx(ctx){
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const st = c.state || null;
  const entry = c.entry || null;
  const s = st?.settings || prioSettingsFallback();
  const species = c.species || entry?.effectiveSpecies || entry?.baseSpecies || null;
  const strength = (c.strength !== undefined) ? !!c.strength : !!entry?.strength;
  const nature = c.nature || entry?.nature || null;
  const level = Number(c.level ?? s.claimedLevel ?? 50);
  const ivAll = Number(c.ivAll ?? s.claimedIV ?? 31);
  const evAll = Number(c.evAll ?? (strength ? (s.strengthEV ?? 85) : (s.claimedEV ?? 0)));
  const item = (c.item !== undefined) ? c.item : (entry?.item || null);
  const ability = (c.ability !== undefined) ? c.ability : (entry?.ability || null);
  return {state:st, entry, settings:s, species, strength, nature, level, ivAll, evAll, item, ability};
}
// AoE move list used ONLY for default prio strength estimation (classification).
// IMPORTANT: This must NOT affect damage calcs (spread is handled in battle sim).
// Kept local to avoid import cycles (battle.js ↔ waves.js ↔ roster.js).
const PRIO_AOE_OPPONENTS_ONLY = new Set([
  'Electroweb','Rock Slide','Heat Wave','Icy Wind','Muddy Water','Dazzling Gleam','Air Cutter',
  'Hyper Voice','Blizzard','Eruption','Snarl',
]);
const PRIO_AOE_HITS_ALL = new Set([
  'Earthquake','Surf','Discharge','Bulldoze','Sludge Wave','Lava Plume',
]);
function isAoeMoveForPrio(name){
  const n = String(name||'');
  return PRIO_AOE_OPPONENTS_ONLY.has(n) || PRIO_AOE_HITS_ALL.has(n);
}

// Priority tiers (lower is more preferred):
//   P1 = utility + very weak filler
//   P2 = modest coverage / weak-ish STAB
//   P3 = balanced commitment
//   P4 = strong commitment
//   P5 = reserved nukes (Bug/Fighting STAB)
export function defaultPrioForMove(data, species, moveName, ability=null, prioCtx=null){
  const mi = moveInfo(data, moveName);

  // Unknown/custom move data => treat as utility.
  if (!mi || !mi.type || !mi.category) return 1;

  const cat = String(mi.category);
  // Debug: allow move BP overrides to affect default prio strength estimation.
  let bp = Number(mi.power) || 0;
  try{
    const st = prioCtx?.state || null;
    const enabled = !!st?.settings?.enableMovePowerOverrides;
    const ovr = enabled ? st?.settings?.movePowerOverrides?.[moveName] : undefined;
    const p = (ovr !== undefined && ovr !== null && ovr !== '') ? Number(ovr) : null;
    if (Number.isFinite(p) && p > 0) bp = p;
  }catch(e){ /* ignore */ }

  // Utility/status moves are always P1.
  if (!(cat === 'Physical' || cat === 'Special') || bp <= 0) return 1;

  const stab = isStabMove(data, species, moveName);
  const t = String(mi.type);

  // --- Core philosophy (scales across huge rosters) ---
  // prio is a "power commitment" tier (lower = weaker / earlier).
  // We base it on effective move strength: BP weighted by the attacker's base offensive stat.
  const ctx = getPrioCtx({...(prioCtx||{}), species, ability});
  const d = data.dex?.[species];
  const base = d?.base || {};
  // Use effective L50 stats (with IV/EV/nature) for default prio strength.
  // This makes prio defaults run-state dependent (Strength charm, future nature edits, etc.).
  const statKey = (cat === 'Physical') ? 'atk' : 'spa';
  const baseOff = (statKey === 'atk') ? Number(base.atk)||0 : Number(base.spa)||0;
  const nm = natureMultiplier(ctx.nature, statKey);
  let off = statOther(baseOff, ctx.level, ctx.ivAll, ctx.evAll, nm);
  if (!Number.isFinite(off) || off <= 0) off = 100;

  // Ability scaling for default prio (deterministic / always-on assumptions).
  const ab = String(ctx.ability||ability||'').trim().toLowerCase();
  if (cat === 'Physical' && (ab === 'huge power' || ab === 'pure power')) off = Math.floor(off * 2);

  // NOTE: Default prio should treat STAB mathematically (×1.5) instead of separate STAB thresholds.
  // Typing should only matter for special reserve rules (Bug/Fighting). This keeps the system scalable.
  let effBp = bp * (isAoeMoveForPrio(moveName) ? 0.75 : 1.0);

  // Move-specific deterministic power tweaks (mirror calc.js planning behavior, but only where stable).
  // Multi-hit (deterministic): model as full hit count when known.
  if (moveName === 'Bonemerang') effBp = effBp * 2;
  if (moveName === 'Dual Chop') effBp = effBp * 2;
  if (moveName === 'DoubleSlap') effBp = effBp * ((ab === 'skill link') ? 5 : 2);
  // Acrobatics: double BP when attacker holds no item.
  if (moveName === 'Acrobatics' && !(ctx.item)) effBp = effBp * 2;
  // Low Kick / Grass Knot: weight-based; treat as 60 when target weight is unknown.
  if (moveName === 'Low Kick' || moveName === 'Grass Knot') effBp = 60 * (isAoeMoveForPrio(moveName) ? 0.75 : 1.0);

  // STAB multiplier (Adaptability handled as 2× STAB)
  const stabMult = stab ? (ab === 'adaptability' ? 2.0 : 1.5) : 1.0;

  // Ability move-power multipliers (deterministic; assumes ability active for planning)
  let abMult = 1.0;
  if (cat === 'Physical' && ab === 'toxic boost') abMult *= 1.5;
  if (ab === 'iron fist'){
    const punch = new Set(['Drain Punch','ThunderPunch','Fire Punch','Ice Punch','DynamicPunch','Bullet Punch','Mach Punch']);
    if (punch.has(moveName)) abMult *= 1.2;
  }
  if (ab === 'technician' && effBp <= 60) abMult *= 1.5;
  if (ab === 'reckless'){
    const reckless = new Set(['Brave Bird','Double-Edge','Jump Kick','High Jump Kick','Head Smash','Volt Tackle','Wood Hammer']);
    if (reckless.has(moveName)) abMult *= 1.2;
  }

  const strength = effBp * (off/100) * stabMult * abMult;

  // --- Strength thresholds (effective L50 engine; tuned bands) ---
  // Bands:
  //   P1 < 75
  //   P2 < 110
  //   P3 < 160
  //   P4 < 220
  //   P5 >=220 ("very strong" is often >=260, but still P5)
  let tier = 1;
  if (strength < 75) tier = 1;
  else if (strength < 110) tier = 2;
  else if (strength < 160) tier = 3;
  else if (strength < 220) tier = 4;
  else if (strength < 260) tier = 5;
  else tier = 5;

  // --- Type-aware reserve rules (kept narrow on purpose) ---
  // STAB Bug/Fighting are important for bosses, but only reserve them when they are at least "decent".
  // This prevents very weak Bug/Fighting from being forced to P5.
  if (stab && (t === 'Bug' || t === 'Fighting') && strength >= 115) tier = 5;

  // Strong non-STAB Bug coverage (Megahorn-style): reserve late when it actually hits hard.
  if (!stab && t === 'Bug' && bp >= 100) tier = Math.max(tier, 4);

  // Strong non-STAB Fighting coverage: reserve late when it actually hits hard.
  if (!stab && t === 'Fighting'){
    if (strength >= 200) tier = 5;
    else if (strength >= 160) tier = Math.max(tier, 4);
  }

  // Normal-type attacks are generally safe wave clear / filler: shift them 1 tier earlier
  // for stronger bands (P3–P5 → P2–P4). This is intentional (default-only).
  if (t === 'Normal' && tier >= 3) tier = Math.max(1, tier - 1);

  return tier;
}


export function buildDefaultMovePool(data, species, moveNames, source='base', ability=null, prioCtx=null){
  const uniqueMoves = uniq((moveNames||[]).filter(Boolean));
  return uniqueMoves.map(m => ({
    name: m,
    prio: defaultPrioForMove(data, species, m, ability, prioCtx),
    prioAuto: true,
    use: true,
    // Shrine run planner PP: default all moves to 12 until proven otherwise.
    ppMax: 12,
    pp: 12,
    source,
  }));
}

export function makeRosterEntryFromClaimedSet(data, species){
  const set = data.claimedSets?.[species] || {ability:'', moves:[]};
  const fixedMoves = applyMovesetOverrides(species, Array.isArray(set.moves) ? set.moves : []);
  const id = `r_${species}_${Math.random().toString(16).slice(2,9)}`;
  const entry = {
    id,
    baseSpecies: species,
    effectiveSpecies: species,
    active: true,
    evo: false,
    nature: defaultNatureForSpecies(species),
    // Starters: Strength charm is forced ON by default.
    strength: isStarterSpecies(species) ? true : false,
    ability: set.ability || '',
    movePool: buildDefaultMovePool(data, species, fixedMoves || [], 'base', set.ability || ''),
    item: null,
  };
  return entry;
}

// Like makeRosterEntryFromClaimedSet, but can inherit the set from another species (e.g., base form).
// Used to allow adding evolved forms even when only the base form exists in claimedSets.
export function makeRosterEntryFromClaimedSetWithFallback(data, species, fallbackSpecies=null){
  const s = String(species||'').trim();
  const fb = fallbackSpecies ? String(fallbackSpecies).trim() : null;
  const set = (data.claimedSets?.[s]) || (fb ? data.claimedSets?.[fb] : null) || {ability:'', moves:[]};
  const rawMoves = Array.isArray(set.moves) ? set.moves : [];
  const fixedMoves = applyMovesetOverrides(s, rawMoves);
  const id = `r_${s}_${Math.random().toString(16).slice(2,9)}`;
  return {
    id,
    baseSpecies: s,
    effectiveSpecies: s,
    active: true,
    evo: false,
    nature: defaultNatureForSpecies(s),
    strength: isStarterSpecies(s) ? true : false,
    ability: set.ability || '',
    movePool: buildDefaultMovePool(data, s, fixedMoves || [], 'base', set.ability || ''),
    item: null,
  };
}

export function getEvoTarget(data, base, evoCache){
  if (!base || isStarterSpecies(base)) return null;

  const override = EVO_OVERRIDES[base];
  if (override && data.dex?.[override]) return override;

  const preset = EVO_PRESET[base];
  if (preset && data.dex?.[preset]) return preset;

  const cached = evoCache?.[base];
  if (cached && data.dex?.[cached]) return cached;

  return null;
}

// Apply alpha charm rules synchronously.
// Returns {needsEvoResolve:boolean, evoBase:string|null}
export function applyCharmRulesSync(data, state, entry){
  const base = entry.baseSpecies;

  // Abundant Shrine quirk: some lines change ability on evolution (e.g. Lillipup→Herdier/Stoutland, Poochyena→Mightyena).
  // Use the effective species' claimed set ability when available.
  const applyEffectiveAbility = ()=>{
    const eff = entry.effectiveSpecies || entry.baseSpecies;
    const ab = (data?.claimedSets?.[eff]?.ability !== undefined) ? (data.claimedSets[eff].ability || '') : null;
    if (ab != null) entry.ability = ab;
  };

  // Apply rare, explicit moveset exceptions based on the *effective* species.
  // This keeps the "4 hardcoded moves" rule intact when Evo charm changes species.
  const applyEffectiveMoveset = ()=>{
    const eff = entry.effectiveSpecies || entry.baseSpecies;
    entry.movePool = entry.movePool || [];
    const names = entry.movePool.map(m => m.name);
    // Desired 4-move baseline comes from the claimed set of the *effective* species when available.
    // This is required for evo-only move swaps (e.g. Piplup's Hidden Power (Steel) -> Empoleon's Flash Cannon).
    const claimed = (data?.claimedSets?.[eff]?.moves && Array.isArray(data.claimedSets[eff].moves))
      ? data.claimedSets[eff].moves.slice(0, 4)
      : names.slice(0, 4);
    const desired = applyMovesetOverrides(eff, claimed);

    const overridden = applyMovesetOverrides(eff, names);
    const looksBase = entry.movePool.length <= 4 && entry.movePool.every(m => (m.source || 'base') === 'base');
    const evolved = !!entry.evo && String(eff||'') && String(eff||'') !== String(entry.baseSpecies||'');

    const arraysEq4 = (a,b)=>{
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      for (let i=0;i<4;i++) if (String(a[i]||'') !== String(b[i]||'')) return false;
      return true;
    };

    // Rebuild the 4-move pool when:
    // - the mon is evolved (effective species differs), or
    // - the pool still looks "base" and a full 4-move desired set differs.
    // Preserve PP/use/prio where possible (including Hidden Power (Type) -> same-type evolved move).
    const shouldRebuild = (Array.isArray(desired) && desired.length === 4) && (evolved || (looksBase && !arraysEq4(desired, names)));
    if (shouldRebuild){
      const prev = new Map(entry.movePool.map(m => [m.name, m]));
      // Some base forms use a Hidden Power variant that becomes a stronger same-type move on evolution.
      // Preserve PP (and intent toggles) by matching new move's type against old Hidden Power (Type).
      const hpByType = new Map();
      const hpTaken = new Set();
      for (const m of (entry.movePool||[])){
        if (!m || !m.name) continue;
        if (!String(m.name).startsWith('Hidden Power')) continue;
        const mi = moveInfo(data, m.name);
        const t = mi?.type ? String(mi.type) : null;
        if (!t) continue;
        if (!hpByType.has(t)) hpByType.set(t, []);
        hpByType.get(t).push(m);
      }
      const rebuilt = buildDefaultMovePool(data, eff, desired, 'base', entry.ability || '', {state, entry});
      // Preserve PP + use when the same move name exists.
      for (const mv of rebuilt){
        const old = prev.get(mv.name);
        let src = old || null;

        // Compatibility: map old Hidden Power (Type) → new same-type move.
        if (!src){
          const mi = moveInfo(data, mv.name);
          const t = mi?.type ? String(mi.type) : null;
          if (t && hpByType.has(t)){
            const list = hpByType.get(t);
            const pick = list.find(x => x && x.name && !hpTaken.has(x.name));
            if (pick){
              src = pick;
              hpTaken.add(pick.name);
            }
          }
        }

        if (src){
          mv.use = src.use;
          mv.ppMax = Number.isFinite(Number(src.ppMax)) ? Number(src.ppMax) : mv.ppMax;
          mv.pp = Number.isFinite(Number(src.pp)) ? Number(src.pp) : mv.pp;
          mv.prio = Number.isFinite(Number(src.prio)) ? Number(src.prio) : mv.prio;
          mv.prioAuto = (src.prioAuto === undefined) ? (mv.prioAuto ?? true) : !!src.prioAuto;
        }
      }
      entry.movePool = rebuilt;
      return;
    }

    // Otherwise, do safe in-place replacements (preserve PP/use) and recompute default prio.
    if (overridden && overridden.length === names.length){
      for (let i = 0; i < entry.movePool.length; i++){
        const oldName = entry.movePool[i].name;
        const newName = overridden[i];
        if (newName && newName !== oldName){
          entry.movePool[i].name = newName;
          entry.movePool[i].prio = defaultPrioForMove(data, eff, newName, entry.ability || '', {state, entry});
          entry.movePool[i].prioAuto = true;
        }
      }
    }
  };

  const recomputeAutoPrios = ()=>{
    const eff = entry.effectiveSpecies || entry.baseSpecies;
    for (const mv of (entry.movePool||[])){
      if (!mv || !mv.name) continue;
      if (mv.prioAuto === false) continue;
      if (mv.lowPpBumped === true) continue;
      mv.prio = defaultPrioForMove(data, eff, mv.name, entry.ability || '', {state, entry});
      mv.prioAuto = true;
    }
    normalizeMovePool(entry);
  };

  // Starters: Evo unavailable; Strength is forced ON (does NOT consume the shared bag).
  if (isStarterSpecies(base)){
    entry.evo = false;
    entry.strength = true;
    entry.effectiveSpecies = base;
    applyEffectiveAbility();
    applyEffectiveMoveset();
    recomputeAutoPrios();
    return {needsEvoResolve:false, evoBase:null};
  }

  // Strength charm toggles EV rule only; doesn't change species
  const evoCache = state.evoCache || {};

  if (entry.evo){
    const t = getEvoTarget(data, base, evoCache);
    if (t){
      entry.effectiveSpecies = t;
      applyEffectiveAbility();
      applyEffectiveMoveset();
      recomputeAutoPrios();
      return {needsEvoResolve:false, evoBase:null};
    }
    entry.effectiveSpecies = base;
    applyEffectiveAbility();
    applyEffectiveMoveset();
    recomputeAutoPrios();
    return {needsEvoResolve:true, evoBase: base};
  }

  entry.effectiveSpecies = base;
  applyEffectiveAbility();
  applyEffectiveMoveset();
  recomputeAutoPrios();
  return {needsEvoResolve:false, evoBase:null};
}

// Ensure movePool priorities are exactly 1..5.
export function normalizeMovePool(entry){
  entry.movePool = entry.movePool || [];
  for (const mv of entry.movePool){
    if (mv.prioAuto === undefined) mv.prioAuto = true;
    else mv.prioAuto = !!mv.prioAuto;
    const p = Number(mv.prio);
    if (p === 1 || p === 2 || p === 3 || p === 4 || p === 5) mv.prio = p;
    else if (p === 3.0) mv.prio = 1;
    else if (p === 2.5) mv.prio = 2;
    else mv.prio = 3;

    // PP defaults
    const pm = Number(mv.ppMax);
    mv.ppMax = Number.isFinite(pm) && pm > 0 ? Math.floor(pm) : 12;
    const pp = Number(mv.pp);
    mv.pp = Number.isFinite(pp) ? Math.max(0, Math.min(mv.ppMax, Math.floor(pp))) : mv.ppMax;
  }
}
