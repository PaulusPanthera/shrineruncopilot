// js/domain/battle.js
// alpha v1
// Battle step resolution and turn simulation.

import { settingsForWave, enemyThreatForMatchup, assumedEnemyThreatForMatchup } from './waves.js';

export const DEFAULT_MOVE_PP = 12;

function displayMonName(rm, fallback){
  return (rm?.effectiveSpecies || rm?.baseSpecies || fallback || '');
}

function byId(arr, id){
  return (arr||[]).find(x => x && x.id === id);
}

function uniq(arr){
  const out = [];
  for (const x of (arr||[])) if (x != null && !out.includes(x)) out.push(x);
  return out;
}

function baseDefKey(k){
  return String(k || '').split('#')[0];
}

function hasOwn(obj, key){
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function parseGemType(itemName){
  const s = String(itemName||'').trim();
  if (!s.endsWith(' Gem')) return null;
  const t = s.replace(/ Gem$/, '').trim();
  return t || null;
}

function effectiveAttackerItem({state, wp, battle, attackerId}){
  const rm = attackerId ? byId(state?.roster||[], attackerId) : null;
  const base = (wp && wp.itemOverride && attackerId) ? (wp.itemOverride[attackerId] ?? null) : null;
  const fromRoster = rm?.item ?? null;
  let item = base || fromRoster || null;
  if (battle && hasOwn(battle.itemOverrideRuntime, attackerId)){
    item = battle.itemOverrideRuntime[attackerId];
  }
  return item || null;
}

function maybeConsumeGem({battle, attackerId, item, moveName, moveType, didDamagePct, turnLog, attackerLabel}){
  if (!battle || !attackerId) return;
  const gemType = parseGemType(item);
  if (!gemType) return;
  if (String(gemType) !== String(moveType||'')) return;
  if (!(Number(didDamagePct)||0) > 0) return; // no activation if nothing was damaged

  battle.itemOverrideRuntime = battle.itemOverrideRuntime || {};
  battle.itemOverrideRuntime[attackerId] = null;

  // Persist consumable usage so wave fight logs can debit the Bag across fights/waves.
  battle.consumed = Array.isArray(battle.consumed) ? battle.consumed : [];
  battle.consumed.push({attackerId, item: String(item), kind: 'gem'});

  if (turnLog){
    const who = attackerLabel ? String(attackerLabel) : 'Attacker';
    turnLog.push(`${who}'s ${item} was consumed.`);
  }
}

function maybeHealShellBell({battle, attackerId, item, totalDamagePct, turnLog, attackerLabel}){
  if (!battle || !attackerId) return;
  if (String(item||'') !== 'Shell Bell') return;
  const dmg = Number(totalDamagePct)||0;
  if (!(dmg > 0)) return;

  // Battle engine runs in HP% space (0..100). We therefore model Shell Bell as:
  // healPct = floor(totalDamagePct / 8).
  const heal = Math.floor(dmg / 8);
  if (heal <= 0) return;

  const cur = clampHpPct(battle.hpAtk?.[attackerId] ?? 0);
  const next = clampHpPct(cur + heal);
  battle.hpAtk[attackerId] = next;

  if (turnLog){
    const who = attackerLabel ? String(attackerLabel) : 'Attacker';
    turnLog.push(`${who} healed ${heal.toFixed(0)}% (Shell Bell).`);
  }
}

function maybeApplyLifeOrbRecoil({battle, attackerId, item, didDamagePct, turnLog, attackerLabel}){
  if (!battle || !attackerId) return;
  if (String(item||'') !== 'Life Orb') return;
  const dmg = Number(didDamagePct)||0;
  if (!(dmg > 0)) return;

  // Life Orb: user loses 10% max HP on successful damaging attacks.
  const recoil = 10;
  const before = clampHpPct(battle.hpAtk?.[attackerId] ?? 0);
  const after = clampHpPct(before - recoil);
  battle.hpAtk[attackerId] = after;

  if (turnLog){
    const who = attackerLabel ? String(attackerLabel) : 'Attacker';
    turnLog.push(`${who} took ${recoil.toFixed(0)}% recoil (Life Orb).`);
  }
}

function metronomeNextMult(battle, attackerId, moveName, item){
  if (!battle || !attackerId) return 1;
  if (String(item||'') !== 'Metronome') return 1;
  const mv = String(moveName||'');
  if (!mv) return 1;
  battle.metronome = battle.metronome || {};
  const st = battle.metronome[attackerId] || {last:null, streak:0};
  const same = (st.last === mv);
  const nextStreak = same ? Math.min(5, (Number(st.streak)||0) + 1) : 0;
  return 1 + 0.2 * nextStreak;
}

function metronomeRecordUse(battle, attackerId, moveName, item){
  if (!battle || !attackerId) return;
  if (String(item||'') !== 'Metronome') return;
  const mv = String(moveName||'');
  if (!mv) return;
  battle.metronome = battle.metronome || {};
  const st = battle.metronome[attackerId] || {last:null, streak:0};
  if (st.last === mv){
    st.streak = Math.min(5, (Number(st.streak)||0) + 1);
  } else {
    st.last = mv;
    st.streak = 0;
  }
  battle.metronome[attackerId] = st;
}


function ensureAudit(battle){
  // Dev-facing audit is kept on battle objects for debugging, but should NOT be persisted.
  // Make it non-enumerable so JSON.stringify(state) won't bloat localStorage.
  if (!battle) return {execKeys:{}, ppEvents:[]};
  const cur = battle._audit;
  if (cur && typeof cur === 'object') {
    try{
      const d = Object.getOwnPropertyDescriptor(battle, '_audit');
      if (!d || d.enumerable !== false){
        Object.defineProperty(battle, '_audit', {value: cur, writable: true, configurable: true, enumerable: false});
      }
    }catch(e){ /* ignore */ }
    cur.execKeys = (cur.execKeys && typeof cur.execKeys==='object') ? cur.execKeys : {};
    cur.ppEvents = Array.isArray(cur.ppEvents) ? cur.ppEvents : [];
    return cur;
  }
  const val = {execKeys:{}, ppEvents:[]};
  try{
    Object.defineProperty(battle, '_audit', {value: val, writable: true, configurable: true, enumerable: false});
  }catch(e){
    battle._audit = val;
  }
  return val;
}

function maybeTriggerFocusSash({battle, state, wp, targetId, prevHp, nextHp, turnLog, targetLabel}){
  if (!battle || !state || !targetId) return clampHpPct(nextHp ?? 0);
  const before = clampHpPct(prevHp ?? (battle.hpAtk?.[targetId] ?? 0));
  const after0 = clampHpPct(nextHp ?? before);
  if (after0 > 0) return after0;
  if (before < 99.9) return after0;

  const item = effectiveAttackerItem({state, wp, battle, attackerId: targetId});
  if (String(item||'') !== 'Focus Sash') return after0;

  // Survive at 1% in HP% space, then consume the sash for the rest of the battle.
  const after = 1;
  battle.itemOverrideRuntime = battle.itemOverrideRuntime || {};
  battle.itemOverrideRuntime[targetId] = null;

  battle.consumed = Array.isArray(battle.consumed) ? battle.consumed : [];
  battle.consumed.push({attackerId: targetId, item: 'Focus Sash', kind: 'sash'});

  if (turnLog){
    const who = targetLabel ? String(targetLabel) : (displayMonName(byId(state?.roster||[], targetId), 'Target') || 'Target');
    turnLog.push(`${who} hung on at 1% (Focus Sash).`);
  }

  return after;
}

function maybePopAirBalloon({battle, state, wp, targetId, turnLog, targetLabel}){
  if (!battle || !state || !targetId) return;
  const item = effectiveAttackerItem({state, wp, battle, attackerId: targetId});
  if (String(item || '') !== 'Air Balloon') return;
  battle.itemOverrideRuntime = battle.itemOverrideRuntime || {};
  battle.itemOverrideRuntime[targetId] = null;

  // Persist consumable usage so wave fight logs can debit the Bag across fights/waves.
  battle.consumed = Array.isArray(battle.consumed) ? battle.consumed : [];
  battle.consumed.push({attackerId: targetId, item: 'Air Balloon', kind: 'balloon'});

  if (turnLog){
    const who = targetLabel ? String(targetLabel) : (displayMonName(byId(state?.roster||[], targetId), 'Target') || 'Target');
    turnLog.push(`${who}'s Air Balloon popped.`);
  }
}

// Percent helpers
// - HP% is always clamped to [0, 100]
// - Damage% must NOT be clamped to 100 (AoE spread is applied after computing % damage,
//   and overkill values like 150% are needed so 150%×0.75 still correctly OHKOs).
function clampHpPct(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
function clampDmgPct(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  // Keep overkill (e.g., 180%) for correct spread math; cap to avoid runaway UI/log values.
  return Math.max(0, Math.min(9999, n));
}


// Speed stat helper (neutral nature)
function statOther(base, level, iv, ev){
  const evq = Math.floor((Number(ev)||0)/4);
  return Math.floor(((2*Number(base) + Number(iv||0) + evq) * Number(level||0))/100) + 5;
}

function weatherFromAbilityLcLocal(abLc){
  const a = String(abLc||'').trim().toLowerCase();
  if (a === 'drizzle') return 'rain';
  if (a === 'drought') return 'sun';
  if (a === 'sand stream') return 'sand';
  if (a === 'snow warning') return 'hail';
  return null;
}

function defenderAbilityLcFromData(data, species){
  const a = data?.claimedSets?.[String(species||'')]?.ability;
  return String(a||'').trim().toLowerCase();
}

function rosterSpeed(state, data, rosterMon){
  const sp = data?.dex?.[rosterMon?.effectiveSpecies || rosterMon?.baseSpecies]?.base?.spe;
  if (!Number.isFinite(Number(sp))) return 0;
  const lvl = Number(state?.settings?.claimedLevel) || 1;
  const iv = Number(state?.settings?.claimedIV) || 0;
  const ev = rosterMon?.strength ? (Number(state?.settings?.strengthEV)||0) : (Number(state?.settings?.claimedEV)||0);
  return statOther(sp, lvl, iv, ev);
}

function defenderSpeed(state, data, defSlot){
  const sp = data?.dex?.[String(defSlot?.defender||'')]?.base?.spe;
  if (!Number.isFinite(Number(sp))) return 0;
  const lvl = Number(defSlot?.level) || 1;
  const iv = Number(state?.settings?.wildIV) || 0;
  const ev = Number(state?.settings?.wildEV) || 0;
  return statOther(sp, lvl, iv, ev);
}

// Initial weather: ability activation at battle start resolves by Speed; slowest weather setter "wins" (acts last).
// Tie-breaker: prefer DEFENDER-side setter (conservative for shrine planning).
function inferInitialWeather({data, state, atkActiveIds, defActiveKeys, slotByKey}){
  const setters = [];

  for (const rk of (defActiveKeys||[])){
    const sl = slotByKey.get(baseDefKey(rk));
    if (!sl) continue;
    const abLc = defenderAbilityLcFromData(data, sl.defender);
    const w = weatherFromAbilityLcLocal(abLc);
    if (!w) continue;
    setters.push({side:'def', weather:w, ability:abLc, spe: defenderSpeed(state, data, sl)});
  }

  for (const id of (atkActiveIds||[])){
    const rm = byId(state?.roster||[], id);
    if (!rm) continue;
    const abLc = String(rm.ability||'').trim().toLowerCase();
    const w = weatherFromAbilityLcLocal(abLc);
    if (!w) continue;
    setters.push({side:'atk', weather:w, ability:abLc, spe: rosterSpeed(state, data, rm)});
  }

  if (!setters.length) return null;
  setters.sort((a,b)=>{
    if ((a.spe||0) !== (b.spe||0)) return (a.spe||0) - (b.spe||0); // slowest first
    if (a.side !== b.side) return (a.side === 'def') ? -1 : 1;
    return 0;
  });
  return setters[0];
}

function applyWeatherFromSetter({battle, setter, turnLog, when}){
  if (!battle || !setter || !setter.weather) return;
  const next = setter.weather;
  const prev = battle.weather || null;
  battle.weather = next;
  if (turnLog){
    const lbl = String(when||'weather').trim() || 'weather';
    if (prev && prev === next){
      turnLog.push(`Weather persists: ${next} (${setter.ability}).`);
    } else {
      turnLog.push(`Weather set: ${next} (${setter.ability}) · ${lbl}.`);
    }
  }
}

function weatherChipPct(weather){
  if (weather === 'sand' || weather === 'hail') return (100 / 16);
  return 0;
}
function typesForSpecies(data, species){
  const sp = data?.dex?.[String(species||'')]?.types;
  return Array.isArray(sp) ? sp : [];
}
function immuneToWeatherChip(data, weather, species){
  const w = String(weather||'');
  if (!w || !species) return false;
  const types = typesForSpecies(data, species);
  if (w === 'sand'){
    return types.includes('Rock') || types.includes('Ground') || types.includes('Steel');
  }
  if (w === 'hail'){
    return types.includes('Ice');
  }
  return true;
}

function applyOnHitImmunityBoost({battle, state, targetId, moveType, turnLog}){
  if (!battle || !state || !targetId) return;
  const rm = byId(state.roster||[], targetId);
  if (!rm) return;
  const abLc = String(rm.ability||'').trim().toLowerCase();
  const t = String(moveType||'');
  const d = ensureStageDelta(battle, targetId);

  if (t === 'Electric'){
    if (abLc === 'motor drive'){
      d.spe = clampInt((d.spe||0) + 1, -6, 6);
      if (turnLog) turnLog.push(`${displayMonName(rm, targetId)} gained +1 Spe (Motor Drive).`);
    } else if (abLc === 'lightning rod'){
      d.spa = clampInt((d.spa||0) + 1, -6, 6);
      if (turnLog) turnLog.push(`${displayMonName(rm, targetId)} gained +1 SpA (Lightning Rod).`);
    }
  } else if (t === 'Water'){
    if (abLc === 'storm drain'){
      d.spa = clampInt((d.spa||0) + 1, -6, 6);
      if (turnLog) turnLog.push(`${displayMonName(rm, targetId)} gained +1 SpA (Storm Drain).`);
    }
  } else if (t === 'Grass'){
    if (abLc === 'sap sipper'){
      d.atk = clampInt((d.atk||0) + 1, -6, 6);
      if (turnLog) turnLog.push(`${displayMonName(rm, targetId)} gained +1 Atk (Sap Sipper).`);
    }
  }

  battle.stageDelta[targetId] = d;
}
function normPrio(x){
  const n = Number(x);
  // Default midpoint for the expanded 1..5 tier system.
  if (!Number.isFinite(n)) return 3;
  return clampInt(n, 1, 5);
}


// Doubles AoE helpers (Gen 5): spread moves deal 0.75× when they actually hit 2+ targets.
const AOE_OPPONENTS_ONLY = new Set([
  'Electroweb','Rock Slide','Heat Wave','Icy Wind','Muddy Water','Dazzling Gleam','Air Cutter',
  'Hyper Voice','Blizzard','Eruption','Snarl',
]);
const AOE_HITS_ALL = new Set([
  'Earthquake','Surf','Discharge','Bulldoze','Sludge Wave','Lava Plume',
]);

export function isAoeMove(name){
  const n = String(name||'');
  return AOE_OPPONENTS_ONLY.has(n) || AOE_HITS_ALL.has(n);
}
export function aoeHitsAlly(name){
  return AOE_HITS_ALL.has(String(name||''));
}
export function spreadMult(targetsDamaged){
  return (targetsDamaged > 1) ? 0.75 : 1.0;
}
function rosterDefObj(state, rosterMon){
  return {
    species: rosterMon.effectiveSpecies || rosterMon.baseSpecies,
    level: state.settings.claimedLevel,
    ivAll: state.settings.claimedIV,
    evAll: rosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
  };
}
export function immuneFromAllyAbilityItem(allyRosterMon, moveType){
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

export function ensurePPForRosterMon(state, rosterMon){
  if (!state || !rosterMon) return;
  state.pp = state.pp || {};
  const id = rosterMon.id;
  state.pp[id] = state.pp[id] || {};

  const pool = (rosterMon.movePool||[]).filter(m => m && m.use !== false);
  for (const m of pool){
    const name = m.name;
    if (!name) continue;
    const cur = state.pp[id][name];
    if (!cur || typeof cur !== 'object'){
      state.pp[id][name] = {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
    } else {
      if (!('max' in cur)) cur.max = DEFAULT_MOVE_PP;
      if (!('cur' in cur)) cur.cur = cur.max;
      if (!Number.isFinite(Number(cur.max)) || Number(cur.max) <= 0) cur.max = DEFAULT_MOVE_PP;
      if (!Number.isFinite(Number(cur.cur))) cur.cur = cur.max;
      cur.max = Number(cur.max);
      cur.cur = clampInt(cur.cur, 0, cur.max);
    }
  }
}

function clampInt(v, lo, hi){
  const n = Number.parseInt(String(v), 10);
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}

function maybeAutoBumpPrioOnLowPP(state, rosterMonId, moveName, nextCur){
  // Lazy conserve mode: if a move is about to run out (PP <= 5), bump its default prio tier by +1.
  // Only applies once per move (lowPpBumped flag) and only while the move is still auto-managed.
  if (!state || !state.settings || state.settings.autoBumpPrioLowPP === false) return;
  const cur = Number(nextCur);
  if (!Number.isFinite(cur) || cur > 5) return;

  const r = byId(state.roster, rosterMonId);
  if (!r) return;
  const mv = (r.movePool||[]).find(m => m && m.name === moveName);
  if (!mv) return;

  // Respect manual overrides.
  if (mv.prioAuto === false) return;
  if (mv.lowPpBumped === true) return;

  const p0 = Number(mv.prio);
  const base = Number.isFinite(p0) ? p0 : 3;
  mv.prio = clampInt(base + 1, 1, 5);
  mv.prioAuto = true;
  mv.lowPpBumped = true;
}

export function setPP(state, rosterMonId, moveName, nextCur){
  if (!state) return;
  state.pp = state.pp || {};
  state.pp[rosterMonId] = state.pp[rosterMonId] || {};
  const cur = state.pp[rosterMonId][moveName] || {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
  cur.max = Number.isFinite(Number(cur.max)) ? Number(cur.max) : DEFAULT_MOVE_PP;
  cur.cur = clampInt(nextCur, 0, cur.max);
  state.pp[rosterMonId][moveName] = cur;

  maybeAutoBumpPrioOnLowPP(state, rosterMonId, moveName, cur.cur);
}

function getPP(state, rosterMonId, moveName){
  const o = state.pp?.[rosterMonId]?.[moveName];
  if (!o) return {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
  return {cur: Number(o.cur ?? DEFAULT_MOVE_PP), max: Number(o.max ?? DEFAULT_MOVE_PP)};
}

function hasPP(state, rosterMonId, moveName){
  const p = getPP(state, rosterMonId, moveName);
  return (p.cur ?? 0) > 0;
}

function decPP(state, rosterMonId, moveName){
  const p = getPP(state, rosterMonId, moveName);
  const next = Math.max(0, (p.cur ?? 0) - 1);
  setPP(state, rosterMonId, moveName, next);
}

function attackerObj(state, rosterMon){
  return {
    species: rosterMon.effectiveSpecies || rosterMon.baseSpecies,
    level: state.settings.claimedLevel,
    ivAll: state.settings.claimedIV,
    evAll: rosterMon.strength ? state.settings.strengthEV : state.settings.claimedEV,
  };
}

function defenderObj(state, defSlot){
  return {
    species: defSlot.defender,
    level: defSlot.level,
    ivAll: state.settings.wildIV,
    evAll: state.settings.wildEV,
  };
}

function slotSuffix(rowKey, waveKey){
  if (!rowKey) return '';
  if (waveKey && rowKey.startsWith(waveKey)) return rowKey.slice(waveKey.length);
  const m = /S\d+$/.exec(rowKey);
  return m ? m[0] : rowKey;
}

function pickAutoActionForAttacker({data, calc, state, wp, waveKey, attackerId, activeDefSlots, excludeInstKeys, allyId, battle}){
  const r = byId(state.roster, attackerId);
  if (!r) return null;

  const exclude = new Set((excludeInstKeys||[]).filter(Boolean));

  // Candidate moves: enabled + have PP
  let pool = (r.movePool||[]).filter(m => m && m.use !== false && hasPP(state, attackerId, m.name));

  // Optional forced move override (set in Fight plan).
  const forcedName = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[attackerId] || null) : null;
  if (forcedName){
    const forcedPool = pool.filter(m => m && m.name === forcedName);
    if (forcedPool.length) pool = forcedPool;
  }

  // Choice items: if already locked, restrict to the locked move.
  const effItem2 = effectiveAttackerItem({state, wp, battle, attackerId});
  if (battle && isChoiceItem(effItem2)){
    const locked = battle.choiceLock?.[attackerId] || null;
    if (locked){
      const lockedPool = pool.filter(m => m && m.name === locked);
      if (lockedPool.length) pool = lockedPool;
      else {
        try{ delete battle.choiceLock[attackerId]; }catch(e){}
      }
    }
  }

  if (!pool.length) return null;

  function chooseBestMoveForTarget({defSlot, instKey, curFrac}){
    const all = [];
    for (const m of pool){
      if (!m || !m.name) continue;
      const prio = normPrio(m.prio);
      const rr = computeRangeForAttack({
        data, calc, state, wp,
        battle,
        attackerId,
        defSlot,
        moveName: m.name,
        defenderCurHpFrac: curFrac,
      });
      if (!rr?.ok) continue;
      const stabBonus = (rr.stab ? (state?.settings?.stabBonus ?? 0) : 0);
      const score = (Number(rr.minPct)||0) + (Number(stabBonus)||0);
      all.push({...rr, prio, score});
    }
    if (!all.length) return null;

    const oneShots = all.filter(x => !!x.oneShot);
    if (oneShots.length){
      const bestPrio = Math.min(...oneShots.map(x => x.prio));
      const p = oneShots.filter(x => x.prio === bestPrio);
      p.sort((a,b)=>{
        const da = Math.abs((a.minPct||0) - 100);
        const db = Math.abs((b.minPct||0) - 100);
        if ((state?.settings?.conservePower ?? false) && da !== db) return da - db;
        if (!!a.stab !== !!b.stab) return a.stab ? -1 : 1;
        if ((a.eff||1) !== (b.eff||1)) return (b.eff||1) - (a.eff||1);
        if ((a.minPct||0) !== (b.minPct||0)) return (b.minPct||0) - (a.minPct||0);
        return String(a.move||'').localeCompare(String(b.move||''));
      });
      return p[0];
    }

    const bestPrio = Math.min(...all.map(x => x.prio));
    const p = all.filter(x => x.prio === bestPrio);
    p.sort((a,b)=> (b.score - a.score) || ((b.minPct||0) - (a.minPct||0)) || String(a.move||'').localeCompare(String(b.move||'')));
    return p[0];
  }

  // Try every target, take best move per target, then pick best overall.
  const candidates = [];
  const defList = (activeDefSlots||[]);
  const filtered = exclude.size ? defList.filter(ds => !exclude.has(ds?._instKey || ds?.rowKey)) : defList;
  const targets = (filtered.length ? filtered : defList);

  for (const ds of targets){
    const instKey = ds._instKey || ds.rowKey;
    const curFrac = clampHpPct(battle?.hpDef?.[instKey] ?? 100) / 100;
    const b = chooseBestMoveForTarget({defSlot: ds, instKey, curFrac});
    if (!b) continue;

    // Friendly-fire safety: for spread moves that also hit your partner (e.g. Earthquake/Surf/Discharge),
    // avoid picking the move in AUTO if it could KO the ally, unless the user explicitly allows it.
    const allowFF = !!state.settings?.allowFriendlyFire;
    const isFF = aoeHitsAlly(b.move) && isAoeMove(b.move) && !!allyId && !!battle;
    if (isFF && !allowFF && !forcedName){
      const allyMon = byId(state.roster, allyId);
      const allyHp = Number(battle?.hpAtk?.[allyId] ?? 100);
      if (allyMon && allyHp > 0){
        // If ally has an ability/item immunity (Telepathy/Levitate/Air Balloon/etc.), it's safe.
        let immune = false;
        // Compute move type vs the current defender matchup first (approx); if missing, compute directly.
        let moveType = null;
        try{
          const rr2 = computeRangeForAttackVsRoster({
            data, calc, state, wp, battle,
            attackerId,
            defenderRosterId: allyId,
            moveName: b.move,
          });
          if (rr2?.ok){
            moveType = rr2.moveType;
            const allyItemEff = effectiveAttackerItem({state, wp, battle, attackerId: allyId});
            const allyMonEff = {...allyMon, item: allyItemEff};
            immune = immuneFromAllyAbilityItem(allyMonEff, moveType);
            const maxPct = Number(rr2.maxPct ?? rr2.minPct ?? 0) || 0;
            const effMax = immune ? 0 : clampDmgPct(maxPct);
            if (effMax >= allyHp){
              // Reject this candidate; it could KO the partner.
              continue;
            }
          }
        }catch(e){ /* ignore */ }
      }
    }
    candidates.push({
      attackerId,
      // targetRowKey must reference the active instance key (base#N) so HP tracking stays correct.
      targetRowKey: ds._instKey || ds.rowKey,
      targetBaseRowKey: ds._baseRowKey || ds.rowKey,
      move: b.move,
      prio: b.prio ?? 9,
      minPct: Number(b.minPct)||0,
      oneShot: !!b.oneShot,
      slower: !!b.slower,
    });
  }
  if (!candidates.length) return null;

  // Choose: maximize OHKO, then prefer lower prio tier, then OHKO closest to 100, then higher min%.
  candidates.sort((a,b)=>{
    const ao = a.oneShot?1:0;
    const bo = b.oneShot?1:0;
    if (ao !== bo) return bo-ao;
    const ap = a.prio ?? 9;
    const bp = b.prio ?? 9;
    if (ap !== bp) return ap-bp;
    if (a.oneShot && b.oneShot){
      const ak = Math.abs((a.minPct||0)-100);
      const bk = Math.abs((b.minPct||0)-100);
      if (ak !== bk) return ak-bk;
    }
    return (b.minPct||0) - (a.minPct||0);
  });

  return candidates[0];
}

function hasTag(defSlot, tag){
  const t = String(tag||'').trim();
  if (!t) return false;
  return (defSlot?.tags || []).includes(t);
}

function isChoiceItem(item){
  const it = String(item||'').trim();
  return (it === 'Choice Band' || it === 'Choice Specs' || it === 'Choice Scarf');
}

function canEvolveForSpecies(state, species){
  const sp = String(species||'').trim();
  if (!sp) return false;
  const rec = state?.dexMetaCache?.[sp];
  return !!(rec && rec.canEvolve === true);
}

function canUseMove(state, attackerId, moveObj){
  if (!moveObj || !moveObj.name) return false;
  if (moveObj.use === false) return false;
  return hasPP(state, attackerId, moveObj.name);
}

function getAutoMovePool(state, attackerId, rosterMon, wp, battle){
  let pool = (rosterMon?.movePool || []).filter(m => canUseMove(state, attackerId, m));
  const forcedName = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[attackerId] || null) : null;
  if (forcedName){
    const forced = pool.filter(m => m && m.name === forcedName);
    // If the forced move has no PP, ignore the override and fall back to the remaining pool.
    if (forced.length) pool = forced;
  }

  // Choice items: if already locked, you may only use the locked move (if it still has PP).
  const effItem = battle ? effectiveAttackerItem({state, wp, battle, attackerId}) : (rosterMon?.item || null);
  if (battle && isChoiceItem(effItem)){
    const locked = battle.choiceLock?.[attackerId] || null;
    if (locked){
      const lockedPool = pool.filter(m => m && m.name === locked);
      if (lockedPool.length) pool = lockedPool;
      else {
        // No PP or move missing -> release lock (we don't model Struggle).
        try{ delete battle.choiceLock[attackerId]; }catch(e){}
      }
    }
  }

  return pool;
}

function wouldFriendlyFireKOPartner({data, calc, state, wp, attackerId, moveName, allyId, battle}){
  if (!allyId) return false;
  if (!battle) return false;
  const allowFF = !!state.settings?.allowFriendlyFire;
  if (allowFF) return false;
  if (!aoeHitsAlly(moveName) || !isAoeMove(moveName)) return false;

  const atkMon = byId(state.roster, attackerId);
  const allyMon = byId(state.roster, allyId);
  if (!atkMon || !allyMon) return false;
  const allyHp = Number(battle?.hpAtk?.[allyId] ?? 100);
  if (allyHp <= 0) return false;

  let rr2 = null;
  try{
    rr2 = computeRangeForAttackVsRoster({data, calc, state, wp, battle, attackerId, defenderRosterId: allyId, moveName});
  }catch(e){ rr2 = null; }
  if (!rr2?.ok) return false;
  const allyItemEff = effectiveAttackerItem({state, wp, battle, attackerId: allyId});
  const allyMonEff = {...allyMon, item: allyItemEff};
  const immune = immuneFromAllyAbilityItem(allyMonEff, rr2.moveType);
  const maxPct = immune ? 0 : clampDmgPct(Number(rr2.maxPct ?? rr2.minPct ?? 0) || 0);
  // Conservative: ignore spread reduction and assume full damage.
  return maxPct >= allyHp;
}

function simulateTwoAtkActions({data, calc, state, wp, slotByKey, battle, actions}){
  // Deterministic min% sim for the two attacker actions only.
  // Returns {hpDefNext, faintedKeys:Set}
  const hp = {};
  const defKeys = (battle.def.active||[]).filter(Boolean);
  for (const k of defKeys) hp[k] = clampHpPct(battle.hpDef?.[k] ?? 100);

  // Determine order by speed (matching engine sort). Use a sample target to obtain attackerSpe.
  const withSpe = actions.map(a=>{
    const sampleKey = a.sampleTargetKey || a.targetKey || defKeys[0];
    const baseKey = baseDefKey(sampleKey);
    const defSlot = slotByKey.get(baseKey);
    if (!defSlot) return {...a, actorSpe:0};
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      battle,
      attackerId: a.attackerId,
      defSlot,
      moveName: a.move,
      defenderCurHpFrac: clampHpPct(hp[sampleKey] ?? 100) / 100,
    });
    return {...a, actorSpe: Number(rr?.attackerSpe)||0};
  });

  withSpe.sort((a,b)=> (Number(b.actorSpe)||0) - (Number(a.actorSpe)||0));

  for (const act of withSpe){
    if (!act || !act.attackerId || !act.move) continue;
    if (isAoeMove(act.move)){
      const alive = defKeys.filter(k => (hp[k] ?? 0) > 0);
      const hits = [];
      for (const dk of alive){
        const baseKey = baseDefKey(dk);
        const defSlot = slotByKey.get(baseKey);
        if (!defSlot) continue;
        const rr = computeRangeForAttack({
          data, calc, state, wp,
      battle,
          attackerId: act.attackerId,
          defSlot,
          moveName: act.move,
          defenderCurHpFrac: clampHpPct(hp[dk] ?? 100) / 100,
        });
        if (!rr) continue;
        hits.push({dk, min: clampDmgPct(Number(rr.minPct)||0)});
      }
      const targetsDamaged = hits.filter(h => (h.min||0) > 0).length;
      const mult = spreadMult(targetsDamaged);
      for (const h of hits){
        const dmg = clampDmgPct((h.min||0) * mult);
        hp[h.dk] = clampHpPct((hp[h.dk] ?? 0) - dmg);
      }
    } else {
      // single target; redirect if target already fainted
      const want = act.targetKey;
      let tk = want;
      if (!tk || (hp[tk] ?? 0) <= 0){
        tk = defKeys.find(k => (hp[k] ?? 0) > 0) || null;
      }
      if (!tk) continue;
      const baseKey = baseDefKey(tk);
      const defSlot = slotByKey.get(baseKey);
      if (!defSlot) continue;
      const rr = computeRangeForAttack({
        data, calc, state, wp,
      battle,
        attackerId: act.attackerId,
        defSlot,
        moveName: act.move,
      defenderCurHpFrac: clampHpPct(hp[tk] ?? 100) / 100,
      });
      if (!rr) continue;
      const dmg = clampDmgPct(Number(rr.minPct)||0);
      hp[tk] = clampHpPct((hp[tk] ?? 0) - dmg);
    }
  }

  const fainted = new Set(defKeys.filter(k => (hp[k] ?? 0) <= 0));
  return {hpDefNext: hp, faintedKeys: fainted};
}

function pickSturdyAoePlan({data, calc, state, wp, waveKey, slots, slotByKey, battle, activeAtkIds, activeDefSlots}){
  if (!state.settings?.applySTU) return null;
  if (!state.settings?.sturdyAoeSolve) return null;
  if ((activeAtkIds||[]).length < 2) return null;
  if ((activeDefSlots||[]).length !== 2) return null;

  // Only when both attackers are AUTO (no manual move/target locked).
  for (const id of activeAtkIds){
    const m = battle.manual?.[id];
    if (m && m.move && m.targetRowKey) return null;
  }

  const d0 = activeDefSlots[0];
  const d1 = activeDefSlots[1];
  const k0 = d0?._instKey;
  const k1 = d1?._instKey;
  if (!k0 || !k1) return null;

  const hp0 = clampHpPct(battle.hpDef?.[k0] ?? 100);
  const hp1 = clampHpPct(battle.hpDef?.[k1] ?? 100);

  // Identify exactly one STU target at full HP.
  const d0Stu = hasTag(d0,'STU') && hp0 >= 99.9;
  const d1Stu = hasTag(d1,'STU') && hp1 >= 99.9;
  if ((d0Stu && d1Stu) || (!d0Stu && !d1Stu)) return null;

  const stuKey = d0Stu ? k0 : k1;
  const otherKey = d0Stu ? k1 : k0;
  const allyA = activeAtkIds[0];
  const allyB = activeAtkIds[1];

  const rosterA = byId(state.roster, allyA);
  const rosterB = byId(state.roster, allyB);
  if (!rosterA || !rosterB) return null;

  const poolA = getAutoMovePool(state, allyA, rosterA, wp, battle);
  const poolB = getAutoMovePool(state, allyB, rosterB, wp, battle);
  if (!poolA.length || !poolB.length) return null;

  const aoeA = poolA.filter(m => isAoeMove(m.name));
  const aoeB = poolB.filter(m => isAoeMove(m.name));
  if (!aoeA.length && !aoeB.length) return null;

  const consider = [];

  const hpOtherNow = clampHpPct(battle.hpDef?.[otherKey] ?? 100);

  function aoeKillsNonStuNow({attackerId, moveName}){
    // Determine if the AoE alone is a guaranteed kill on the non-STU target at current HP.
    // Use the battle engine's spread reduction model (×0.75 when hitting 2 defenders).
    const baseKey = baseDefKey(otherKey);
    const defSlot = slotByKey.get(baseKey);
    if (!defSlot) return false;
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      battle,
      attackerId,
      defSlot,
      moveName,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[otherKey] ?? 100) / 100,
    });
    if (!rr) return false;
    const mult = spreadMult(2); // exactly 2 defenders alive in this rule
    const minAdj = clampDmgPct(Number(rr.minPct||0) * mult);
    return minAdj >= hpOtherNow;
  }

  function addCombos(aoeUserId, aoePool, finUserId, finPool){
    const allyId = finUserId;
    for (const mAoe of aoePool){
      if (wouldFriendlyFireKOPartner({data, calc, state, wp, attackerId: aoeUserId, moveName: mAoe.name, allyId, battle})) continue;
      const aoeKillsNonStu = aoeKillsNonStuNow({attackerId: aoeUserId, moveName: mAoe.name});
      for (const mFin of finPool){
        // Prefer aiming at STU, but also try aiming at the other to allow redirects.
        for (const tgt of [stuKey, otherKey]){
          if (aoeKillsNonStu && tgt === otherKey) continue;
          const sim = simulateTwoAtkActions({
            data, calc, state, wp, slotByKey, battle,
            actions: [
              {attackerId: aoeUserId, move: mAoe.name, targetKey: otherKey, sampleTargetKey: otherKey},
              {attackerId: finUserId, move: mFin.name, targetKey: tgt, sampleTargetKey: tgt},
            ]
          });
          const hpNext = sim.hpDefNext;
          const otherAlive = (hpNext[otherKey] ?? 0) > 0;
          const stuAlive = (hpNext[stuKey] ?? 0) > 0;
          const win = !otherAlive && !stuAlive;
          const nonStuDead = !otherAlive;
          const stuDead = !stuAlive;
          const prA = normPrio(mAoe.prio);
          const prF = normPrio(mFin.prio);
          const sumPr = prA + prF;
          const remStu = clampHpPct(hpNext[stuKey] ?? 0);
          const remOther = clampHpPct(hpNext[otherKey] ?? 0);
          consider.push({
            win,
            aoeKillsNonStu,
            nonStuDead,
            stuDead,
            finHitsStu: (tgt === stuKey),
            sumPr,
            remStu,
            remOther,
            aoeUserId,
            aoeMove: mAoe.name,
            aoePrio: prA,
            finUserId,
            finMove: mFin.name,
            finPrio: prF,
            finTarget: tgt,
          });
        }
      }
    }
  }

  if (aoeA.length) addCombos(allyA, aoeA, allyB, poolB);
  if (aoeB.length) addCombos(allyB, aoeB, allyA, poolA);

  if (!consider.length) return null;

  // Rank:
  // 1) Win this turn if possible
  // 2) Prefer AoE that can solo-kill the non-STU add (so the other attacker can focus STU)
  // 2) Otherwise: kill non-STU + minimize STU remaining (set up for next turn)
  // 3) Prefer lower sum prio tiers
  consider.sort((x,y)=>{
    const wx = x.win ? 1 : 0;
    const wy = y.win ? 1 : 0;
    if (wx !== wy) return wy - wx;

    const ax = x.aoeKillsNonStu ? 1 : 0;
    const ay = y.aoeKillsNonStu ? 1 : 0;
    if (ax !== ay) return ay - ax;

    const nx = x.nonStuDead ? 1 : 0;
    const ny = y.nonStuDead ? 1 : 0;
    if (nx !== ny) return ny - nx;

    // If the add is dead, prefer plans that spend the 2nd attacker on STU (not redundantly on the add).
    const fx = x.finHitsStu ? 1 : 0;
    const fy = y.finHitsStu ? 1 : 0;
    if (fx !== fy) return fy - fx;

    const sx = x.stuDead ? 1 : 0;
    const sy = y.stuDead ? 1 : 0;
    if (sx !== sy) return sy - sx;
    if ((x.remStu||0) !== (y.remStu||0)) return (x.remStu||0) - (y.remStu||0);
    if ((x.sumPr||0) !== (y.sumPr||0)) return (x.sumPr||0) - (y.sumPr||0);
    if ((x.remOther||0) !== (y.remOther||0)) return (x.remOther||0) - (y.remOther||0);
    return String(x.aoeMove||'').localeCompare(String(y.aoeMove||''));
  });

  const best = consider[0];
  if (!best) return null;
  return {
    stuKey,
    otherKey,
    picks: [
      {attackerId: best.aoeUserId, move: best.aoeMove, prio: best.aoePrio, targetKey: otherKey},
      {attackerId: best.finUserId, move: best.finMove, prio: best.finPrio, targetKey: best.finTarget},
    ]
  };
}

