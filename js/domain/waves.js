// js/domain/waves.js
// alpha v1
// Wave parsing, enemy modeling, and auto-solve helpers.

import { fixName } from '../data/nameFixes.js';
import { buildDefaultMovePool } from './roster.js';
import { DEFAULT_MOVE_PP } from './battle.js';

function clampInt(v, lo, hi){
  const n = Number.parseInt(String(v), 10);
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}

function applyEnemyIntimidateToSettings(s0, attackerMon, intCount){
  const n = clampInt(intCount ?? 0, 0, 6);
  if (!s0 || n <= 0) return s0;
  if (s0.applyINT === false) return s0;
  const abRaw = attackerMon?.ability ?? s0.attackerAbility ?? '';
  const ab = String(abRaw||'').trim().toLowerCase();

  // INT immunity: if the attacker ignores Intimidate, do not apply the stage drop,
  // and do not trigger Competitive/Defiant.
  const immune = new Set(['clear body','white smoke','hyper cutter','full metal body']);
  if (immune.has(ab)) return s0;

  let atkStage = (s0.atkStage ?? 0) - n;
  let spaStage = (s0.spaStage ?? 0);

  if (ab === 'competitive') spaStage += 2*n;
  if (ab === 'defiant') atkStage += 2*n;

  return {
    ...s0,
    atkStage: clampInt(atkStage, -6, 6),
    spaStage: clampInt(spaStage, -6, 6),
  };
}

function uniq(arr){
  return Array.from(new Set(arr));
}

function byId(arr, id){
  return arr.find(x => x.id === id);
}

// Optional forced move override (set in Fight plan).
// If a wave plan sets wp.attackMoveOverride[attackerId] = moveName,
// calculations will restrict that attacker to the selected move.
function movePoolForWave(wp, attacker){
  const pool = (attacker && attacker.movePool) ? attacker.movePool : [];
  const id = attacker ? attacker.id : null;
  const forced = (wp && wp.attackMoveOverride && id) ? (wp.attackMoveOverride[id] || null) : null;
  if (!forced) return pool;
  const filtered = (pool||[]).filter(m => m && m.use !== false && m.name === forced);
  return filtered.length ? filtered : pool;
}

// PP-aware move pool filter (keeps Auto consistent with Suggested lead pairs).
function ppCurFor(ppMap, monId, moveName){
  const n = Number(ppMap?.[monId]?.[moveName]?.cur);
  return Number.isFinite(n) ? n : DEFAULT_MOVE_PP;
}
function filterMovePoolForWaveCalc({ppMap, monId, movePool, forcedMoveName=null}){
  const base = (movePool||[]).filter(m => m && m.use !== false && m.name && ppCurFor(ppMap, monId, m.name) > 0);
  if (forcedMoveName){
    if (ppCurFor(ppMap, monId, forcedMoveName) > 0){
      const forced = base.filter(m => m.name === forcedMoveName);
      if (forced.length) return forced;
    }
  }
  return base;
}

// Weather parity with planner suggestions.
function weatherFromAbilityName(ab){
  const a = String(ab||'').trim().toLowerCase();
  if (a === 'drizzle') return 'rain';
  if (a === 'drought') return 'sun';
  if (a === 'sand stream') return 'sand';
  if (a === 'snow warning') return 'hail';
  return null;
}
function statOtherNeutral(base, level, iv, ev){
  const evq = Math.floor(Number(ev||0)/4);
  return Math.floor(((2*Number(base||0) + Number(iv||0) + evq) * Number(level||0))/100) + 5;
}
function enemyAbilityForSpecies(data, species){
  const s = fixName(species);
  return String(data?.claimedSets?.[s]?.ability || '').trim();
}
function speedForRosterEntry(data, state, r){
  if (!r) return 0;
  const sp = fixName(r.effectiveSpecies || r.baseSpecies);
  const mon = data?.dex?.[sp];
  const base = Number(mon?.base?.spe || 0);
  const L = Number(state?.settings?.claimedLevel || 50);
  const iv = Number(state?.settings?.claimedIV || 0);
  const ev = Number(r.strength ? state?.settings?.strengthEV : state?.settings?.claimedEV) || 0;
  return statOtherNeutral(base, L, iv, ev);
}
function speedForDefSlot(data, state, defSlot){
  if (!defSlot) return 0;
  const sp = fixName(defSlot.defender);
  const mon = data?.dex?.[sp];
  const base = Number(mon?.base?.spe || 0);
  const L = Number(defSlot.level || 50);
  const iv = Number(state?.settings?.wildIV || 0);
  const ev = Number(state?.settings?.wildEV || 0);
  return statOtherNeutral(base, L, iv, ev);
}
// Gen 5 start-of-battle weather: fastest setter activates first; slowest setter remains.
// Deterministic tie-break: defenders win ties (stable for planning).
function inferBattleWeatherFromLeads(data, state, atkEntries, defSlots){
  const cands = [];
  for (const r of (atkEntries||[])){
    if (!r) continue;
    const w = weatherFromAbilityName(r.ability);
    if (!w) continue;
    cands.push({weather:w, side:'atk', spe:speedForRosterEntry(data, state, r)});
  }
  for (const ds of (defSlots||[])){
    if (!ds) continue;
    const ab = enemyAbilityForSpecies(data, ds.defender);
    const w = weatherFromAbilityName(ab);
    if (!w) continue;
    cands.push({weather:w, side:'def', spe:speedForDefSlot(data, state, ds)});
  }
  if (!cands.length) return null;
  cands.sort((a,b)=>{
    if (a.spe !== b.spe) return b.spe - a.spe; // slowest last
    if (a.side !== b.side) return a.side === 'atk' ? -1 : 1;
    return 0;
  });
  return cands[cands.length - 1]?.weather || null;
}
function withWeatherSettings(settings, weather){
  if (!weather) return settings;
  const s = {...settings};
  s.weather = weather;
  return s;
}