function pickSturdyBasePlan({data, calc, state, wp, slotByKey, battle, activeAtkIds, activeDefSlots}){
  // "Simple ground logic" fallback for STU:
  // - Ensure the non-STU target dies this turn (one attacker)
  // - The other attacker chips STU with a P1 move (prefer) to set up a clean finish next turn.
  if (!state.settings?.applySTU) return null;
  if ((activeAtkIds||[]).length < 2) return null;
  if ((activeDefSlots||[]).length !== 2) return null;

  const d0 = activeDefSlots[0];
  const d1 = activeDefSlots[1];
  const k0 = d0?._instKey;
  const k1 = d1?._instKey;
  if (!k0 || !k1) return null;

  const hp0 = clampHpPct(battle.hpDef?.[k0] ?? 100);
  const hp1 = clampHpPct(battle.hpDef?.[k1] ?? 100);

  const d0Stu = hasTag(d0,'STU') && hp0 >= 99.9;
  const d1Stu = hasTag(d1,'STU') && hp1 >= 99.9;
  if ((d0Stu && d1Stu) || (!d0Stu && !d1Stu)) return null;

  const stuKey = d0Stu ? k0 : k1;
  const otherKey = d0Stu ? k1 : k0;

  // Only when both attackers are AUTO (no manual lock).
  for (const id of activeAtkIds){
    const m = battle.manual?.[id];
    if (m && m.move && m.targetRowKey) return null;
  }

  const a0 = activeAtkIds[0];
  const a1 = activeAtkIds[1];
  const r0 = byId(state.roster, a0);
  const r1 = byId(state.roster, a1);
  if (!r0 || !r1) return null;

  const pool0 = getAutoMovePool(state, a0, r0, wp, battle);
  const pool1 = getAutoMovePool(state, a1, r1, wp, battle);
  if (!pool0.length || !pool1.length) return null;

  const otherHpNow = clampHpPct(battle.hpDef?.[otherKey] ?? 100);
  const baseOther = slotByKey.get(baseDefKey(otherKey));
  const baseStu = slotByKey.get(baseDefKey(stuKey));
  if (!baseOther || !baseStu) return null;

  const bestKill = [];
  const evalKill = (attackerId, pool)=>{
    for (const m of pool){
      const rr = computeRangeForAttack({
        data, calc, state, wp,
      battle,
        attackerId,
        defSlot: baseOther,
        moveName: m.name,
        defenderCurHpFrac: clampHpPct(battle.hpDef?.[otherKey] ?? 100) / 100,
      });
      if (!rr) continue;
      const aoe = isAoeMove(m.name);
      const mult = aoe ? spreadMult(2) : 1.0;
      const minAdj = clampDmgPct(Number(rr.minPct||0) * mult);
      const pr = normPrio(m.prio);
      const ok = minAdj >= otherHpNow;
      bestKill.push({ok, attackerId, move:m.name, prio:pr, aoe, minAdj});
    }
  };
  evalKill(a0, pool0);
  evalKill(a1, pool1);

  // pick the best guaranteed kill for the non-STU target
  const killers = bestKill.filter(x=>x.ok);
  if (!killers.length) return null;
  killers.sort((x,y)=>{
    if ((x.prio||0) !== (y.prio||0)) return (x.prio||0) - (y.prio||0);
    if ((y.minAdj||0) !== (x.minAdj||0)) return (y.minAdj||0) - (x.minAdj||0);
    return String(x.move||'').localeCompare(String(y.move||''));
  });
  const killPick = killers[0];
  const chipId = (killPick.attackerId === a0) ? a1 : a0;
  const chipPool = (chipId === a0) ? pool0 : pool1;

  // Pick a chip move into STU: prefer P1, then maximize min damage (but any >0 is fine).
  const chips = [];
  for (const m of chipPool){
    if (wouldFriendlyFireKOPartner({data, calc, state, wp, attackerId: chipId, moveName: m.name, allyId: killPick.attackerId, battle})) continue;
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      battle,
      attackerId: chipId,
      defSlot: baseStu,
      moveName: m.name,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[stuKey] ?? 100) / 100,
    });
    if (!rr) continue;
    const aoe = isAoeMove(m.name);
    const mult = aoe ? spreadMult(2) : 1.0;
    const minAdj = clampDmgPct(Number(rr.minPct||0) * mult);
    const pr = normPrio(m.prio);
    if (minAdj <= 0) continue;
    chips.push({attackerId: chipId, move:m.name, prio:pr, minAdj});
  }
  if (!chips.length) return null;
  chips.sort((x,y)=>{
    if ((x.prio||0) !== (y.prio||0)) return (x.prio||0) - (y.prio||0);
    if ((y.minAdj||0) !== (x.minAdj||0)) return (y.minAdj||0) - (x.minAdj||0);
    return String(x.move||'').localeCompare(String(y.move||''));
  });
  const chipPick = chips[0];

  return {
    stuKey,
    otherKey,
    picks: [
      {attackerId: killPick.attackerId, move: killPick.move, prio: killPick.prio, targetKey: otherKey},
      {attackerId: chipPick.attackerId, move: chipPick.move, prio: chipPick.prio, targetKey: stuKey},
    ]
  };
}