export function phaseDefenderLimit(phase){
  if (phase === 1) return 2;
  if (phase === 2) return 3;
  return 4;
}

export function ensureWaveMods(wp){
  wp.monMods = wp.monMods || {atk:{}, def:{}};
  wp.monMods.atk = wp.monMods.atk || {};
  wp.monMods.def = wp.monMods.def || {};

  // Optional per-wave held item overrides (used for Fight plan + solver sims).
  // Keys are roster mon ids, values are item names.
  wp.itemOverride = (wp.itemOverride && typeof wp.itemOverride === 'object') ? wp.itemOverride : {};
  // NOTE: pruning invalid override keys happens in ensureWavePlan (where state.roster is available).
  // Prune overrides that reference missing mons.
  return wp.monMods;
}

export const WAVE_DEF_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};
export const WAVE_ATK_DEFAULT = {hpPct:100, atkStage:0, spaStage:0, defStage:0, spdStage:0, speStage:0};

export function defaultWaveAtkMods(settings){
  const d = (settings && settings.defaultAtkMods) ? settings.defaultAtkMods : {};
  return {...WAVE_ATK_DEFAULT, ...(d||{})};
}

export function defaultWaveDefMods(settings){
  const d = (settings && settings.defaultDefMods) ? settings.defaultDefMods : {};
  return {...WAVE_DEF_DEFAULT, ...(d||{})};
}

export function getWaveDefMods(settings, wp, rowKey){
  ensureWaveMods(wp);
  return {...defaultWaveDefMods(settings), ...((wp.monMods?.def && wp.monMods.def[rowKey]) || {})};
}

export function getWaveAtkMods(settings, wp, attackerId){
  ensureWaveMods(wp);
  return {...defaultWaveAtkMods(settings), ...((wp.monMods?.atk && wp.monMods.atk[attackerId]) || {})};
}

export function settingsForWave(state, wp, attackerId, defenderRowKey, defenderSpecies=null){
  const rosterMon = attackerId ? byId(state.roster||[], attackerId) : null;
  // Held item: roster assignment, with optional per-wave override.
  const itemOvr = (wp && wp.itemOverride && attackerId) ? (wp.itemOverride[attackerId] || null) : null;
  const attackerItem = itemOvr || (rosterMon?.item || null);

  // Attacker mods are GLOBAL (stored on the roster mon), with optional per-wave overrides.
  const globalAm = (rosterMon && rosterMon.mods) ? rosterMon.mods : {};
  const waveAm = (wp && wp.monMods && wp.monMods.atk && attackerId) ? (wp.monMods.atk[attackerId] || {}) : {};
  const am = attackerId
    ? ({...defaultWaveAtkMods(state.settings), ...(globalAm||{}), ...(waveAm||{})})
    : defaultWaveAtkMods(state.settings);
  const dm = defenderRowKey ? getWaveDefMods(state.settings, wp, defenderRowKey) : defaultWaveDefMods(state.settings);

  const hpPct = clampInt((dm.hpPct ?? 100), 1, 100);


  // Weight (kg) for weight-based base power moves (Low Kick / Grass Knot).
  // Uses PokéAPI cache when available; Waves UI triggers caching for displayed defenders.
  const defSp = defenderSpecies ? fixName(defenderSpecies) : null;
  const api = defSp ? (state.dexApiCache?.[defSp] || null) : null;
  const defenderWeightKg = api?.weightHg ? (api.weightHg / 10) : null;


  return {
    ...state.settings,

    // Held items
    attackerItem,
    attackerAbility: rosterMon?.ability || null,
    defenderItem: null,

    defenderWeightKg,

    // Attacker modifiers (per-mon)
    atkStage: clampInt((am.atkStage ?? 0), -6, 6),
    spaStage: clampInt((am.spaStage ?? 0), -6, 6),
    speStage: clampInt((am.speStage ?? 0), -6, 6),
    defStage: clampInt((am.defStage ?? 0), -6, 6),
    spdStage: clampInt((am.spdStage ?? 0), -6, 6),

    // Defender modifiers (per-mon)
    enemyDefStage: clampInt((dm.defStage ?? 0), -6, 6),
    enemySpdStage: clampInt((dm.spdStage ?? 0), -6, 6),
    enemySpeStage: clampInt((dm.speStage ?? 0), -6, 6),

    // Defender offensive stages (used for threat model)
    enemyAtkStage: clampInt((dm.atkStage ?? 0), -6, 6),
    enemySpaStage: clampInt((dm.spaStage ?? 0), -6, 6),

    defenderHpFrac: hpPct / 100,
  };
}

function itemForRosterMonInWave(wp, rosterMon){
  if (!rosterMon) return null;
  const id = rosterMon.id;
  const ovr = (wp && wp.itemOverride && id) ? (wp.itemOverride[id] || null) : null;
  return ovr || (rosterMon.item || null);
}

// Incoming damage model (defender -> your attacker)
// Default: use the defender's real, hardcoded species moves (same source as attackers).
// Fallback: assumed generic STAB hit (only if moveset is missing).
export const ENEMY_ASSUMED_POWER = 80; // fallback

// Simple AoE move detection for battle sim + incoming previews.
// Treat these as hitting BOTH opponents (double battles) unless proven otherwise.
const AOE_MOVES = new Set([
  'Electroweb','Rock Slide','Earthquake','Surf','Heat Wave','Discharge','Icy Wind','Bulldoze','Muddy Water',
  'Dazzling Gleam','Sludge Wave','Lava Plume',
  'Air Cutter',
  'Hyper Voice',
  'Blizzard',
  'Eruption',
  'Snarl',
]);

// Subset that hits ALL mons (both opponents + ally) in doubles.
// Keep consistent with battle engine.
const AOE_HITS_ALL = new Set([
  'Earthquake','Surf','Discharge','Bulldoze','Sludge Wave','Lava Plume',
]);

function isAoeMove(name){
  return AOE_MOVES.has(String(name||''));
}

function aoeHitsAlly(name){
  return AOE_HITS_ALL.has(String(name||''));
}

function spreadMult(targetsDamaged){
  return (targetsDamaged > 1) ? 0.75 : 1.0;
}

// Move selection policy used by Auto starter picking.
// Avoid AoE moves unless they can double-OHKO both on-field defenders,
// or there is no viable non-AoE damaging move.
export function chooseBestMoveDisciplined({data, attacker, defender, movePool, settings, tags, otherDefender=null, otherSettings=null, otherTags=null, allyRosterMon=null}){
  const calc = (window && window.SHRINE_CALC) ? window.SHRINE_CALC : null;
  if (!calc) return null;

  const pool = (movePool||[]).filter(m=>m && m.use !== false && m.name);
  const nonAoe = pool.filter(m=>!isAoeMove(m.name));
  const aoe = pool.filter(m=>isAoeMove(m.name));

  const choose = (mp, s, t)=> calc.chooseBestMove({data, attacker, defender, movePool: mp, settings: s, tags: t||[]}).best;

  // Allow AoE only if it double-OHKOs both defenders (and no friendly-fire risk).
  if (otherDefender && otherSettings && aoe.length){
    let bestDouble = null;
    const pickBetter = (a,b)=>{
      if (!b) return true;
      // Prefer non-friendly-fire double-OHKO if prio is equal.
      if (!!a?.ffRisk !== !!b?.ffRisk) return !a.ffRisk;
      const ap = a?.prio ?? 9;
      const bp = b?.prio ?? 9;
      if (ap !== bp) return ap < bp;
      const da = Math.abs((a.minPct ?? 0) - 100) + Math.abs((a.otherMinPct ?? 0) - 100);
      const db = Math.abs((b.minPct ?? 0) - 100) + Math.abs((b.otherMinPct ?? 0) - 100);
      return da <= db;
    };

    for (const m of aoe){
      const moveName = m.name;
      const rrA = calc.computeDamageRange({data, attacker, defender, moveName, settings, tags: tags||[]});
      if (!rrA?.ok) continue;
      const rrB = calc.computeDamageRange({data, attacker, defender: otherDefender, moveName, settings: otherSettings, tags: otherTags||[]});

      const ffRisk = (aoeHitsAlly(moveName) && allyRosterMon && !immuneFromAllyAbilityItem(allyRosterMon, rrA.moveType));

      let damaged = 0;
      if ((rrA.minPct ?? 0) > 0) damaged += 1;
      if (rrB?.ok && (rrB.minPct ?? 0) > 0) damaged += 1;
      const mult = spreadMult(damaged);

      const minA = (rrA.minPct ?? 0) * mult;
      const minB = (rrB?.ok ? ((rrB.minPct ?? 0) * mult) : 0);
      if (minA >= 100 && minB >= 100){
        const cand = {
          ...rrA,
          prio: Number(m.prio)||2,
          minPct: minA,
          maxPct: (rrA.maxPct ?? rrA.minPct ?? 0) * mult,
          oneShot: true,
          otherMinPct: minB,
          ffRisk: !!ffRisk,
        };
        if (pickBetter(cand, bestDouble)) bestDouble = cand;
      }
    }
    if (bestDouble) return bestDouble;
  }

  // Prefer non-AoE if possible.
  const bestNon = nonAoe.length ? choose(nonAoe, settings, tags) : null;
  if (bestNon) return bestNon;

  // Fallback: allow AoE if there is no other way.
  return choose(pool, settings, tags);
}

function immuneFromAllyAbilityItem(allyRosterMon, moveType){
  if (!allyRosterMon) return false;
  const type = String(moveType||'');
  const abLc = String(allyRosterMon.ability || '').trim().toLowerCase();
  const item = String(allyRosterMon.item || '').trim();
  if (abLc === 'telepathy') return true;
  if (type === 'Ground'){
    if (abLc === 'levitate') return true;
    if (item === 'Air Balloon') return true;
  }
  if (type === 'Electric'){
    if (abLc === 'lightning rod' || abLc === 'motor drive' || abLc === 'volt absorb') return true;
  }
  if (type === 'Fire'){
    if (abLc === 'flash fire') return true;
  }
  if (type === 'Water'){
    if (abLc === 'water absorb' || abLc === 'storm drain' || abLc === 'dry skin') return true;
  }
  if (type === 'Grass'){
    if (abLc === 'sap sipper') return true;
  }
  return false;
}

function enemyMovePoolForSpecies(data, species){
  const set = data.claimedSets?.[species];
  const moves = (set && Array.isArray(set.moves)) ? set.moves : [];
  if (!moves.length) return null;
  return buildDefaultMovePool(data, species, moves, 'base');
}