function computeRangeForAttack({data, calc, state, wp, battle, attackerId, defSlot, moveName, defenderCurHpFrac}){
  const r = byId(state.roster, attackerId);
  if (!r) return null;
  const atk = attackerObj(state, r);
  const def = defenderObj(state, defSlot);
  const sW0 = settingsForWave(state, wp, attackerId, defSlot.rowKey, defSlot.defender);
  const sW1 = applyBattleStageDeltaToSettings(sW0, battle, attackerId);

  // Apply battle runtime item overrides (consumables, etc.)
  const effItem = effectiveAttackerItem({state, wp, battle, attackerId});
  const metMult = metronomeNextMult(battle, attackerId, moveName, effItem);
  const sWBase = {
    ...sW1,
    attackerItem: effItem,
    defenderCurHpFrac: (defenderCurHpFrac ?? 1),
    weather: (battle?.weather || null),
    otherMult: (Number(sW1?.otherMult ?? 1) || 1) * metMult,
  };

  // Gems: battle engine models true semantics (x1.5 for matching type, consumed on use).
  // To avoid the planner's simplified always-on x1.5 gem modeling, we strip the gem item from calc
  // and pass an explicit powerMult only when the gem matches the *actual* computed move type.
  const gemType = parseGemType(effItem);
  if (gemType){
    // First compute without gem to get the final move type (e.g., Weather Ball).
    const base = calc.computeDamageRange({
      data,
      attacker: atk,
      defender: def,
      moveName,
      settings: {...sWBase, attackerItem: null, powerMult: 1},
      tags: defSlot.tags || [],
    });
    if (!base?.ok) return null;
    if (String(base.moveType||'') !== String(gemType)) return base;

    const boosted = calc.computeDamageRange({
      data,
      attacker: atk,
      defender: def,
      moveName,
      settings: {...sWBase, attackerItem: null, powerMult: 1.5},
      tags: defSlot.tags || [],
    });
    if (!boosted?.ok) return base;
    boosted._gemApplied = true;
    boosted._gemItem = effItem;
    return boosted;
  }

  const rr = calc.computeDamageRange({
    data,
    attacker: atk,
    defender: def,
    moveName,
    settings: sWBase,
    tags: defSlot.tags || [],
  });
  if (!rr?.ok) return null;
  return rr;
}