// Compute best incoming hit from the defender to the chosen attacker using real species moves.
export function enemyThreatForMatchup(data, state, wp, attackerRosterMon, defSlot, opts=null){
  try{
    if (!(state.settings?.threatModelEnabled ?? true)) return null;
    if (!attackerRosterMon || !defSlot) return null;

    const enemySpecies = defSlot.defender;
    const mySpecies = attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies;


    const enemyAbility = data.claimedSets?.[enemySpecies]?.ability || null;
    const weather = (opts && opts.weather) ? String(opts.weather).trim().toLowerCase() : null;
    if (!data.dex?.[enemySpecies] || !data.dex?.[mySpecies]) return null;

    const pool = enemyMovePoolForSpecies(data, enemySpecies);
    if (!pool || !pool.length) return null;

    const dm = getWaveDefMods(state.settings, wp, defSlot.rowKey);
    const globalAm = (attackerRosterMon && attackerRosterMon.mods) ? attackerRosterMon.mods : {};
    const waveAm = (wp && wp.monMods && wp.monMods.atk) ? (wp.monMods.atk[attackerRosterMon.id] || {}) : {};
    const am = {...defaultWaveAtkMods(state.settings), ...(globalAm||{}), ...(waveAm||{})};

    const enemy = {
      species: enemySpecies,
      level: defSlot.level,
      ivAll: state.settings.wildIV,
      evAll: state.settings.wildEV,
    };
    const me = {
      species: mySpecies,
      level: state.settings.claimedLevel,
      ivAll: state.settings.claimedIV,
      evAll: attackerRosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
    };

    const hpFrac = clampInt((am.hpPct ?? 100), 1, 100) / 100;

    // Swap roles: enemy is attacker, you are defender.
    // Use defender offensive stages (Atk/SpA/Spe) and your defensive stages (Def/SpD/Spe).
    const s = {
      ...state.settings,
      defenderHpFrac: hpFrac,

      // Items: enemy has none (for now). Your held item can affect defense (e.g., Assault Vest) and speed.
      attackerItem: null,
      defenderItem: itemForRosterMonInWave(wp, attackerRosterMon),
      defenderCanEvolve: !!(state.dexMetaCache?.[mySpecies]?.canEvolve),
      attackerAbility: enemyAbility,
      weather,
      defenderAbility: attackerRosterMon?.ability || null,

      // enemy offense stages
      atkStage: clampInt(dm.atkStage ?? 0, -6, 6),
      spaStage: clampInt(dm.spaStage ?? 0, -6, 6),
      speStage: clampInt(dm.speStage ?? 0, -6, 6),

      // your bulk stages
      enemyDefStage: clampInt(am.defStage ?? 0, -6, 6),
      enemySpdStage: clampInt(am.spdStage ?? 0, -6, 6),
      enemySpeStage: clampInt(am.speStage ?? 0, -6, 6),

      // INT/STU tags are used mainly for your outgoing planning. Keep them off for incoming.
      applyINT: false,
      applySTU: false,
    };

    // Enemy move selection rule:
    // - prefers the move with the highest OHKO chance (if any can OHKO)
    // - otherwise, chooses the move that deals the most damage (highest min%)
    const candidates = (pool||[]).filter(m => m && m.use !== false);
    const all = [];
    for (const m of candidates){
      const r = window.SHRINE_CALC.computeDamageRange({
        data,
        attacker: enemy,
        defender: me,
        moveName: m.name,
        settings: {...s, calcCrit: true},
        tags: defSlot.tags || [],
      });
      if (!r || !r.ok) continue;

      const minPct = Number(r.minPct)||0;
      const maxPct = Number(r.maxPct)||minPct;
      const oneShot = !!r.oneShot;
      // Use true 16-roll distribution + crit (if enabled) for risk view.
      const pc = Number(r.critChance ?? (1/16));
      const pRoll = Number(r.ohkoChanceRoll||0);
      const pCrit = Number(r.ohkoChanceCrit||0);
      const pTotal = (1-pc)*pRoll + pc*pCrit;
      const ohkoChance = (state.settings?.inTipRisk ?? true) ? pTotal : pRoll;
      const chosenReason = (ohkoChance > 0) ? 'ohkoChance' : 'maxDamage';
      all.push({...r, prio: Number(m.prio)||2, ohkoChance, ohkoChanceRoll:pRoll, ohkoChanceCrit:pCrit, ohkoChanceTotal:pTotal, oneShot, chosenReason, aoe: isAoeMove(r.move)});
    }

    if (!all.length) return null;

    const anyChance = all.some(x => (x.ohkoChance||0) > 0);
    all.sort((a,b)=>{
      if (anyChance){
        if (a.ohkoChance !== b.ohkoChance) return b.ohkoChance - a.ohkoChance;
      }
      if (a.minPct !== b.minPct) return b.minPct - a.minPct;
      if ((a.maxPct||0) !== (b.maxPct||0)) return (b.maxPct||0) - (a.maxPct||0);
      return String(a.move||'').localeCompare(String(b.move||''));
    });

    const best = all[0];

    const enemySpe = best.attackerSpe ?? 0;
    const mySpe = best.defenderSpe ?? 0;
    const enemyFaster = enemySpe > mySpe;
    const tie = enemySpe === mySpe;
    const tieActsFirst = (state.settings?.enemySpeedTieActsFirst ?? true);
    const enemyActsFirst = enemyFaster || (tie && tieActsFirst);
    const diesBeforeMove = enemyActsFirst && !!best.oneShot;

    return {
      ...best,
      enemyFaster,
      speedTie: tie,
      enemyActsFirst,
      diesBeforeMove,
      aoe: !!best.aoe,
      assumed: false,
    };
  }catch(e){
    return null;
  }
}