function computeRangeForAttackVsRoster({data, calc, state, wp, battle, attackerId, defenderRosterId, moveName}){
  const r = byId(state?.roster||[], attackerId);
  const t = byId(state?.roster||[], defenderRosterId);
  if (!r || !t) return null;

  const effItem = effectiveAttackerItem({state, wp, battle, attackerId});
  const defenderItem = effectiveAttackerItem({state, wp, battle, attackerId: defenderRosterId});
  const curFrac = clampHpPct(battle?.hpAtk?.[defenderRosterId] ?? 100) / 100;

  const sW0 = settingsForWave(state, wp, attackerId, null);
  const sW1 = applyBattleStageDeltaToSettings(sW0, battle, attackerId);
  const sWBase = {
    ...sW1,
    attackerItem: effItem,
    defenderItem,
    defenderCanEvolve: canEvolveForSpecies(state, (t.effectiveSpecies || t.baseSpecies || t.species)),
    defenderAbility: (t.ability || null),
    defenderCurHpFrac: curFrac,
    weather: (battle?.weather || null),
  };

  const atk = attackerObj(state, r);
  const def = rosterDefObj(state, t);

  const gemType = parseGemType(effItem);
  if (gemType){
    const base = calc.computeDamageRange({
      data,
      attacker: atk,
      defender: def,
      moveName,
      settings: {...sWBase, attackerItem: null, powerMult: 1},
      tags: [],
    });
    if (!base?.ok) return null;
    if (String(base.moveType||'') !== String(gemType)) return base;
    const boosted = calc.computeDamageRange({
      data,
      attacker: atk,
      defender: def,
      moveName,
      settings: {...sWBase, attackerItem: null, powerMult: 1.5},
      tags: [],
    });
    return boosted?.ok ? boosted : base;
  }

  const rr = calc.computeDamageRange({
    data,
    attacker: atk,
    defender: def,
    moveName,
    settings: sWBase,
    tags: [],
  });
  return rr?.ok ? rr : null;
}

function computeRangeForThreat({data, calc, state, wp, attackerId, defSlot, threatMoveName}){
  // defender (enemy) attacks attacker
  const attackerMon = byId(state.roster, attackerId);
  if (!attackerMon) return null;

  // Use the same threat model settings; easiest is to call enemyThreatForMatchup and then
  // (optionally) re-compute damage range for the chosen move for consistency.
  const threat = enemyThreatForMatchup(data, state, wp, attackerMon, defSlot) || assumedEnemyThreatForMatchup(data, state, wp, attackerMon, defSlot);
  if (!threat) return null;
  return {threat};
}

function pickEnemyAction({data, state, wp, attackerIds, defSlot, battle=null}){
  const choices = [];
  for (const atkId of attackerIds){
    const attackerMon = byId(state.roster, atkId);
    if (!attackerMon) continue;

    const speDelta = Number(battle?.stageDelta?.[atkId]?.spe ?? 0) || 0;
    const baseMods = (attackerMon.mods || {});
    const mods = {...(baseMods||{})};
    if (speDelta){
      mods.speStage = clampInt((mods.speStage ?? 0) + speDelta, -6, 6);
    }
    const attackerMonAdj = (speDelta ? {...attackerMon, mods} : attackerMon);
    const opts = {weather: (battle?.weather || null)};
    const t = enemyThreatForMatchup(data, state, wp, attackerMonAdj, defSlot, opts)
      || assumedEnemyThreatForMatchup(data, state, wp, attackerMonAdj, defSlot, opts);
    if (!t) continue;
    choices.push({
      targetId: atkId,
      move: t.move,
      moveType: t.moveType,
      category: t.category,
      minPct: Number(t.minPct)||0,
      maxPct: Number(t.maxPct)||Number(t.minPct)||0,
      oneShot: !!t.oneShot,
      ohkoChance: Number(t.ohkoChance)||0,
      aoe: !!t.aoe,
      enemyActsFirst: !!t.enemyActsFirst,
      enemySpe: Number(t.attackerSpe)||0,
      targetSpe: Number(t.defenderSpe)||0,
      chosenReason: t.chosenReason || ( (t.ohkoChance||0)>0 ? 'ohkoChance' : 'maxDamage'),
      assumed: !!t.assumed,
    });
  }
  if (!choices.length) return null;

  const anyChance = choices.some(c => (c.ohkoChance||0) > 0);
  choices.sort((a,b)=>{
    if (anyChance){
      if ((a.ohkoChance||0) !== (b.ohkoChance||0)) return (b.ohkoChance||0) - (a.ohkoChance||0);
    }
    if ((a.minPct||0) !== (b.minPct||0)) return (b.minPct||0) - (a.minPct||0);
    if ((a.maxPct||0) !== (b.maxPct||0)) return (b.maxPct||0) - (a.maxPct||0);
    return String(a.move||'').localeCompare(String(b.move||''));
  });

  const best = choices[0];
  return best;
}

function ensureStageDelta(battle, attackerId){
  battle.stageDelta = battle.stageDelta || {};
  const cur = battle.stageDelta[attackerId] || {atk:0, spa:0, spe:0};
  cur.atk = Number.isFinite(Number(cur.atk)) ? Number(cur.atk) : 0;
  cur.spa = Number.isFinite(Number(cur.spa)) ? Number(cur.spa) : 0;
  cur.spe = Number.isFinite(Number(cur.spe)) ? Number(cur.spe) : 0;
  battle.stageDelta[attackerId] = cur;
  return cur;
}

function applyBattleStageDeltaToSettings(sW0, battle, attackerId){
  if (!battle || !attackerId) return sW0;
  const d = battle.stageDelta?.[attackerId];
  if (!d) return sW0;
  return {
    ...sW0,
    atkStage: clampInt((sW0.atkStage ?? 0) + (d.atk ?? 0), -6, 6),
    spaStage: clampInt((sW0.spaStage ?? 0) + (d.spa ?? 0), -6, 6),
    speStage: clampInt((sW0.speStage ?? 0) + (d.spe ?? 0), -6, 6),
  };
}

function applyEnemyIntimidate({battle, state, count=1, reason=''}){
  const n = clampInt(count, 0, 6);
  if (!battle || !state || n <= 0) return;
  // Settings toggle: allow disabling INT effects entirely.
  if (state?.settings?.applyINT === false) return;
  const active = (battle.atk?.active||[]).filter(Boolean).filter(id => (battle.hpAtk?.[id] ?? 0) > 0);
  const INTIMIDATE_IMMUNE_ABS = new Set(['clear body','white smoke','hyper cutter','full metal body']);

  const logParts = [];

  for (const id of active){
    const rm = byId(state.roster||[], id);
    const ab = String(rm?.ability || '').trim().toLowerCase();
    if (INTIMIDATE_IMMUNE_ABS.has(ab)) continue;
    const d = ensureStageDelta(battle, id);

    // Intimidate lowers Atk by 1 stage per activation.
    const beforeAtk = Number(d.atk || 0);
    const beforeSpa = Number(d.spa || 0);
    d.atk = clampInt(beforeAtk - n, -6, 6);
    const lowered = (d.atk !== beforeAtk);

    // Competitive: +2 SpA per stat-lowering event.
    if (lowered && ab === 'competitive'){
      d.spa = clampInt((d.spa || 0) + 2*n, -6, 6);
    }

    // Defiant: +2 Atk per stat-lowering event.
    if (lowered && ab === 'defiant'){
      d.atk = clampInt((d.atk || 0) + 2*n, -6, 6);
    }

    battle.stageDelta[id] = d;

    // Battle log: show the net stage changes so players can audit preview correctness.
    if (lowered){
      const label = (rm?.effectiveSpecies || rm?.baseSpecies || id);
      const bits = [];
      if ((d.atk || 0) !== beforeAtk){
        const delta = (d.atk || 0) - beforeAtk;
        bits.push(`Atk ${delta >= 0 ? '+' : ''}${delta}`);
      }
      if ((d.spa || 0) !== beforeSpa){
        const delta = (d.spa || 0) - beforeSpa;
        bits.push(`SpA ${delta >= 0 ? '+' : ''}${delta}${ab === 'competitive' ? ' (Competitive)' : ''}`);
      }
      if (!bits.length) bits.push('Atk -?');
      logParts.push(`${label}: ${bits.join(', ')}`);
    }
  }

  if (logParts.length){
    const r = String(reason || '').trim();
    battle.log.push(`Enemy Intimidate x${n}${r ? ` (${r})` : ''}: ${logParts.join(' · ')}`);
  }

  // Dev-facing audit only.
  try{
    const audit = ensureAudit(battle);
    audit.intimidateEvents = (audit.intimidateEvents || 0) + n;
    audit.intimidateLog = audit.intimidateLog || [];
    audit.intimidateLog.push({waveKey: battle.waveKey, count:n, reason: String(reason||'')});
  }catch(e){}
}

export function initBattleForWave({data, calc, state, waveKey, slots}){
  state.battles = state.battles || {};
  const wp = state.wavePlans?.[waveKey];
  if (!wp) return null;

  const slotByKey = new Map((slots||[]).map(s=>[s.rowKey,s]));

  // Allow duplicate defenders by expanding repeated base rowKeys into instance keys (#2/#3/...)
  // while still resolving stats/moves off the base rowKey.
  const baseCounts = {};
  const defKeys = (wp.defenders||[])
    .filter(Boolean)
    .map(raw=>{
      const base = baseDefKey(raw);
      baseCounts[base] = (baseCounts[base] || 0) + 1;
      const n = baseCounts[base];
      return n === 1 ? base : `${base}#${n}`;
    });

  const defSlots = defKeys.map(k=>slotByKey.get(baseDefKey(k))).filter(Boolean);
  // We keep battle keys as the expanded instance keys (base#N).
  const defActive = defKeys.slice(0,2);
  const defBench = defKeys.slice(2);

  // Enemy INT (Intimidate): stacks per INT user on the field and triggers again when an INT reinforcement joins.
  const leadIntCount = defActive
    .map(k=>slotByKey.get(baseDefKey(k)))
    .filter(Boolean)
    .filter(sl => (sl.tags||[]).includes('INT')).length;

  const attackerIds = (wp.attackerOrder||wp.attackerStart||wp.attackers||[]).slice(0,16).filter(Boolean);
  const atkActive = uniq(attackerIds.slice(0,2));
  const atkBench = attackerIds.filter(id=>!atkActive.includes(id));

  // Ensure PP seeded
  for (const id of attackerIds){
    const r = byId(state.roster,id);
    if (r) ensurePPForRosterMon(state, r);
  }

  const hpAtk = {};
  const hpDef = {};
  for (const id of atkActive){ hpAtk[id] = 100; }
  for (const rk of defActive){ hpDef[rk] = 100; }

  const battle = {
    status: 'active',
    waveKey,
    atk: {active: atkActive, bench: atkBench},
    def: {active: defActive, bench: defBench},
    hpAtk,
    hpDef,
    stageDelta: {},
    weather: null,
    manual: {}, // attackerId -> {move,targetRowKey}
    lastActions: {atk:{}, def:{}},
    history: [], // list of {side:'atk'|'def', actorId?, actorKey?, move, prio?, aoe?, target?}
    log: [`Fight started (${waveKey}).`],
    pending: null, // {side:'atk'|'def', slotIndex:number}
    claimed: false,

    // Dev-facing audit (non-persisted): used to catch PP double-spend / ghost actions.
    // Not shown in UI.
    _audit: {execKeys:{}, ppEvents:[]},
    joinCount: {atk: atkActive.length, def: defActive.length},

    // Runtime held-item overrides (battle-only). Used for consumables (e.g., Gems) without mutating roster.
    itemOverrideRuntime: {},

    // Choice items: once you act, you are locked into that move for the rest of the battle.
    choiceLock: {},

    // Consumables used in this battle (attacker-side only). Used to debit the Bag across fights/waves.
    consumed: [],
  };

  // Ensure audit exists but is NOT persisted into localStorage saves.
  ensureAudit(battle);

  // Initial weather (from ability setters on the field). Slowest setter wins.
  const wSetter = inferInitialWeather({data, state, atkActiveIds: atkActive, defActiveKeys: defActive, slotByKey});
  if (wSetter && wSetter.weather){
    applyWeatherFromSetter({battle, setter: wSetter, turnLog: battle.log, when: 'battle-start'});
  }

  // Apply initial enemy Intimidate activations to the starting active attackers.
  if (leadIntCount > 0 && state?.settings?.applyINT !== false){
    applyEnemyIntimidate({battle, state, count: leadIntCount, reason: 'lead-start'});
  }

  state.battles[waveKey] = battle;
  return battle;
}

export function resetBattle(state, waveKey){
  if (!state?.battles) return;
  delete state.battles[waveKey];
}

export function setManualAction(state, waveKey, attackerId, patch){
  const b = state.battles?.[waveKey];
  if (!b) return;
  b.manual = b.manual || {};
  if (!patch){
    delete b.manual[attackerId];
    return;
  }
  const cur = b.manual[attackerId] || {};
  b.manual[attackerId] = {...cur, ...patch};
}

export function chooseReinforcement(state, waveKey, side, slotIndex, chosen){
  const b = state.battles?.[waveKey];
  if (!b) return;
  if (!b.pending) return;
  if (b.pending.side !== side || b.pending.slotIndex !== slotIndex) return;

  if (side === 'atk'){
    const idx = b.atk.bench.indexOf(chosen);
    if (idx === -1) return;
    b.atk.bench.splice(idx,1);
    b.atk.active[slotIndex] = chosen;
    b.hpAtk[chosen] = 100;
    b.joinCount = b.joinCount || {atk:0, def:0};
    b.joinCount.atk = (b.joinCount.atk || 0) + 1;
  } else {
    const idx = b.def.bench.indexOf(chosen);
    if (idx === -1) return;
    b.def.bench.splice(idx,1);
    b.def.active[slotIndex] = chosen;
    b.hpDef[chosen] = 100;
    b.joinCount = b.joinCount || {atk:0, def:0};
    b.joinCount.def = (b.joinCount.def || 0) + 1;
  }
  b.pending = null;
}

function countAliveActive(arr, hp){
  return (arr||[]).filter(Boolean).filter(k => (hp?.[k] ?? 0) > 0).length;
}

function countAliveBench(arr, hp, defaultHp){
  const d = Number.isFinite(Number(defaultHp)) ? Number(defaultHp) : 100;
  return (arr||[]).filter(Boolean).filter(k => (hp?.[k] ?? d) > 0).length;
}

function countAliveDefenders(battle){
  return countAliveActive(battle?.def?.active, battle?.hpDef) + countAliveBench(battle?.def?.bench, battle?.hpDef, 100);
}

function countAliveAttackers(battle){
  return countAliveActive(battle?.atk?.active, battle?.hpAtk) + countAliveBench(battle?.atk?.bench, battle?.hpAtk, 100);
}

function autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog}){
  if (!battle) return;
  // Defenders: deterministic join order (#3/#4) from bench[0..].
  for (let i=0;i<2;i++){
    if (!battle.def?.active) break;
    if (battle.def.active[i]) continue;
    const next = (battle.def.bench||[]).shift();
    if (!next) continue;
    battle.def.active[i] = next;
    battle.hpDef[next] = 100;
    battle.joinCount = battle.joinCount || {atk:0, def:0};
    battle.joinCount.def = (battle.joinCount.def || 0) + 1;
    const sl = slotByKey.get(baseDefKey(next));
    const lbl = sl ? battleLabelForRowKey({rowKey: next, waveKey, defender: sl.defender, level: sl.level}) : String(next);
    if (turnLog) turnLog.push(`Reinforcement entered: ${lbl}.`);
        // Weather setters trigger when a weather-ability mon enters the field.
    const joinAbLc = defenderAbilityLcFromData(data, sl?.defender);
    const joinW = weatherFromAbilityLcLocal(joinAbLc);
    if (joinW){
      applyWeatherFromSetter({battle, setter: {weather: joinW, ability: joinAbLc}, turnLog, when: 'def-join'});
    }

// Intimidate triggers when an INT defender enters the field.
    if ((sl?.tags||[]).includes('INT') && state?.settings?.applyINT !== false){
      applyEnemyIntimidate({battle, state, count: 1, reason: 'def-join'});
      if (turnLog) turnLog.push('Enemy Intimidate activated.');
    }
  }

  // Attackers: deterministic join order from bench[0..].
  for (let i=0;i<2;i++){
    if (!battle.atk?.active) break;
    if (battle.atk.active[i]) continue;
    const next = (battle.atk.bench||[]).shift();
    if (!next) continue;
    battle.atk.active[i] = next;
    battle.hpAtk[next] = 100;
    battle.joinCount = battle.joinCount || {atk:0, def:0};
    battle.joinCount.atk = (battle.joinCount.atk || 0) + 1;
    const rm = (state?.roster||[]).find(r=>r && r.id === next);
    const nm = displayMonName(rm, String(next)) || String(next);
    // Show join #3/#4 semantics for clarity.
    const joinN = (battle.joinCount.atk || 0);
    if (turnLog) turnLog.push(`Reinforcement entered: ${nm} · #${joinN}.`);
    // Weather setters on your side trigger when the mon joins.
    const atkAbLc = String(rm?.ability || '').trim().toLowerCase();
    const atkW = weatherFromAbilityLcLocal(atkAbLc);
    if (atkW){
      applyWeatherFromSetter({battle, setter: {weather: atkW, ability: atkAbLc}, turnLog, when: 'atk-join'});
    }

  }
}