// Fallback if defender move pool is unknown.
export function assumedEnemyThreatForMatchup(data, state, wp, attackerRosterMon, defSlot, opts=null){
  try{
    if (!(state.settings?.threatModelEnabled ?? true)) return null;
    if (!attackerRosterMon || !defSlot) return null;
    const enemyDex = data.dex[defSlot.defender];
    const myDex = data.dex[attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies];
    if (!enemyDex || !myDex) return null;

    const dm = getWaveDefMods(state.settings, wp, defSlot.rowKey);
    const globalAm = (attackerRosterMon && attackerRosterMon.mods) ? attackerRosterMon.mods : {};
    const waveAm = (wp && wp.monMods && wp.monMods.atk) ? (wp.monMods.atk[attackerRosterMon.id] || {}) : {};
    const am = {...defaultWaveAtkMods(state.settings), ...(globalAm||{}), ...(waveAm||{})};

    const enemySpecies = defSlot.defender;
    const enemyAbility = data.claimedSets?.[enemySpecies]?.ability || null;
    const weather = (opts && opts.weather) ? String(opts.weather).trim().toLowerCase() : null;

    const enemy = {
      species: defSlot.defender,
      level: defSlot.level,
      ivAll: state.settings.wildIV,
      evAll: state.settings.wildEV,
    };
    const me = {
      species: attackerRosterMon.effectiveSpecies || attackerRosterMon.baseSpecies,
      level: state.settings.claimedLevel,
      ivAll: state.settings.claimedIV,
      evAll: attackerRosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
    };

    const hpFrac = clampInt((am.hpPct ?? 100), 1, 100) / 100;

    const s = {
      ...state.settings,
      defenderHpFrac: hpFrac,
      attackerItem: null,
      defenderItem: itemForRosterMonInWave(wp, attackerRosterMon),
      defenderCanEvolve: !!(state.dexMetaCache?.[mySpecies]?.canEvolve),
      attackerAbility: enemyAbility,
      defenderAbility: attackerRosterMon?.ability || null,
      weather,

      // enemy offense stages (as attacker)
      atkStage: clampInt(dm.atkStage ?? 0, -6, 6),
      spaStage: clampInt(dm.spaStage ?? 0, -6, 6),
      speStage: clampInt(dm.speStage ?? 0, -6, 6),
      // your bulk stages (as defender)
      enemyDefStage: clampInt(am.defStage ?? 0, -6, 6),
      enemySpdStage: clampInt(am.spdStage ?? 0, -6, 6),
      enemySpeStage: clampInt(am.speStage ?? 0, -6, 6),
      // don't apply intimidate/sturdy in this approximation
      applyINT: false,
      applySTU: false,
    };

    const types = Array.isArray(enemyDex.types) && enemyDex.types.length ? enemyDex.types : ['Normal'];
    const cats = ['Physical','Special'];

    const assumedPower = Number(state.settings?.enemyAssumedPower);
    const power = (Number.isFinite(assumedPower) && assumedPower > 0) ? assumedPower : ENEMY_ASSUMED_POWER;

    let best = null;
    for (const type of types){
      for (const category of cats){
        const r = window.SHRINE_CALC.computeGenericDamageRange({
          data,
          attacker: enemy,
          defender: me,
          profile: {type, category, power},
          settings: {...s, calcCrit: true},
          tags: [],
        });
        if (!r || !r.ok) continue;
        const pc = Number(r.critChance ?? (1/16));
        const pRoll = Number(r.ohkoChanceRoll||0);
        const pCrit = Number(r.ohkoChanceCrit||0);
        const pTotal = (1-pc)*pRoll + pc*pCrit;
        r.ohkoChanceRoll = pRoll;
        r.ohkoChanceCrit = pCrit;
        r.ohkoChanceTotal = pTotal;
        r.ohkoChance = (state.settings?.inTipRisk ?? true) ? pTotal : pRoll;
        r.chosenReason = (r.ohkoChance > 0) ? 'ohkoChance' : 'maxDamage';
        if (!best) { best = r; continue; }
        const aOHKO = !!r.oneShot;
        const bOHKO = !!best.oneShot;
        if (aOHKO !== bOHKO) { if (aOHKO) best = r; continue; }
        if ((r.minPct ?? 0) > (best.minPct ?? 0)) best = r;
      }
    }

    if (!best) return null;

    const enemyFaster = (best.attackerSpe ?? 0) > (best.defenderSpe ?? 0);
    const tie = (best.attackerSpe ?? 0) === (best.defenderSpe ?? 0);
    const tieActsFirst = (state.settings?.enemySpeedTieActsFirst ?? true);
    const enemyActsFirst = enemyFaster || (tie && tieActsFirst);
    const diesBeforeMove = enemyActsFirst && !!best.oneShot;

    const moveLabel = `Assumed ${best.category || 'Attack'} ${best.moveType || ''}`.trim();

    return {
      ...best,
      move: moveLabel,
      enemyFaster,
      speedTie: tie,
      enemyActsFirst,
      diesBeforeMove,
      assumed: true,
    };
  }catch(e){
    return null;
  }
}

function normalizeOrder(order, starters){
  const s = (starters||[]).slice(0,2);
  if (s.length < 2) return s;
  const o = (order||[]).filter(x=>s.includes(x));
  if (o.length === 2) return o;
  if (o.length === 1) return [o[0], s.find(x=>x!==o[0])];
  return s;
}