function ensurePending(battle){
  // Find first empty slot caused by a faint.
  // Prefer defenders first (so you pick enemy reinforcements), then attackers.
  for (let i=0;i<2;i++){
    const rk = battle.def.active[i];
    if (!rk){
      if (battle.def.bench.length){
        battle.pending = {side:'def', slotIndex:i};
        return true;
      }
    }
  }
  for (let i=0;i<2;i++){
    const id = battle.atk.active[i];
    if (!id){
      if (battle.atk.bench.length){
        battle.pending = {side:'atk', slotIndex:i};
        return true;
      }
    }
  }
  return false;
}

function enforceChoiceLockOnPick({data, calc, state, wp, battle, attackerId, pick}){
  if (!battle || !pick || !attackerId) return pick;
  const effItem = effectiveAttackerItem({state, wp, battle, attackerId});
  if (!isChoiceItem(effItem)) return pick;

  const locked = battle.choiceLock?.[attackerId] || null;
  if (!locked) return pick;
  if (pick.move === locked) return pick;

  if (hasPP(state, attackerId, locked)){
    return { ...pick, move: locked, _choiceEnforced: true };
  }

  // If the locked move is unusable, release the lock (no Struggle modeling).
  try{ delete battle.choiceLock[attackerId]; }catch(e){}
  return pick;
}

function maybeSetChoiceLock({battle, state, wp, attackerId, item, moveName, turnLog, attackerLabel}){
  if (!battle) return;
  if (!isChoiceItem(item)) return;
  battle.choiceLock = battle.choiceLock || {};
  if (battle.choiceLock[attackerId]) return;
  battle.choiceLock[attackerId] = moveName;
  if (turnLog && attackerLabel){
    turnLog.push(`${attackerLabel} is locked into ${moveName} (Choice).`);
  }
}

export function stepBattleTurn({data, calc, state, waveKey, slots}){
  const battle = state.battles?.[waveKey];
  if (!battle) return;
  if (battle.status !== 'active') return;
  // Legacy compatibility: if a pending reinforcement exists (older saves), auto-resolve deterministically.
  if (battle.pending){
    const p = battle.pending;
    const list = (p.side === 'def') ? (battle.def?.bench||[]) : (battle.atk?.bench||[]);
    const choice = list[0] || null;
    if (choice) chooseReinforcement(state, waveKey, p.side, p.slotIndex, choice);
    else battle.pending = null;
  }

  const wp = state.wavePlans?.[waveKey];
  if (!wp) return;
  const slotByKey = new Map((slots||[]).map(s=>[s.rowKey,s]));

  // Ensure any empty slots are immediately filled from bench (2v3 / 2v4 correctness).
  // Replacements DO NOT get an action this turn (action list is constructed below from current actives).
  autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog: null});

  const activeAtkIds = (battle.atk.active||[]).filter(Boolean).filter(id => (battle.hpAtk[id] ?? 0) > 0);
  const activeDefKeys = (battle.def.active||[]).filter(Boolean).filter(rk => (battle.hpDef[rk] ?? 0) > 0);
  const activeDefSlots = activeDefKeys.map(rk=>{
    const baseKey = baseDefKey(rk);
    const sl = slotByKey.get(baseKey);
    if (!sl) return null;
    // Keep instance key separate from base rowKey so we can track HP per-instance (#1/#2/...).
    return {...sl, _instKey: rk, _baseRowKey: baseKey};
  }).filter(Boolean);

  // Victory checks (must consider bench too for 2v3 / 2v4)
  if (countAliveDefenders(battle) <= 0){
    battle.status = 'won';
    battle.log.push('All defenders fainted.');
    return;
  }
  if (countAliveAttackers(battle) <= 0){
    battle.status = 'lost';
    battle.log.push('All attackers fainted.');
    return;
  }

  // Hard safety cap to avoid infinite loops when targeting/PP gets weird.
  battle.turnCount = (battle.turnCount || 0) + 1;
  const turnCap = Number(state.settings?.battleTurnCap) || 50;
  if (battle.turnCount > turnCap){
    battle.status = 'stalled';
    battle.log.push(`Turn limit reached (${turnCap}).`);
    return;
  }

  const actions = [];

  // Attacker actions
  // If only 1 enemy is alive, only one attacker needs to spend PP (the best one), unless the other is manual.
  const onlyOneEnemy = (activeDefSlots.length === 1);
  const attackerChoices = [];

  // In 2v2, avoid wasting the second attacker on the same already-targeted defender when another defender is alive.
  // We treat instance keys (base#N) as unique targets.
  const reservedTargets = new Set();

  // Coordinated STU (Sturdy) rule: if one defender has STU at full HP and the other does not,
  // try to use AoE (if available) to OHKO the non-STU and chip STU, then finish STU with the other attacker.
  // This keeps "simple ground logic" clean until full setup/cheese logic exists.
  const stuPlan = (!onlyOneEnemy && activeAtkIds.length >= 2 && activeDefSlots.length === 2)
    ? (pickSturdyAoePlan({data, calc, state, wp, waveKey, slots, slotByKey, battle, activeAtkIds: activeAtkIds.slice(0,2), activeDefSlots})
        || pickSturdyBasePlan({data, calc, state, wp, slotByKey, battle, activeAtkIds: activeAtkIds.slice(0,2), activeDefSlots}))
    : null;

  if (stuPlan && stuPlan.picks?.length){
    for (const pick of stuPlan.picks){
      const id = pick.attackerId;
      const r = byId(state.roster, id);
      if (!r) continue;
      const targetKey = (pick.targetKey && activeDefKeys.includes(pick.targetKey)) ? pick.targetKey : (activeDefKeys[0] || null);
      if (!targetKey) continue;
      const targetBaseRowKey = baseDefKey(targetKey);
      const pick0 = enforceChoiceLockOnPick({data, calc, state, wp, battle, attackerId: id, pick: {attackerId:id, targetRowKey: targetKey, targetBaseRowKey, move: pick.move}});
      const defSlot = slotByKey.get(targetBaseRowKey);
      if (!defSlot) continue;

      const rr = computeRangeForAttack({
        data, calc, state, wp,
      battle,
        attackerId: id,
        defSlot,
        moveName: pick0.move,
        defenderCurHpFrac: clampHpPct(battle.hpDef?.[targetKey] ?? 100) / 100,
      });
      if (!rr) continue;

      const actObj = {
        side:'atk',
        actorId:id,
        targetKey,
        targetBaseRowKey,
        move: pick0.move,
        prio: pick.prio ?? 9,
        minPct: Number(rr.minPct)||0,
        maxPct: Number(rr.maxPct ?? rr.minPct)||0,
        aoe: isAoeMove(pick0.move),
        hitsAlly: aoeHitsAlly(pick0.move),
        moveType: rr.moveType,
        category: rr.category,
        actorSpe: Number(rr.attackerSpe)||0,
        targetSpe: Number(rr.defenderSpe)||0,
        source: 'auto',
      };
      actions.push(actObj);
      battle.lastActions.atk[id] = {
        move: pick0.move,
        target: targetKey,
        prio: pick.prio ?? 9,
        minPct: Number(rr.minPct)||0,
        maxPct: Number(rr.maxPct ?? rr.minPct)||0,
        aoe: isAoeMove(pick0.move),
        hitsAlly: aoeHitsAlly(pick0.move),
        source: 'auto',
      };
    }
  }

  if (!actions.length){
  for (const id of activeAtkIds){
    const manual = battle.manual?.[id];
    let pick = null;
    if (manual && manual.move && manual.targetRowKey){
      // Respect manual unless move has no PP.
      // Manual targets may be base rowKeys; resolve to the currently-active instance key (base#N).
      let targetInst = null;
      if (activeDefKeys.includes(manual.targetRowKey)){
        targetInst = manual.targetRowKey;
      } else {
        const wantBase = baseDefKey(manual.targetRowKey);
        targetInst = activeDefKeys.find(k => baseDefKey(k) === wantBase) || null;
      }
      if (targetInst && hasPP(state, id, manual.move)){
        pick = {attackerId:id, targetRowKey:targetInst, targetBaseRowKey: baseDefKey(targetInst), move:manual.move, source:'manual'};
      }
    }
    if (!pick){
      const allyId = activeAtkIds.find(x => x !== id) || null;
      const auto = pickAutoActionForAttacker({data, calc, state, wp, waveKey, attackerId:id, activeDefSlots, allyId, battle});
      if (auto){
        pick = {...auto, source:'auto'};
      }
    }
    if (!pick) continue;

    // Enforce Choice lock (manual picks can't break it).
    pick = enforceChoiceLockOnPick({data, calc, state, wp, battle, attackerId: id, pick});

    // If this is an auto pick and we have multiple defenders alive, try to pick an untargeted defender.
    // This prevents the common case where both attackers choose defender #1 when the matchup is identical.
    if (pick.source === 'auto' && !onlyOneEnemy && activeDefSlots.length > 1){
      const instKey = pick.targetRowKey;
      if (instKey && reservedTargets.has(instKey)){
        const alt = pickAutoActionForAttacker({
          data, calc, state, wp, waveKey,
          attackerId: id,
          activeDefSlots,
          excludeInstKeys: [...reservedTargets],
          allyId: (activeAtkIds.find(x => x !== id) || null),
          battle,
        });
        if (alt){
          pick = {...alt, source:'auto'};
        }
      }
    }

    const targetKey = pick.targetRowKey; // instance key (base#N)
    const targetBaseRowKey = pick.targetBaseRowKey || baseDefKey(targetKey);
    const defSlot = slotByKey.get(targetBaseRowKey);
    if (!defSlot) continue;

    const rr = computeRangeForAttack({
      data, calc, state, wp,
      battle,
      attackerId: id,
      defSlot,
      moveName: pick.move,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[targetKey] ?? 100) / 100,
    });
    if (!rr) continue;

    const actObj = {
      side:'atk',
      actorId:id,
      targetKey,
      targetBaseRowKey,
      move: pick.move,
      prio: pick.prio ?? 9,
      minPct: Number(rr.minPct)||0,
      maxPct: Number(rr.maxPct ?? rr.minPct)||0,
      aoe: isAoeMove(pick.move),
      hitsAlly: aoeHitsAlly(pick.move),
      moveType: rr.moveType,
      category: rr.category,
      actorSpe: Number(rr.attackerSpe)||0,
      targetSpe: Number(rr.defenderSpe)||0,
      source: pick.source,
    };

    if (onlyOneEnemy && pick.source !== 'manual'){
      attackerChoices.push(actObj);
    } else {
      actions.push(actObj);
    }

    if (!onlyOneEnemy && actObj.targetKey){
      reservedTargets.add(actObj.targetKey);
    }

    battle.lastActions.atk[id] = {move: pick.move, target: pick.targetRowKey, prio: pick.prio ?? 9, minPct: Number(rr.minPct)||0,
      maxPct: Number(rr.maxPct ?? rr.minPct)||0,
      aoe: isAoeMove(pick.move),
      hitsAlly: aoeHitsAlly(pick.move), source: pick.source};
  }

  }

  if (onlyOneEnemy && attackerChoices.length){
    // Choose best action among attackers: OHKO, then lower prio, then closer-to-100 for OHKO.
    attackerChoices.sort((a,b)=>{
      const ao = ((a.minPct||0) >= (battle.hpDef[a.targetKey] ?? 100)) ? 1 : 0;
      const bo = ((b.minPct||0) >= (battle.hpDef[b.targetKey] ?? 100)) ? 1 : 0;
      if (ao !== bo) return bo-ao;
      if ((a.prio??9) !== (b.prio??9)) return (a.prio??9) - (b.prio??9);
      if (ao && bo){
        const ak = Math.abs((a.minPct||0)-100);
        const bk = Math.abs((b.minPct||0)-100);
        if (ak !== bk) return ak-bk;
      }
      return (b.minPct||0) - (a.minPct||0);
    });
    actions.push(attackerChoices[0]);
  }

  // Defender actions (enemy hits you): choose best target across active attackers.
  for (const rk of activeDefKeys){
    const defSlot = slotByKey.get(baseDefKey(rk));
    if (!defSlot) continue;

    const enemyPick = pickEnemyAction({data, state, wp, attackerIds: activeAtkIds, defSlot, battle});
    if (!enemyPick) continue;

    // We don't compute full damage range here again; threat model already computed minPct.
    actions.push({
      side:'def',
      actorKey: rk,
      targetId: enemyPick.targetId,
      move: enemyPick.move,
      minPct: enemyPick.minPct,
      maxPct: enemyPick.maxPct,
      moveType: enemyPick.moveType,
      category: enemyPick.category,
      actorSpe: enemyPick.enemySpe,
      targetSpe: enemyPick.targetSpe,
      aoe: !!enemyPick.aoe,
      chosenReason: enemyPick.chosenReason,
      ohkoChance: enemyPick.ohkoChance,
    });
  }

  // Sort actions by speed desc. On tie between atk/def, enemy may act first.
  const enemyFirstOnTie = !!state.settings?.enemySpeedTieActsFirst;
  actions.sort((a,b)=>{
    const as = Number(a.actorSpe)||0;
    const bs = Number(b.actorSpe)||0;
    if (as !== bs) return bs - as;
    if (a.side !== b.side){
      if (enemyFirstOnTie) return (a.side === 'def') ? -1 : 1;
    }
    return 0;
  });

  // Execute actions
  const turnLog = [];
  for (const act of actions){
    // End turn immediately if the battle is already decided.
    if (countAliveDefenders(battle) <= 0){
      battle.status = 'won';
      turnLog.push('Wave won.');
      break;
    }
    if (countAliveAttackers(battle) <= 0){
      battle.status = 'lost';
      turnLog.push('Wave lost.');
      break;
    }

    if (act.side === 'atk'){

const id = act.actorId;
let rk = act.targetKey;
if (!id || !rk) continue;
if ((battle.hpAtk[id] ?? 0) <= 0) continue; // fainted before acting

const atkMon = byId(state.roster, id);
const atkName = displayMonName(atkMon, 'Attacker') || 'Attacker';
const itemBefore = effectiveAttackerItem({state, wp, battle, attackerId: id});

// Truant: alternate between acting and loafing (no PP spend on loaf turns).
const atkAbLc0 = String(atkMon?.ability || '').trim().toLowerCase();
if (atkAbLc0 === 'truant'){
  battle.truantState = battle.truantState || {};
  const kTr = `atk:${id}`;
  const loaf = !!battle.truantState[kTr];
  if (loaf){
    battle.truantState[kTr] = false;
    turnLog.push(`${atkName} loafs around.`);
    continue;
  }
  battle.truantState[kTr] = true;
}

// AoE (spread) attacker moves: hit both defenders, and sometimes the ally.
if (act.aoe){
  const defKeys = (battle.def.active||[]).filter(Boolean).filter(k => (battle.hpDef[k] ?? 0) > 0);
  const hit = [];
  let execMoveType = act.moveType || null;

  // Potential ally hit (Earthquake/Surf/Discharge/etc)
  const allyId = (battle.atk.active||[]).filter(Boolean).find(x => x !== id) || null;
  let allyInfo = null;

  // Compute per-target damages (min/max), then apply spread multiplier if 2+ targets are actually damaged.
  for (const dk of defKeys){
    const baseKey = baseDefKey(dk);
    const defSlot = slotByKey.get(baseKey);
    if (!defSlot) continue;
    const rr = computeRangeForAttack({
      data, calc, state, wp,
      battle,
      attackerId: id,
      defSlot,
      moveName: act.move,
      defenderCurHpFrac: clampHpPct(battle.hpDef?.[dk] ?? 100) / 100,
    });
    if (!rr) continue;
    if (!execMoveType && rr.moveType) execMoveType = rr.moveType;
    hit.push({
      kind:'def',
      key: dk,
      name: defSlot.defender || baseKey,
      min: clampDmgPct(Number(rr.minPct)||0),
      max: clampDmgPct(Number(rr.maxPct ?? rr.minPct)||0),
    });
  }

  if (act.hitsAlly && allyId){
    const allyMon = byId(state.roster, allyId);
    const allyHp = Number(battle.hpAtk?.[allyId] ?? 0);
    if (allyMon && allyHp > 0){
      const defenderItem = effectiveAttackerItem({state, wp, battle, attackerId: allyId});
      let rrA = null;
      try{
        rrA = calc.computeDamageRange({
          data,
          attacker: attackerObj(state, atkMon),
          defender: rosterDefObj(state, allyMon),
          moveName: act.move,
          settings: {...applyBattleStageDeltaToSettings(settingsForWave(state, wp, id, null), battle, id), defenderItem, defenderCanEvolve: canEvolveForSpecies(state, (allyMon.effectiveSpecies || allyMon.baseSpecies)), weather: (battle?.weather || null)},
          tags: [],
        });
      }catch(e){ rrA = null; }
      if (rrA && rrA.ok){
        const moveType = rrA.moveType;
        const allyMonEff = {...allyMon, item: defenderItem};
        const immune = immuneFromAllyAbilityItem(allyMonEff, moveType);
        const minA = immune ? 0 : clampDmgPct(Number(rrA.minPct)||0);
        const maxA = immune ? 0 : clampDmgPct(Number(rrA.maxPct ?? rrA.minPct)||0);
        allyInfo = {
          kind:'ally',
          id: allyId,
          name: displayMonName(allyMon, String(allyId)) || String(allyId),
          min: minA,
          max: maxA,
          immune,
          moveType,
        };
      }
    }
  }

  // If there are no targets at execution time, this action does not execute.
  if (!hit.length && !(allyInfo && (allyInfo.min||0) > 0)) continue;

  const targetsDamaged = hit.filter(h => (h.min||0) > 0).length + (allyInfo && (allyInfo.min||0) > 0 ? 1 : 0);
  const mult = spreadMult(targetsDamaged);

  // Spend PP once (execution-time only)
  const ppBefore = getPP(state, id, act.move);
  decPP(state, id, act.move);
  const ppAfter = getPP(state, id, act.move);

  // Audit: PP double-spend / ghost action detection (dev-facing only).
  try{
    const audit = ensureAudit(battle);
    const k = `${battle.turnCount}|atk|${id}|${act.move}|AOE`;
    if (audit.execKeys[k]){
      battle.warnings = battle.warnings || [];
      battle.warnings.push('Audit: duplicate attacker action key (possible double-spend).');
      console.error('Audit dup action', k);
    }
    audit.execKeys[k] = true;
    audit.ppEvents.push({turn: battle.turnCount, side:'atk', actorId:id, move:act.move, before:ppBefore.cur, after:ppAfter.cur});
  }catch(e){ /* ignore */ }

  // Apply damage to defenders
  const parts = [];
  const faintedDefs = [];
  let totalDmgToOpp = 0;
  for (const h of hit){
    const dmg = clampDmgPct((h.min||0) * mult);
    totalDmgToOpp += dmg;
    battle.hpDef[h.key] = clampHpPct((battle.hpDef[h.key] ?? 0) - dmg);
    parts.push(`${h.name} (${dmg.toFixed(1)}%)`);
    battle.history.push({side:'atk', actorId:id, move: act.move, prio: act.prio ?? 9, targetKey: h.key, aoe:true});
    if ((battle.hpDef[h.key] ?? 0) <= 0){
      const idx = battle.def.active.indexOf(h.key);
      if (idx !== -1) battle.def.active[idx] = null;
      faintedDefs.push(h.name);
    }
  }

  turnLog.push(`${atkName} used ${act.move} (P${act.prio ?? '?'}) (AOE×${mult === 1 ? '1.00' : '0.75'}) → ${parts.join(', ')} · PP ${ppBefore.cur}→${ppAfter.cur}/${ppAfter.max}.`);
  for (const name of faintedDefs) turnLog.push(`${name} fainted.`);

  // Auto-fill any reinforcement slots immediately (2v3 / 2v4 correctness).
  if (faintedDefs.length) autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog});

  // Choice items: lock the attacker into the first used move.
  maybeSetChoiceLock({battle, state, wp, attackerId:id, item:itemBefore, moveName: act.move, turnLog, attackerLabel: atkName});

  // Consumables / healing (post-damage)
  const moveTypeExec = execMoveType || act.moveType || null;
  act.moveType = moveTypeExec;
  maybeConsumeGem({battle, attackerId:id, item:itemBefore, moveName: act.move, moveType: moveTypeExec, didDamagePct: totalDmgToOpp, turnLog, attackerLabel: atkName});
  maybeHealShellBell({battle, attackerId:id, item:itemBefore, totalDamagePct: totalDmgToOpp, turnLog, attackerLabel: atkName});

  // Ally immunity→boost (Lightning Rod, Motor Drive, Storm Drain, Sap Sipper) should trigger even when partner takes 0 damage.
  if (allyInfo && allyInfo.immune){
    applyOnHitImmunityBoost({battle, state, targetId: allyInfo.id, moveType: allyInfo.moveType, turnLog});
  }

  // Apply damage to ally if applicable
  if (allyInfo && (allyInfo.min||0) > 0){
    const allyDmg = clampDmgPct((allyInfo.min||0) * mult);
    const allyHp = Number(battle.hpAtk?.[allyInfo.id] ?? 0);
    let nextHp = clampHpPct(allyHp - allyDmg);
    nextHp = maybeTriggerFocusSash({battle, state, wp, targetId: allyInfo.id, prevHp: allyHp, nextHp, turnLog, targetLabel: allyInfo.name});
    battle.hpAtk[allyInfo.id] = nextHp;

    // Air Balloon: pop on successful damaging hit.
    maybePopAirBalloon({battle, state, wp, targetId: allyInfo.id, turnLog, targetLabel: allyInfo.name});

    const riskKO = (clampDmgPct((allyInfo.max||0) * mult) >= allyHp);
    turnLog.push(`⚠ ${atkName}'s ${act.move} hit partner ${allyInfo.name} (${allyDmg.toFixed(1)}%)${riskKO ? ' — RISK: could KO partner' : ''}.`);

    if (nextHp <= 0){
      const idx = battle.atk.active.indexOf(allyInfo.id);
      if (idx !== -1) battle.atk.active[idx] = null;
      turnLog.push(`${allyInfo.name} fainted.`);

      // Auto-fill attacker reinforcement immediately.
      autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog});
    }
  }

  // If friendly-fire would KO and the user has not allowed it, mark the battle with a warning.
  if (allyInfo && (allyInfo.min||0) > 0){
    const allyHp = Number(battle.hpAtk?.[allyInfo.id] ?? 0) + clampDmgPct((allyInfo.min||0) * mult); // previous
    const riskKO = (clampDmgPct((allyInfo.max||0) * mult) >= allyHp);
    if (riskKO && !state.settings?.allowFriendlyFire){
      battle.warnings = battle.warnings || [];
      battle.warnings.push('Friendly fire risk (could KO partner). Enable "Allow friendly fire" to permit.');
    }
  }

  // Metronome: track consecutive move usage for damage scaling (AoE should behave like single-target).
  metronomeRecordUse(battle, id, act.move, itemBefore);

  // Life Orb recoil (AoE should recoil once per move if it dealt damage to opponents).
  maybeApplyLifeOrbRecoil({battle, attackerId:id, item:itemBefore, didDamagePct: totalDmgToOpp, turnLog, attackerLabel: atkName});

  // If recoil KO'd the attacker, handle faint + reinforcement.
  if ((battle.hpAtk[id] ?? 0) <= 0){
    const idx2 = battle.atk.active.indexOf(id);
    if (idx2 !== -1) battle.atk.active[idx2] = null;
    turnLog.push(`${atkName} fainted (recoil).`);
    autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog});
  }

  continue;
}