export function ensureWavePlan(data, state, waveKey, slots){
  state.wavePlans = state.wavePlans || {};
  const phase = Number(slots[0]?.phase || 1);
  const limit = phaseDefenderLimit(phase);

  let wp = state.wavePlans[waveKey];
  if (!wp){
    wp = state.wavePlans[waveKey] = {attackers:[], attackerStart:[], defenders:[], defenderStart:[]};
  }

  // Defenders from this wave
  // NOTE: we allow instance keys like "P1W1S1#2" to represent duplicate encounters.
  // The base rowKey is the part before '#'.
  const slotByKey = new Map(slots.map(s=>[s.rowKey, s]));
  const baseKey = (k)=> String(k||'').split('#')[0];
  ensureWaveMods(wp);
  // Prune item overrides that reference missing roster mons.
  const rosterIdsAll = new Set((state.roster||[]).map(r=>r && r.id).filter(Boolean));
  for (const k of Object.keys(wp.itemOverride||{})){
    if (!rosterIdsAll.has(k)) delete wp.itemOverride[k];
  }
  wp.defenders = (wp.defenders||[]).filter(rk => slotByKey.has(baseKey(rk))).slice(0, limit);

  if (!wp.defenders.length){
    const prefer = slots.filter(s=>!state.cleared[s.rowKey]);
    const base = prefer.length ? prefer : slots;
    wp.defenders = base.slice(0, limit).map(s=>s.rowKey);
  }

  wp.defenderStart = (wp.defenderStart||[]).filter(rk => wp.defenders.includes(rk)).slice(0,2);
  if (wp.defenderStart.length < 2) wp.defenderStart = wp.defenders.slice(0,2);
  wp.defenderOrder = normalizeOrder(wp.defenderOrder, wp.defenderStart);

  // Attackers from active roster
  const activeRoster = (state.roster||[]).filter(r=>r.active);
  const validIds = new Set(activeRoster.map(r=>r.id));
  // Global pool: always derived from active roster (up to 16).
  wp.attackers = activeRoster.slice(0,16).map(r=>r.id);
  if (wp.attackers.length < 2) wp.attackers = activeRoster.slice(0,2).map(r=>r.id);
  // Prune item overrides that are not in this wave's attacker pool.
  for (const k of Object.keys(wp.itemOverride||{})){
    if (!wp.attackers.includes(k)) delete wp.itemOverride[k];
  }

  // Prune forced move overrides that reference missing attackers.
  if (wp.attackMoveOverride && typeof wp.attackMoveOverride === 'object'){
    for (const k of Object.keys(wp.attackMoveOverride)){
      if (!wp.attackers.includes(k)) delete wp.attackMoveOverride[k];
    }
    if (!Object.keys(wp.attackMoveOverride).length) delete wp.attackMoveOverride;
  }


  wp.attackerStart = (wp.attackerStart||[]).filter(id=>wp.attackers.includes(id)).slice(0,2);
  if (wp.attackerStart.length < 2) wp.attackerStart = wp.attackers.slice(0,2);
  wp.attackerOrder = normalizeOrder(wp.attackerOrder, wp.attackerStart);

  // Per-mon battle modifiers
  wp.monMods = wp.monMods || {atk:{}, def:{}};
  wp.monMods.atk = wp.monMods.atk || {};
  wp.monMods.def = wp.monMods.def || {};

  // Auto-match always ON unless manual override
  state.settings.autoMatch = true;
  if (state.settings.autoMatch && !wp.manualOrder){
    try{
      // If starters are not manually pinned, auto-pick the best pair from the active roster pool.
      if (!wp.manualStarters){
        autoPickStartersAndOrdersForWave(data, state, wp, slotByKey);
      } else {
        autoPickOrdersForWave(data, state, wp, slotByKey);
      }
    }catch(e){ /* ignore */ }
  }



  // Wave fights (4 players): store per-wave progress
  if (!Array.isArray(wp.fights) || wp.fights.length !== 4){
    const basePair = (wp.attackerStart||[]).slice(0,2);
    wp.fights = Array.from({length:4}).map(()=>({
      attackers: basePair.length===2 ? basePair.slice() : [null,null],
      done: false,
      summary: null,
    }));
  }

  // Per-wave fight log (replaces Wave fights UI). Newest first.
  if (!Array.isArray(wp.fightLog)) wp.fightLog = [];

  state.wavePlans[waveKey] = wp;
  return wp;
}