// Single-target attacker move
// If the chosen target fainted earlier in the same turn, redirect to a remaining alive defender.
if ((battle.hpDef[rk] ?? 0) <= 0){
  const altKey = (battle.def.active||[]).filter(Boolean).find(k => (battle.hpDef[k] ?? 0) > 0);
  if (!altKey) continue;
  rk = altKey;
  act.targetKey = rk;
  act.targetBaseRowKey = baseDefKey(rk);
}

// Recompute damage at execution time (mid-turn state can change due to joins/INT/weather).
{
  const baseKey = baseDefKey(rk);
  const defSlot = slotByKey.get(baseKey);
  if (!defSlot) continue;
  const rrExec = computeRangeForAttack({
    data, calc, state, wp,
    battle,
    attackerId: id,
    defSlot,
    moveName: act.move,
    defenderCurHpFrac: clampHpPct(battle.hpDef?.[rk] ?? 100) / 100,
  });
  if (!rrExec) continue;
  act.minPct = Number(rrExec.minPct)||0;
  act.maxPct = Number(rrExec.maxPct ?? rrExec.minPct)||0;
  act.moveType = rrExec.moveType;
  act.category = rrExec.category;
}

const dmg = clampDmgPct(act.minPct);
battle.hpDef[rk] = clampHpPct((battle.hpDef[rk] ?? 0) - dmg);
const ppBefore = getPP(state, id, act.move);
decPP(state, id, act.move);
const ppAfter = getPP(state, id, act.move);

// Audit (dev-facing)
try{
  const audit = ensureAudit(battle);
  const k = `${battle.turnCount}|atk|${id}|${act.move}|${rk}`;
  if (audit.execKeys[k]){
    battle.warnings = battle.warnings || [];
    battle.warnings.push('Audit: duplicate attacker action key (possible double-spend).');
    console.error('Audit dup action', k);
  }
  audit.execKeys[k] = true;
  audit.ppEvents.push({turn: battle.turnCount, side:'atk', actorId:id, move:act.move, before:ppBefore.cur, after:ppAfter.cur});
}catch(e){ /* ignore */ }
const defName = slotByKey.get(baseDefKey(rk))?.defender || rk;
turnLog.push(`${atkName} used ${act.move} (P${act.prio ?? '?'}) → ${defName} (${dmg.toFixed(1)}% · PP ${ppBefore.cur}→${ppAfter.cur}/${ppAfter.max}).`);
battle.history.push({side:'atk', actorId:id, move: act.move, prio: act.prio ?? 9, targetKey: rk});