// Choose the best 2 starters from wp.attackers (active roster pool), then also choose favorable left/right orders.
export function autoPickStartersAndOrdersForWave(data, state, wp, slotByKey){
  const pool = (wp.attackers||[]).slice(0,16);
  const defKeys = (wp.defenderStart||[]).slice(0,2);
  if (pool.length < 2 || defKeys.length < 2) return;

  const baseKey = (k)=> String(k||'').split('#')[0];
  const def0 = slotByKey.get(baseKey(defKeys[0]));
  const def1 = slotByKey.get(baseKey(defKeys[1]));
  if (!def0 || !def1) return;

  const allDefSlots = (wp.defenders||[]).map(k=>slotByKey.get(baseKey(k))).filter(Boolean);

  // Keep Auto starter picking consistent with the Waves planner "Suggested lead pairs".
  // Sorting priority: clearAll desc → OHKO pairs desc → prioØ asc → overkill asc.
  const curA0 = byId(state.roster, (wp.attackerStart||[])[0]) || byId(state.roster, pool[0]);
  const curA1 = byId(state.roster, (wp.attackerStart||[])[1]) || byId(state.roster, pool[1]);
  const waveWeather = inferBattleWeatherFromLeads(data, state, [curA0, curA1].filter(Boolean), [def0, def1].filter(Boolean));

  const hasInt = (ds)=> (ds?.tags||[]).includes('INT');
  const leadIntCount = [def0, def1].filter(hasInt).length;
  const reinf3 = allDefSlots[2] || null;
  const reinf4 = allDefSlots[3] || null;
  const reinf3Int = hasInt(reinf3) ? 1 : 0;
  const reinf4Int = hasInt(reinf4) ? 1 : 0;
  const intCountForDefSlot = (ds)=>{
    if (!ds) return leadIntCount;
    if (reinf4 && ds.rowKey === reinf4.rowKey) return leadIntCount + reinf3Int + reinf4Int;
    if (reinf3 && ds.rowKey === reinf3.rowKey) return leadIntCount + reinf3Int;
    return leadIntCount;
  };

  const tuple = (m0,m1)=>{
    const bothOhko = (m0?.oneShot && m1?.oneShot) ? 2 : ((m0?.oneShot || m1?.oneShot) ? 1 : 0);
    const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
    const prioAvg = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
    const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
    return {bothOhko, worstPrio, prioAvg, overkill};
  };
  const better = (x,y)=>{
    if (x.bothOhko !== y.bothOhko) return x.bothOhko > y.bothOhko;
    if (x.worstPrio !== y.worstPrio) return x.worstPrio < y.worstPrio;
    if (x.prioAvg !== y.prioAvg) return x.prioAvg < y.prioAvg;
    return x.overkill <= y.overkill;
  };

  let best = null;
  for (let i=0;i<pool.length;i++){
    for (let j=i+1;j<pool.length;j++){
      const a = byId(state.roster, pool[i]);
      const b = byId(state.roster, pool[j]);
      if (!a || !b) continue;

      const forcedA = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[a.id] || null) : null;
      const forcedB = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[b.id] || null) : null;
      const poolA = filterMovePoolForWaveCalc({ppMap: state.pp || {}, monId: a.id, movePool: a.movePool || [], forcedMoveName: forcedA});
      const poolB = filterMovePoolForWaveCalc({ppMap: state.pp || {}, monId: b.id, movePool: b.movePool || [], forcedMoveName: forcedB});

      const defLeft = {species:def0.defender, level:def0.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const defRight = {species:def1.defender, level:def1.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

      const sA0 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, a.id, def0.rowKey, def0.defender), a, leadIntCount), waveWeather);
      const sA1 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, a.id, def1.rowKey, def1.defender), a, leadIntCount), waveWeather);
      const sB0 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, b.id, def0.rowKey, def0.defender), b, leadIntCount), waveWeather);
      const sB1 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, b.id, def1.rowKey, def1.defender), b, leadIntCount), waveWeather);

      const atkA = {species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV};
      const atkB = {species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV};

      const bestA0 = chooseBestMoveDisciplined({data, attacker: atkA, defender: defLeft, movePool: poolA, settings: sA0, tags: def0.tags||[], otherDefender: defRight, otherSettings: sA1, otherTags: def1.tags||[], allyRosterMon: b});
      const bestA1 = chooseBestMoveDisciplined({data, attacker: atkA, defender: defRight, movePool: poolA, settings: sA1, tags: def1.tags||[], otherDefender: defLeft, otherSettings: sA0, otherTags: def0.tags||[], allyRosterMon: b});
      const bestB0 = chooseBestMoveDisciplined({data, attacker: atkB, defender: defLeft, movePool: poolB, settings: sB0, tags: def0.tags||[], otherDefender: defRight, otherSettings: sB1, otherTags: def1.tags||[], allyRosterMon: a});
      const bestB1 = chooseBestMoveDisciplined({data, attacker: atkB, defender: defRight, movePool: poolB, settings: sB1, tags: def1.tags||[], otherDefender: defLeft, otherSettings: sB0, otherTags: def0.tags||[], allyRosterMon: a});

      const t1 = tuple(bestA0, bestB1); // a->left, b->right
      const t2 = tuple(bestA1, bestB0); // swap targets
      const lead = better(t1,t2) ? t1 : t2;

      let clearAll = 0;
      for (const ds of allDefSlots){
        const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
        const ic = intCountForDefSlot(ds);
        const s0 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, a.id, ds.rowKey, ds.defender), a, ic), waveWeather);
        const s1 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, b.id, ds.rowKey, ds.defender), b, ic), waveWeather);
        const b0 = chooseBestMoveDisciplined({data, attacker: atkA, defender: defObj, movePool: poolA, settings: s0, tags: ds.tags||[]});
        const b1 = chooseBestMoveDisciplined({data, attacker: atkB, defender: defObj, movePool: poolB, settings: s1, tags: ds.tags||[]});
        if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) clearAll += 1;
      }

      let focus = 0;
      let effClear = clearAll;
      const defCount = allDefSlots.length;
      if ((defCount === 3 || defCount === 4) && lead.bothOhko === 2){
        const focusSlot = allDefSlots[2] || null; // first joiner (Reinf #3)
        if (focusSlot){
          const defObj = {species:focusSlot.defender, level:focusSlot.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
          const ic = intCountForDefSlot(focusSlot);
          const s0 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, a.id, focusSlot.rowKey, focusSlot.defender), a, ic), waveWeather);
          const s1 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, b.id, focusSlot.rowKey, focusSlot.defender), b, ic), waveWeather);
          const b0 = chooseBestMoveDisciplined({data, attacker: atkA, defender: defObj, movePool: poolA, settings: s0, tags: focusSlot.tags||[], allyRosterMon: b});
          const b1 = chooseBestMoveDisciplined({data, attacker: atkB, defender: defObj, movePool: poolB, settings: s1, tags: focusSlot.tags||[], allyRosterMon: a});
          if (!(b0 && b0.oneShot) && !(b1 && b1.oneShot)){
            const sum = (b0?.minPct ?? 0) + (b1?.minPct ?? 0);
            if (sum >= 100){
              focus = 1;
              effClear = Math.min(defCount, clearAll + 1);
            }
          }
        }
      }


      const cand = {a, b, clearAll, effClear, focus, ohkoPairs: lead.bothOhko, worstPrio: lead.worstPrio, prioAvg: lead.prioAvg, overkill: lead.overkill};
      const betterCand = (x,y)=>{
        if (x.effClear !== y.effClear) return x.effClear > y.effClear;
        if (x.ohkoPairs !== y.ohkoPairs) return x.ohkoPairs > y.ohkoPairs;
        if (x.clearAll !== y.clearAll) return x.clearAll > y.clearAll;
        if (x.worstPrio !== y.worstPrio) return x.worstPrio < y.worstPrio;
        if (x.prioAvg !== y.prioAvg) return x.prioAvg < y.prioAvg;
        return x.overkill <= y.overkill;
      };
      if (!best || betterCand(cand, best)) best = cand;
    }
  }

  if (best){
    wp.attackerStart = [best.a.id, best.b.id];
    wp.attackerOrder = [best.a.id, best.b.id];
    // Keep current defender order stable; do not auto-swap defender sides here.
    wp.defenderOrder = [def0.rowKey, def1.rowKey];
  }
}