// Choice items: lock the attacker into the first used move.
maybeSetChoiceLock({battle, state, wp, attackerId:id, item:itemBefore, moveName: act.move, turnLog, attackerLabel: atkName});

// Consumables / healing (post-damage)
maybeConsumeGem({battle, attackerId:id, item:itemBefore, moveName: act.move, moveType: act.moveType, didDamagePct: dmg, turnLog, attackerLabel: atkName});
maybeHealShellBell({battle, attackerId:id, item:itemBefore, totalDamagePct: dmg, turnLog, attackerLabel: atkName});

// Metronome: track consecutive move usage for damage scaling.
metronomeRecordUse(battle, id, act.move, itemBefore);

// Life Orb recoil (post-damage, after Shell Bell).
maybeApplyLifeOrbRecoil({battle, attackerId:id, item:itemBefore, didDamagePct: dmg, turnLog, attackerLabel: atkName});

// If recoil KO'd the attacker, handle faint + reinforcement.
if ((battle.hpAtk[id] ?? 0) <= 0){
  const idx2 = battle.atk.active.indexOf(id);
  if (idx2 !== -1) battle.atk.active[idx2] = null;
  turnLog.push(`${atkName} fainted (recoil).`);
  autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog});
}


if ((battle.hpDef[rk] ?? 0) <= 0){
  const idx = battle.def.active.indexOf(rk);
  if (idx !== -1) battle.def.active[idx] = null;
  turnLog.push(`${defName} fainted.`);

  // Auto-fill defender reinforcement immediately.
  autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog});
}
    } else {

const rk = act.actorKey;
let id = act.targetId;
if (!rk || !id) continue;
if ((battle.hpDef[rk] ?? 0) <= 0) continue;

const defSlot = slotByKey.get(baseDefKey(rk));
const defName = defSlot?.defender || rk;

// Truant (enemy): alternate between acting and loafing.
const enemyAbLc0 = defenderAbilityLcFromData(data, defSlot?.defender);
if (enemyAbLc0 === 'truant'){
  battle.truantState = battle.truantState || {};
  const kTr = `def:${rk}`;
  const loaf = !!battle.truantState[kTr];
  if (loaf){
    battle.truantState[kTr] = false;
    turnLog.push(`${defName} loafs around.`);
    continue;
  }
  battle.truantState[kTr] = true;
}

// Enemy AoE: recompute damage per target (typing differs) + apply 0.75× spread when >1 target is damaged.
// For single-target, if the chosen target fainted earlier in the same turn, redirect to a remaining alive attacker.
if (!act.aoe && (battle.hpAtk[id] ?? 0) <= 0){
  const alt = (battle.atk.active||[]).filter(Boolean).find(t => (battle.hpAtk[t] ?? 0) > 0) || null;
  if (!alt) continue;
  id = alt;
}
const targetIds = act.aoe ? (battle.atk.active||[]).filter(Boolean).filter(t => (battle.hpAtk[t] ?? 0) > 0) : [id];
const hits = [];
for (const tid of targetIds){
  const tmon = byId(state.roster, tid);
  if (!tmon) continue;
  if ((battle.hpAtk[tid] ?? 0) <= 0) continue;

  // Include the target's held item in incoming damage (defensive items + speed items matter).
  const defenderItem = effectiveAttackerItem({state, wp, battle, attackerId: tid});
  const tmonEff = {...tmon, item: defenderItem};

  let rr = null;
  try{
    rr = calc.computeDamageRange({
      data,
      attacker: defenderObj(state, defSlot),
      defender: rosterDefObj(state, tmon),
      moveName: act.move,
      settings: {...settingsForWave(state, wp, null, defSlot.rowKey, defSlot.defender), defenderItem, defenderCanEvolve: canEvolveForSpecies(state, (tmonEff.effectiveSpecies || tmonEff.baseSpecies || tmonEff.species)), defenderAbility: (tmonEff.ability || null), attackerAbility: (data?.claimedSets?.[defSlot.defender]?.ability || null), weather: (battle?.weather || null)},
      tags: defSlot.tags || [],
    });
  }catch(e){ rr = null; }
  if (!rr || !rr.ok){
    // fallback to stored minPct if range missing
    const moveType = String(act.moveType || '');
    const immune = immuneFromAllyAbilityItem(tmonEff, moveType);
    const min0 = clampDmgPct(act.minPct||0);
    const max0 = clampDmgPct(act.maxPct||act.minPct||0);
    hits.push({tid, name: displayMonName(tmon, String(tid)) || String(tid), moveType, immune, min: immune ? 0 : min0, max: immune ? 0 : max0});
  } else {
    const moveType = String(rr.moveType || '');
    const immune = immuneFromAllyAbilityItem(tmonEff, moveType);
    const min0 = clampDmgPct(Number(rr.minPct)||0);
    const max0 = clampDmgPct(Number(rr.maxPct ?? rr.minPct)||0);
    hits.push({tid, name: displayMonName(tmon, String(tid)) || String(tid), moveType, immune, min: immune ? 0 : min0, max: immune ? 0 : max0});
  }
}

const targetsDamaged = hits.filter(h => (h.min||0) > 0).length;
const mult = spreadMult(targetsDamaged);

for (const h of hits){
  const dmg = clampDmgPct((h.min||0) * mult);
  if (dmg <= 0){
    if (h.immune){
      turnLog.push(`${defName} used ${act.move}${act.aoe ? ` (AOE×${mult === 1 ? '1.00' : '0.75'})` : ''} → ${h.name} (immune).`);
      battle.history.push({side:'def', actorKey: rk, move: act.move, aoe: !!act.aoe, targetId: h.tid});
      applyOnHitImmunityBoost({battle, state, targetId: h.tid, moveType: h.moveType, turnLog});
      const lastTarget = act.aoe ? 'BOTH' : h.tid;
      battle.lastActions.def[rk] = {move: act.move, target: lastTarget, minPct: h.min, maxPct: h.max, chosenReason: act.chosenReason};
    }
    continue;
  }
  const hpBefore = clampHpPct(battle.hpAtk[h.tid] ?? 0);
  let hpAfter = clampHpPct(hpBefore - dmg);
  hpAfter = maybeTriggerFocusSash({battle, state, wp, targetId: h.tid, prevHp: hpBefore, nextHp: hpAfter, turnLog, targetLabel: h.name});
  battle.hpAtk[h.tid] = hpAfter;
  turnLog.push(`${defName} used ${act.move}${act.aoe ? ` (AOE×${mult === 1 ? '1.00' : '0.75'})` : ''} → ${h.name} (${dmg.toFixed(1)}%).`);
  battle.history.push({side:'def', actorKey: rk, move: act.move, aoe: !!act.aoe, targetId: h.tid});

  // Air Balloon: pop on successful damaging hit.
  maybePopAirBalloon({battle, state, wp, targetId: h.tid, turnLog, targetLabel: h.name});

  // Record last EXECUTED enemy action (prevents showing phantom actions when the defender fainted before acting).
  const lastTarget = act.aoe ? 'BOTH' : h.tid;
  battle.lastActions.def[rk] = {move: act.move, target: lastTarget, minPct: h.min, maxPct: h.max, chosenReason: act.chosenReason};

  if ((battle.hpAtk[h.tid] ?? 0) <= 0){
    const idx = battle.atk.active.indexOf(h.tid);
    if (idx !== -1) battle.atk.active[idx] = null;
    turnLog.push(`${h.name} fainted.`);

    // Auto-fill attacker reinforcement immediately.
    autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog});
  }
}
    }
  }


  // End-of-turn weather chip (Sand / Hail). Modeled as 1/16 max HP in HP% space.
  // Immunities (Gen 5):
  // - Sand: Rock / Ground / Steel
  // - Hail: Ice
  if (battle.status === 'active'){
    const wChip = battle.weather || null;
    const chip = weatherChipPct(wChip);
    if (chip > 0){
      const chipLines = [];

      // Defenders
      const defKeysNow = (battle.def.active||[]).filter(Boolean).filter(k => (battle.hpDef[k] ?? 0) > 0);
      for (const dk of defKeysNow){
        const defSlot = slotByKey.get(baseDefKey(dk));
        const sp = defSlot?.defender || null;
        if (sp && immuneToWeatherChip(data, wChip, sp)) continue;
        const before = clampHpPct(battle.hpDef?.[dk] ?? 0);
        const dmg = Math.min(before, chip);
        if (dmg <= 0) continue;
        const after = clampHpPct(before - dmg);
        battle.hpDef[dk] = after;
        chipLines.push(`${sp || dk} -${dmg.toFixed(1)}%`);
        if (after <= 0){
          const idx = battle.def.active.indexOf(dk);
          if (idx !== -1) battle.def.active[idx] = null;
          turnLog.push(`${sp || dk} fainted.`);
        }
      }

      // Attackers
      const atkIdsNow = (battle.atk.active||[]).filter(Boolean).filter(id => (battle.hpAtk[id] ?? 0) > 0);
      for (const id of atkIdsNow){
        const rm = byId(state.roster||[], id);
        const sp = rm?.effectiveSpecies || rm?.baseSpecies || null;
        if (sp && immuneToWeatherChip(data, wChip, sp)) continue;
        const before = clampHpPct(battle.hpAtk?.[id] ?? 0);
        const dmg = Math.min(before, chip);
        if (dmg <= 0) continue;
        const after = clampHpPct(before - dmg);
        battle.hpAtk[id] = after;
        chipLines.push(`${sp || id} -${dmg.toFixed(1)}%`);
        if (after <= 0){
          const idx = battle.atk.active.indexOf(id);
          if (idx !== -1) battle.atk.active[idx] = null;
          turnLog.push(`${sp || id} fainted.`);
        }
      }

      if (chipLines.length){
        const label = (wChip === 'sand') ? 'Sandstorm' : 'Hail';
        turnLog.push(`${label} chip: ${chipLines.join(' · ')}.`);
        // Auto-fill any reinforcements that fainted to chip.
        autoFillEmptySlots({battle, state, data, slotByKey, waveKey, turnLog});
      }
    }
  }


  // End-of-turn Leftovers heal (6.25% in HP% space).
  if (battle.status === 'active'){
    const heal = 100/16;
    const heals = [];
    const atkIdsNow = (battle.atk.active||[]).filter(Boolean).filter(id => (battle.hpAtk[id] ?? 0) > 0);
    for (const id of atkIdsNow){
      const item = effectiveAttackerItem({state, wp, battle, attackerId: id});
      if (String(item||'') !== 'Leftovers') continue;
      const before = clampHpPct(battle.hpAtk?.[id] ?? 0);
      const after = clampHpPct(before + heal);
      if (after <= before) continue;
      battle.hpAtk[id] = after;
      const rm = byId(state.roster||[], id);
      heals.push(`${displayMonName(rm, id)} +${(after-before).toFixed(1)}%`);
    }
    if (heals.length){
      turnLog.push(`Leftovers: ${heals.join(' · ')}.`);
    }
  }

  // Append logs (keep last ~80 lines)
  battle.log.push(...turnLog);
  if (battle.log.length > 80) battle.log = battle.log.slice(-80);

  // If the battle ended during execution, stop here (prevents phantom follow-up logs/actions).
  if (battle.status !== 'active') return;

  // Win/loss checks
  const aliveDef = (battle.def.active||[]).filter(Boolean).filter(k => (battle.hpDef[k] ?? 0) > 0).length + (battle.def.bench||[]).filter(k => (battle.hpDef[k] ?? 100) > 0).length;
  const aliveAtk = (battle.atk.active||[]).filter(Boolean).filter(id => (battle.hpAtk[id] ?? 0) > 0).length + (battle.atk.bench||[]).filter(id => (battle.hpAtk[id] ?? 100) > 0).length;

  if (aliveDef <= 0){
    battle.status = 'won';
    battle.log.push('Wave won.');
    return;
  }
  if (aliveAtk <= 0){
    battle.status = 'lost';
    battle.log.push('Wave lost.');
    return;
  }

  // No pending reinforcement selection in the alpha v1 battle engine:
  // reinforcements enter deterministically in join order (2v3 / 2v4 correctness).
}

export function battleLabelForRowKey({rowKey, waveKey, defender, level}){
  // UI label for defender instance keys.
  // Only append an instance number when the rowKey actually includes one (base#N).
  const parts = String(rowKey || '').split('#');
  if (parts.length <= 1){
    return `${defender} · Lv ${level}`;
  }
  const n = Number(parts[1] || 1);
  const inst = Number.isFinite(n) ? n : 1;
  return `${defender} · Lv ${level} · #${inst}`;
}