export function autoPickOrdersForWave(data, state, wp, slotByKey){
  const atkIds = (wp.attackerStart||[]).slice(0,2);
  const defKeys = (wp.defenderStart||[]).slice(0,2);
  if (atkIds.length < 2 || defKeys.length < 2) return;

  const baseKey = (k)=> String(k||'').split('#')[0];

  const atk0 = byId(state.roster, atkIds[0]);
  const atk1 = byId(state.roster, atkIds[1]);
  const def0 = slotByKey.get(baseKey(defKeys[0]));
  const def1 = slotByKey.get(baseKey(defKeys[1]));
  if (!atk0 || !atk1 || !def0 || !def1) return;

  const atkOrders = [[atk0.id, atk1.id],[atk1.id, atk0.id]];
  const defOrders = [[def0.rowKey, def1.rowKey],[def1.rowKey, def0.rowKey]];

  const allDefSlots = (wp.defenders||[]).map(k=>slotByKey.get(baseKey(k))).filter(Boolean);

  const waveWeather = inferBattleWeatherFromLeads(data, state, [atk0, atk1].filter(Boolean), [def0, def1].filter(Boolean));
  const hasInt = (ds)=> (ds?.tags||[]).includes('INT');
  const leadIntCount = [def0, def1].filter(hasInt).length;
  const reinf3 = allDefSlots[2] || null;
  const reinf4 = allDefSlots[3] || null;
  const reinf3Int = hasInt(reinf3) ? 1 : 0;
  const reinf4Int = hasInt(reinf4) ? 1 : 0;
  const intCountForDefSlot = (ds)=>{
    if (!ds) return leadIntCount;
    if (reinf4 && ds.rowKey === reinf4.rowKey) return leadIntCount + reinf3Int + reinf4Int;
    if (reinf3 && ds.rowKey === reinf3.rowKey) return leadIntCount + reinf3Int;
    return leadIntCount;
  };

  const scorePlan = (atkOrder, defOrder)=>{
    const aL = byId(state.roster, atkOrder[0]);
    const aR = byId(state.roster, atkOrder[1]);
    const dL = slotByKey.get(defOrder[0]);
    const dR = slotByKey.get(defOrder[1]);
    if (!aL || !aR || !dL || !dR) return {score:-Infinity};

    const defLeft = {species:dL.defender, level:dL.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
    const defRight = {species:dR.defender, level:dR.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    const forcedL = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[aL.id] || null) : null;
    const forcedR = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[aR.id] || null) : null;
    const poolL = filterMovePoolForWaveCalc({ppMap: state.pp || {}, monId: aL.id, movePool: aL.movePool || [], forcedMoveName: forcedL});
    const poolR = filterMovePoolForWaveCalc({ppMap: state.pp || {}, monId: aR.id, movePool: aR.movePool || [], forcedMoveName: forcedR});

    const sL0 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, aL.id, dL.rowKey, dL.defender), aL, leadIntCount), waveWeather);
    const sR0 = withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, aR.id, dR.rowKey, dR.defender), aR, leadIntCount), waveWeather);

    const bestL = chooseBestMoveDisciplined({
      data,
      attacker:{species:(aL.effectiveSpecies||aL.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aL.strength?state.settings.strengthEV:state.settings.claimedEV},
      defender:defLeft,
      movePool: poolL,
      settings: sL0,
      tags: dL.tags||[],
      otherDefender: defRight,
      otherSettings: withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, aL.id, dR.rowKey, dR.defender), aL, leadIntCount), waveWeather),
      otherTags: dR.tags||[],
      allyRosterMon: aR,
    });
    const bestR = chooseBestMoveDisciplined({
      data,
      attacker:{species:(aR.effectiveSpecies||aR.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aR.strength?state.settings.strengthEV:state.settings.claimedEV},
      defender:defRight,
      movePool: poolR,
      settings: sR0,
      tags: dR.tags||[],
      otherDefender: defLeft,
      otherSettings: withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, aR.id, dL.rowKey, dL.defender), aR, leadIntCount), waveWeather),
      otherTags: dL.tags||[],
      allyRosterMon: aL,
    });

    const bothOhko = (bestL?.oneShot && bestR?.oneShot) ? 2 : ((bestL?.oneShot || bestR?.oneShot) ? 1 : 0);
    const worstPrio = Math.max(bestL?.prio ?? 9, bestR?.prio ?? 9);
    const prioSum = (bestL?.prio ?? 9) + (bestR?.prio ?? 9);
    const overkillSum = Math.abs((bestL?.minPct ?? 0) - 100) + Math.abs((bestR?.minPct ?? 0) - 100);

    // Primary: starters-only clear all selected defenders (3/4)
    let startersClear = 0;
    for (const ds of allDefSlots){
      const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const ic = intCountForDefSlot(ds);
      const b0 = chooseBestMoveDisciplined({
        data,
        attacker:{species:(aL.effectiveSpecies||aL.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aL.strength?state.settings.strengthEV:state.settings.claimedEV},
        defender:defObj,
        movePool: poolL,
        settings: withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, aL.id, ds.rowKey, ds.defender), aL, ic), waveWeather),
        tags: ds.tags||[],
      });
      const b1 = chooseBestMoveDisciplined({
        data,
        attacker:{species:(aR.effectiveSpecies||aR.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: aR.strength?state.settings.strengthEV:state.settings.claimedEV},
        defender:defObj,
        movePool: poolR,
        settings: withWeatherSettings(applyEnemyIntimidateToSettings(settingsForWave(state, wp, aR.id, ds.rowKey, ds.defender), aR, ic), waveWeather),
        tags: ds.tags||[],
      });
      if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) startersClear += 1;
    }

    // Survival penalty (enemy acts first + OHKOs you)
    let deathPenalty = 0;
    const prioAvg = prioSum / 2;
    if (prioAvg > 3.5){
    const t0 = enemyThreatForMatchup(data, state, wp, aL, dL) || assumedEnemyThreatForMatchup(data, state, wp, aL, dL);
    const t1 = enemyThreatForMatchup(data, state, wp, aR, dR) || assumedEnemyThreatForMatchup(data, state, wp, aR, dR);
    if (t0?.diesBeforeMove) deathPenalty += 1;
    if (t1?.diesBeforeMove) deathPenalty += 1;
    }

    const score = (startersClear * 1_000_000)
      + (bothOhko * 10_000)
      - (worstPrio * 1_000)
      - (prioSum * 100)
      - (overkillSum)
      - (deathPenalty * 50_000);

    return {score};
  };

  let best = null;
  for (const ao of atkOrders){
    for (const do2 of defOrders){
      const sc = scorePlan(ao, do2);
      if (!best || sc.score > best.score){
        best = {...sc, atkOrder: ao, defOrder: do2};
      }
    }
  }

  if (best){
    wp.attackerOrder = best.atkOrder;
    wp.defenderOrder = best.defOrder;
  }
}

// Best-effort base prefetch utility (use in UI effect)
export function speciesListFromSlots(slots){
  return uniq((slots||[]).map(s=>fixName(s.defender)).filter(Boolean));
}
