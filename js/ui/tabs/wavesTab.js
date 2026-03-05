// js/ui/tabs/wavesTab.js
// alpha v1
// Waves tab UI extracted from js/app/app.js.
// This file is intentionally small: it wires up tab-level concerns (prefetch + overview)
// and delegates wave-card rendering to js/ui/tabs/waves/waveCard.js.

import { el } from '../dom.js';
import { fixName } from '../../data/nameFixes.js';
import { speciesListFromSlots } from '../../domain/waves.js';
import { ensurePPForRosterMon, setPP } from '../../domain/battle.js';
import { createWaveCardRenderer } from './waves/waveCard.js';
import { groupBy } from './waves/wavesUtil.js';

function clampInt(v, lo, hi){
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function findRosterIdByEffectiveSpecies(st, species){
  const roster = Array.isArray(st?.roster) ? st.roster : [];
  const want = String(species||'');
  for (const e of roster){
    if (!e) continue;
    const got = String(e.effectiveSpecies || e.baseSpecies || '');
    if (got === want) return e.id || null;
  }
  return null;
}

function rosterMonById(st, rid){
  const roster = Array.isArray(st?.roster) ? st.roster : [];
  return roster.find(x => x && String(x.id||'') === String(rid||'')) || null;
}

function normalizePartyIds(st, party){
  // Older checkpoint builds used array indices as IDs. Convert them to rosterMon.id when possible.
  const roster = Array.isArray(st?.roster) ? st.roster : [];
  const keys = ['aId','bId','cId','dId'];
  for (const k of keys){
    const cur = party?.[k];
    if (!cur) continue;
    if (rosterMonById(st, cur)) continue;
    const idx = Number.parseInt(String(cur), 10);
    const m = Number.isFinite(idx) ? roster[idx] : null;
    if (m && m.id) party[k] = m.id;
  }
}

function ensureNianCheckpointState(st){
  st.ui = st.ui || {};
  st.ui.nianBoss = st.ui.nianBoss || {};
  // Individual checkpoints live under dynamic keys: cp1..cp7
  st.ui.nianBoss.lastDebit = st.ui.nianBoss.lastDebit || {};
  st.checkpoints = st.checkpoints || {};
  st.checkpoints.nianBoss = st.checkpoints.nianBoss || {};
}

function ensureBonusPolitoedState(st){
  st.ui = st.ui || {};
  st.ui.bonusPolitoed = st.ui.bonusPolitoed || {};
  if (!('expanded' in st.ui.bonusPolitoed)) st.ui.bonusPolitoed.expanded = false;
  st.checkpoints = st.checkpoints || {};
  st.checkpoints.bonusPolitoed = st.checkpoints.bonusPolitoed || {};
}

function rosterHasSpecies(st, species){
  const roster = Array.isArray(st?.roster) ? st.roster : [];
  const want = String(species||'');
  for (const e of roster){
    if (!e) continue;
    const got = String(e.effectiveSpecies || e.baseSpecies || '');
    if (got === want) return true;
  }
  return false;
}

function renderBonusPolitoedPanel(ctx, state){
  const { store } = ctx;
  const gold = Math.max(0, Math.floor(Number(state?.shop?.gold||0)));
  const unlocked = !!state?.unlocked?.Politoed;
  const rec = state?.checkpoints?.bonusPolitoed?.logged || null;
  const isLogged = !!rec;
  const canBuy = (!unlocked) && gold >= 10;
  const canUndo = !!rec && rec.undone !== true && !rosterHasSpecies(state, 'Politoed');

  const btnBuy = el('button', {class:'btn-mini btn-strong', disabled: !canBuy}, 'Pay 10g & unlock Politoed');
  btnBuy.addEventListener('click', (ev)=>{
    ev.preventDefault();
    if (!canBuy) return;
    store.update(st=>{
      ensureBonusPolitoedState(st);
      st.shop = st.shop || {gold:0, ledger:[]};
      const g = Math.max(0, Math.floor(Number(st.shop.gold||0)));
      if (g < 10) return;
      const wasUnlocked = !!st.unlocked?.Politoed;
      if (wasUnlocked) return;
      st.shop.gold = g - 10;
      st.unlocked = st.unlocked || {};
      st.unlocked.Politoed = true;
      st.checkpoints.bonusPolitoed.logged = {
        ts: Date.now(),
        cost: 10,
        unlockAdded: !wasUnlocked,
        undone: false,
      };
    });
  });

  const btnUndo = el('button', {class:'btn-mini btn-undo', disabled: !canUndo}, 'Undo');
  btnUndo.addEventListener('click', (ev)=>{
    ev.preventDefault();
    if (!canUndo) return;
    store.update(st=>{
      ensureBonusPolitoedState(st);
      const r = st?.checkpoints?.bonusPolitoed?.logged;
      if (!r || r.undone === true) return;
      // Refuse undo once Politoed is already in roster (prevents confusing unlock state).
      if (rosterHasSpecies(st, 'Politoed')) return;

      st.shop = st.shop || {gold:0, ledger:[]};
      st.shop.gold = Math.max(0, Math.floor(Number(st.shop.gold||0) + Number(r.cost||0)));
      if (r.unlockAdded){
        if (st.unlocked && st.unlocked.Politoed) delete st.unlocked.Politoed;
      }
      r.undone = true;
      delete st.checkpoints.bonusPolitoed.logged;
    });
  });

  const header = el('div', {class:'checkpoint-head'}, [
    el('div', {}, [
      el('div', {class:'checkpoint-title'}, 'Bonus boss (optional) — Politoed'),
      el('div', {class:'checkpoint-sub'}, 'No sim yet — this is a paid unlock + log marker.'),
    ]),
    el('div', {class:'boss-actions'}, [
      (isLogged ? el('div', {class:'pill good'}, 'LOGGED') : null),
      (unlocked ? el('div', {class:'pill good'}, 'Unlocked') : el('div', {class:'pill warn'}, `Cost: 10g (you have ${gold})`)),
    ].filter(Boolean)),
  ]);

  const note = el('div', {class:'checkpoint-sub'},
    'Use this after you beat the optional Politoed bonus boss in-game. Clicking "Pay 10g" unlocks Politoed in roster.'
  );

  const actions = el('div', {class:'checkpoint-actions'}, [
    btnBuy,
    btnUndo,
    (!canUndo && rosterHasSpecies(state, 'Politoed'))
      ? el('div', {class:'pill info'}, 'Undo disabled while Politoed is in roster')
      : null,
  ].filter(Boolean));

  return el('div', {class:'checkpoint-card' + (isLogged ? ' logged' : '')}, [header, note, actions]);
}

function defaultCheckpointConfig(st, idx){
  const base = {
    expanded: false,
    advanced: false,
    party: {
      aId: findRosterIdByEffectiveSpecies(st, 'Cobalion'),
      bId: findRosterIdByEffectiveSpecies(st, 'Medicham'),
      cId: findRosterIdByEffectiveSpecies(st, 'Empoleon'),
      dId: findRosterIdByEffectiveSpecies(st, 'Serperior'),
    },
    // Standard "clean" script: 4 turns.
    turns: [
      { a: 'Provoke',      b: 'Drain Punch', c: 'Protective Aura', d: 'Gastro Acid' },
      { a: 'Sacred Sword', b: 'Drain Punch', c: 'Scald',           d: 'Leaf Storm' },
      { a: 'Sacred Sword', b: 'Drain Punch', c: 'Scald',           d: 'Leaf Storm' },
      // Assumption for a clean run: Empoleon uses Scald twice and Flash Cannon once.
      { a: 'Sacred Sword', b: 'Drain Punch', c: 'Flash Cannon',    d: 'Dragon Pulse' },
    ],
  };
  // Checkpoint 2 uses the same default unless user customizes.
  return base;
}

function mergeCheckpoint(st, idx){
  const def = defaultCheckpointConfig(st, idx);
  const src = (st?.ui?.nianBoss?.['cp'+String(idx)]) || {};

  let turns;
  if (Array.isArray(src.turns) && src.turns.length){
    turns = src.turns.map((t,i)=>({ ...(def.turns[i]||{}), ...(t||{}) }));
  } else {
    turns = def.turns.slice();
  }
  // Ensure at least 4 turns.
  while (turns.length < 4) turns.push({});

  return {
    ...def,
    ...src,
    advanced: !!src.advanced,
    party: (function(){
      const p = { ...def.party, ...(src.party||{}) };
      normalizePartyIds(st, p);
      return p;
    })(),
    turns,
  };
}

function rosterOptions(st){
  const roster = Array.isArray(st?.roster) ? st.roster : [];
  const out = [];
  for (const e of roster){
    if (!e || !e.id) continue;
    const name = String(e?.effectiveSpecies || e?.baseSpecies || e.id);
    out.push({id: e.id, name});
  }
  out.sort((a,b)=>a.name.localeCompare(b.name));
  return out;
}

function moveOptionsForRosterId(st, id){
  const e = rosterMonById(st, id);
  const pool = Array.isArray(e?.movePool) ? e.movePool : [];
  const names = pool.map(m=>String(m?.name||'')).filter(Boolean);
  const uniq = Array.from(new Set(names));
  uniq.sort((a,b)=>a.localeCompare(b));
  return uniq;
}

function syncMovePoolPPFromCanonical(st, rosterId, moveName){
  const e = rosterMonById(st, rosterId);
  if (!e || !Array.isArray(e.movePool)) return;
  const mv = e.movePool.find(m=>m && String(m.name||'') === String(moveName));
  if (!mv) return;
  const cur = st?.pp?.[rosterId]?.[moveName]?.cur;
  if (Number.isFinite(Number(cur))) mv.pp = Number(cur);
}

function deductMovePP(st, rosterId, moveName, nTimes){
  // Canonical PP source of truth is state.pp (see js/domain/battle.js).
  // We also mirror into movePool.pp for UI consistency.
  if (!rosterId || !moveName || !nTimes) return 0;
  const e = rosterMonById(st, rosterId);
  if (!e) return 0;
  ensurePPForRosterMon(st, e);

  const p = st?.pp?.[rosterId]?.[moveName];
  const before = clampInt(p?.cur ?? 12, 0, clampInt(p?.max ?? 12, 1, 999));
  const after = Math.max(0, before - Math.max(0, Math.floor(nTimes)));
  setPP(st, rosterId, moveName, after);
  syncMovePoolPPFromCanonical(st, rosterId, moveName);
  return (before - after);
}

function awardCheckpoint1RewardOnce(st){
  ensureNianCheckpointState(st);
  if (st.checkpoints.nianBoss.cp1RewardClaimed) return false;
  st.shop = st.shop || {gold:0, ledger:[]};
  st.shop.gold = Math.max(0, Math.floor(Number(st.shop.gold||0) + 10));
  st.bag = st.bag || {};
  st.bag['Revive'] = Number(st.bag['Revive']||0) + 1;
  st.checkpoints.nianBoss.cp1RewardClaimed = {ts: Date.now(), gold: 10, items: {'Revive': 1}};
  return true;
}

function awardCheckpoint2RewardOnce(st){
  // CP2 reward: +10 gold + 1× TM - Fling (placeholder; move list contains Fling).
  ensureNianCheckpointState(st);
  if (st.checkpoints.nianBoss.cp2RewardClaimed) return false;
  st.shop = st.shop || {gold:0, ledger:[]};
  st.shop.gold = Math.max(0, Math.floor(Number(st.shop.gold||0) + 10));
  st.bag = st.bag || {};
  st.bag['TM - Fling'] = Number(st.bag['TM - Fling']||0) + 1;
  st.checkpoints.nianBoss.cp2RewardClaimed = {ts: Date.now(), gold: 10, items: {'TM - Fling': 1}};
  return true;
}

function renderNianCheckpointPanel(ctx, state, idx){
  const { store } = ctx;
  const cp = mergeCheckpoint(state, idx);
  const opts = rosterOptions(state);

  const title = `Nian Boss Checkpoint ${idx}`;
  const rewardText = (idx === 1)
    ? 'Reward: +10 gold + 1× Revive (once)'
    : (idx === 2)
      ? 'Reward: +10 gold + 1× TM - Fling (once)'
    : 'PP log only';

  const loggedRec = state?.checkpoints?.nianBoss?.[`cp${idx}Logged`] || null;
  const isLogged = !!loggedRec;

  const guideText = (
    'Turn 1: Cobalion Provoke | Medicham Drain Punch | Empoleon Protective Aura (Empoleon needs no Strength Charm) | Serperior Gastro Acid\n' +
    'Turn 2: Cobalion Sacred Sword | Medicham Drain Punch | Empoleon Scald | Serperior Leaf Storm\n' +
    'Turn 3: Cobalion Sacred Sword | Medicham Drain Punch | Empoleon Scald/Flash Cannon (switch to Flash Cannon if burn triggers T1) | Serperior Leaf Storm\n' +
    'Turn 4: Cobalion Sacred Sword | Medicham Drain Punch | Empoleon Scald/Flash Cannon (switch if burn triggers T1/T2) | Serperior Dragon Pulse'
  );

  function persistParty(k, v){
    store.update(st=>{
      ensureNianCheckpointState(st);
      const key = `cp${idx}`;
      const cur = st.ui.nianBoss[key] || {};
      st.ui.nianBoss[key] = {
        ...cur,
        party: { ...(cur.party||{}), [k]: v || null },
      };
    });
  }

  function persistAdvanced(v){
    store.update(st=>{
      ensureNianCheckpointState(st);
      const key = `cp${idx}`;
      st.ui.nianBoss[key] = st.ui.nianBoss[key] || {};
      st.ui.nianBoss[key].advanced = !!v;
    });
  }

  function persistTurn(ti, side, v){
    store.update(st=>{
      ensureNianCheckpointState(st);
      const key = `cp${idx}`;
      const cur = st.ui.nianBoss[key] || {};
      const turns = Array.isArray(cur.turns) ? cur.turns.slice() : mergeCheckpoint(st, idx).turns.slice();
      while (turns.length < 4) turns.push({});
      while (ti >= turns.length) turns.push({});
      turns[ti] = { ...(turns[ti]||{}), [side]: v || '' };
      st.ui.nianBoss[key] = { ...cur, turns };
    });
  }

  function addTurn(){
    store.update(st=>{
      ensureNianCheckpointState(st);
      const key = `cp${idx}`;
      const cur = st.ui.nianBoss[key] || {};
      const turns = Array.isArray(cur.turns) ? cur.turns.slice() : mergeCheckpoint(st, idx).turns.slice();
      turns.push({});
      st.ui.nianBoss[key] = { ...cur, turns };
    });
  }

  function removeTurn(){
    store.update(st=>{
      ensureNianCheckpointState(st);
      const key = `cp${idx}`;
      const cur = st.ui.nianBoss[key] || {};
      const turns = Array.isArray(cur.turns) ? cur.turns.slice() : mergeCheckpoint(st, idx).turns.slice();
      if (turns.length <= 4) return; // keep at least the standard 4
      turns.pop();
      st.ui.nianBoss[key] = { ...cur, turns };
    });
  }

  function doDebit({allTurns}){
    store.update(st=>{
      ensureNianCheckpointState(st);
      const live = mergeCheckpoint(st, idx);
      const party = live.party || {};
      const turnCount = allTurns ? (live.turns?.length || 0) : Math.min(4, (live.turns?.length || 0));

      // Tally uses per (mon, move).
      const tally = new Map();
      for (let ti=0; ti<turnCount; ti++){
        const t = live.turns?.[ti] || {};
        const uses = [
          {id: party.aId, mv: t.a},
          {id: party.bId, mv: t.b},
          {id: party.cId, mv: t.c},
          {id: party.dId, mv: t.d},
        ];
        for (const u of uses){
          if (!u.id || !u.mv) continue;
          const k = `${u.id}::${u.mv}`;
          tally.set(k, (tally.get(k)||0) + 1);
        }
      }

      // Build undo record.
      st.ui.nianBoss.lastDebit = st.ui.nianBoss.lastDebit || {};
      const last = {
        ts: Date.now(),
        mode: allTurns ? 'all' : 'clean',
        turnCount,
        ppUndo: [], // {rid,mv,before}
        deducted: [],
        reward: { gold: 0, revive: 0, claimed: false },
      };

      let totalDec = 0;
      for (const [k, n] of tally.entries()){
        const [rid, mv] = k.split('::');
        if (!rid || !mv) continue;

        // Snapshot before for undo.
        const before = clampInt(st?.pp?.[rid]?.[mv]?.cur ?? 12, 0, 999);
        const dec = deductMovePP(st, rid, mv, n);
        totalDec += dec;
        last.deducted.push({rid, mv, n, dec});
        if (dec > 0) last.ppUndo.push({rid, mv, before});
      }

      // Reward: checkpoint 1 only, only if something actually deducted.
      if (idx === 1 && totalDec > 0){
        const did = awardCheckpoint1RewardOnce(st);
        if (did){
          last.reward = { gold: 10, revive: 1, claimed: true };
        }
      }

      // Reward: checkpoint 2 only, only if something actually deducted.
      if (idx === 2 && totalDec > 0){
        const did = awardCheckpoint2RewardOnce(st);
        if (did){
          last.reward = { gold: 10, tmFling: 1, claimed: true };
        }
      }

      // Mark checkpoint as logged (overview cue on the divider).
      if (totalDec > 0){
        st.checkpoints = st.checkpoints || {};
        st.checkpoints.nianBoss = st.checkpoints.nianBoss || {};
        const key = `cp${idx}Logged`;
        st.checkpoints.nianBoss[key] = {
          ts: Date.now(),
          mode: allTurns ? 'all' : 'clean',
          turnCount,
          deducted: last.deducted,
        };
      }

      st.ui.nianBoss.lastDebit[String(idx)] = last;
    });
  }

  function doUndo(){
    store.update(st=>{
      ensureNianCheckpointState(st);
      const rec = st?.ui?.nianBoss?.lastDebit?.[String(idx)];
      if (!rec || rec.undone === true) return;

      // If this action created/overwrote the "logged" flag, revert it.
      const cpKey = `cp${idx}Logged`;
      const curLog = st?.checkpoints?.nianBoss?.[cpKey];
      if (curLog && curLog.ts && rec.ts && Number(curLog.ts) === Number(rec.ts)){
        delete st.checkpoints.nianBoss[cpKey];
      }

      // Undo PP
      for (const ch of (rec.ppUndo||[])){
        if (!ch || !ch.rid || !ch.mv) continue;
        setPP(st, ch.rid, ch.mv, ch.before);
        syncMovePoolPPFromCanonical(st, ch.rid, ch.mv);
      }

      // Undo reward if it was claimed on this action.
      if (idx === 1 && rec.reward?.claimed){
        st.shop = st.shop || {gold:0, ledger:[]};
        st.shop.gold = Math.max(0, Math.floor(Number(st.shop.gold||0) - Number(rec.reward.gold||0)));
        st.bag = st.bag || {};
        const cur = Number(st.bag['Revive']||0);
        const next = Math.max(0, cur - Number(rec.reward.revive||0));
        if (next <= 0) delete st.bag['Revive'];
        else st.bag['Revive'] = next;
        if (st.checkpoints?.nianBoss?.cp1RewardClaimed) delete st.checkpoints.nianBoss.cp1RewardClaimed;
      }

      // Undo reward if it was claimed on this action.
      if (idx === 2 && rec.reward?.claimed){
        st.shop = st.shop || {gold:0, ledger:[]};
        st.shop.gold = Math.max(0, Math.floor(Number(st.shop.gold||0) - Number(rec.reward.gold||0)));
        st.bag = st.bag || {};
        const cur = Number(st.bag['TM - Fling']||0);
        const next = Math.max(0, cur - Number(rec.reward.tmFling||0));
        if (next <= 0) delete st.bag['TM - Fling'];
        else st.bag['TM - Fling'] = next;
        if (st.checkpoints?.nianBoss?.cp2RewardClaimed) delete st.checkpoints.nianBoss.cp2RewardClaimed;
      }

      rec.undone = true;
    });
  }

  function rosterSelect(slotLabel, key, curId){
    const sel = el('select', {class:'sel-mini'});
    sel.appendChild(el('option', {value:''}, '—'));
    for (const o of opts){
      sel.appendChild(el('option', {value:o.id, selected: o.id === curId}, o.name));
    }
    sel.addEventListener('change', ()=> persistParty(key, sel.value || null));
    return el('div', {class:'slot'}, [
      el('span', {class:'lbl'}, slotLabel),
      sel,
    ]);
  }

  function moveSelect(rosterId, value, onChange){
    const sel = el('select', {class:'sel-mini'});
    sel.appendChild(el('option', {value:''}, '—'));
    for (const mv of moveOptionsForRosterId(state, rosterId)){
      sel.appendChild(el('option', {value: mv, selected: mv === value}, mv));
    }
    sel.addEventListener('change', ()=> onChange(sel.value||''));
    return sel;
  }

  const lastRec = state?.ui?.nianBoss?.lastDebit?.[String(idx)] || null;
  const canUndo = !!lastRec && lastRec.undone !== true && Array.isArray(lastRec.ppUndo) && lastRec.ppUndo.length;

  // Keep wording aligned with the normal planner CTA.
  const btnClean = el('button', {class:'btn-mini btn-strong'}, 'Fight');
  btnClean.addEventListener('click', (ev)=>{ ev.preventDefault(); doDebit({allTurns:false}); });

  const btnUndo = el('button', {class:'btn-mini btn-undo', disabled: !canUndo}, 'Undo');
  btnUndo.addEventListener('click', (ev)=>{ ev.preventDefault(); if (canUndo) doUndo(); });

  const btnAdv = el('button', {class:'btn-mini' + (cp.advanced ? ' active' : '')}, cp.advanced ? 'Hide advanced' : 'Something went wrong?');
  btnAdv.addEventListener('click', (ev)=>{ ev.preventDefault(); persistAdvanced(!cp.advanced); });

  const header = el('div', {class:'checkpoint-head'}, [
    el('div', {}, [
      el('div', {class:'checkpoint-title'}, title),
      el('div', {class:'checkpoint-sub'}, 'Boss fight plan + PP logging (no damage sim)'),
    ]),
    el('div', {class:'boss-actions'}, [
      (isLogged ? el('div', {class:'pill good'}, 'LOGGED') : null),
      el('div', {class: (idx === 1 ? 'pill warn' : 'pill info')}, rewardText),
      (isLogged && loggedRec?.mode ? el('div', {class:'pill info'}, `Last: ${loggedRec.mode} (${loggedRec.turnCount||0}T)`) : null),
    ].filter(Boolean)),
  ]);

  const partyRow = el('div', {class:'checkpoint-party'}, [
    rosterSelect('A', 'aId', cp.party.aId),
    rosterSelect('B', 'bId', cp.party.bId),
    rosterSelect('C', 'cId', cp.party.cId),
    rosterSelect('D', 'dId', cp.party.dId),
  ]);

  const actions = el('div', {class:'checkpoint-actions'}, [
    btnClean,
    btnUndo,
    btnAdv,
    el('div', {class:'pill info'}, (idx === 1 || idx === 2)
      ? 'Fight gives reward if PP was logged'
      : 'Fight logs PP'
    ),
    el('div', {class:'pill info'}, 'Default clean log: Empoleon Scald×2 + Flash Cannon×1'),
  ]);

  const card = el('div', {class:'checkpoint-card' + (isLogged ? ' logged' : '')}, [
    header,
    el('pre', {class:'checkpoint-guide'}, guideText),
    partyRow,
    actions,
  ]);

  if (cp.advanced){
    const turnsWrap = el('div', {class:'checkpoint-turns'});

    for (let ti=0; ti<cp.turns.length; ti++){
      const t = cp.turns[ti] || {};
      turnsWrap.appendChild(el('div', {class:'turn-row'}, [
        el('div', {class:'turn-head'}, `Turn ${ti+1}`),
        el('div', {class:'checkpoint-turn-grid'}, [
          el('div', {class:'cell'}, [el('div', {class:'checkpoint-mini'}, 'A'), moveSelect(cp.party.aId, t.a, v=>persistTurn(ti,'a',v))]),
          el('div', {class:'cell'}, [el('div', {class:'checkpoint-mini'}, 'B'), moveSelect(cp.party.bId, t.b, v=>persistTurn(ti,'b',v))]),
          el('div', {class:'cell'}, [el('div', {class:'checkpoint-mini'}, 'C'), moveSelect(cp.party.cId, t.c, v=>persistTurn(ti,'c',v))]),
          el('div', {class:'cell'}, [el('div', {class:'checkpoint-mini'}, 'D'), moveSelect(cp.party.dId, t.d, v=>persistTurn(ti,'d',v))]),
        ]),
      ]));
    }

    const btnAll = el('button', {class:'btn-mini btn-strong'}, `Fight (${cp.turns.length} turns)`);
    btnAll.addEventListener('click', (ev)=>{ ev.preventDefault(); doDebit({allTurns:true}); });

    const btnAdd = el('button', {class:'btn-mini'}, '+ Turn');
    btnAdd.addEventListener('click', (ev)=>{ ev.preventDefault(); addTurn(); });

    const btnRem = el('button', {class:'btn-mini btn-danger', disabled: cp.turns.length <= 4}, '− Turn');
    btnRem.addEventListener('click', (ev)=>{ ev.preventDefault(); if (cp.turns.length > 4) removeTurn(); });

    const adv = el('div', {class:'checkpoint-advanced'}, [
      el('div', {class:'checkpoint-sub'}, 'Advanced: extend turns, switch mons, pick any move (for bad RNG / longer fights).'),
      turnsWrap,
      el('div', {class:'checkpoint-actions'}, [btnAll, btnAdd, btnRem]),
    ]);

    card.appendChild(adv);
  }

  return card;
}

export function createWavesTab(ctx){
  const { data, calc, store, pokeApi, tabWaves } = ctx;

  // Base-cache prefetch (best-effort)
  const baseInFlight = new Set();
  function prefetchBaseForSlots(slots){
    const state = store.getState();
    const baseCache = state.baseCache || {};
    const species = speciesListFromSlots(slots);
    for (const sp of species){
      const s = fixName(sp);
      if (baseCache[s] && data.dex?.[baseCache[s]]) continue;
      if (baseInFlight.has(s)) continue;
      baseInFlight.add(s);
      pokeApi.resolveBaseSpecies(s, baseCache)
        .then(({updates})=>{
          if (!updates) return;
          store.update(st => {
            st.baseCache = {...(st.baseCache||{}), ...updates};
          });
        })
        .catch(()=>{})
        .finally(()=> baseInFlight.delete(s));
    }
  }

  function showOverviewForSlot(slotObj){
    store.update(s => {
      s.ui.attackOverview = {
        defender: slotObj.defender,
        level: Number(slotObj.level),
        tags: slotObj.tags || [],
        source: 'wave',
      };
    });
  }

  const renderWaveCard = createWaveCardRenderer({
    data,
    calc,
    store,
    pokeApi,
    prefetchBaseForSlots,
    showOverviewForSlot,
  });

  function renderWaves(state){
    tabWaves.innerHTML = '';

    const waves = groupBy(data.calcSlots, s => s.waveKey);

    // Rotate wave display order within each phase based on chosen start animal (Goat default).
    const startAnimal = (state.settings && state.settings.startAnimal) ? state.settings.startAnimal : 'Goat';
    const phase1Animals = Array.from({length:12}).map((_,i)=>{
      const wk = `P1W${i+1}`;
      return waves[wk]?.[0]?.animal || null;
    });
    const startIdx = Math.max(0, phase1Animals.indexOf(startAnimal));
    const waveNums = Array.from({length:12}).map((_,i)=>i+1);
    const rotatedNums = waveNums.slice(startIdx).concat(waveNums.slice(0,startIdx));

    const phaseWaveKeys = (phase)=> rotatedNums.map(n=>`P${phase}W${n}`).filter(k=>waves[k]);

    const phase1 = phaseWaveKeys(1);
    const phase2 = phaseWaveKeys(2);
    const phase3 = phaseWaveKeys(3);
    const phase4 = phaseWaveKeys(4);

    const sections = [
      {title:'Phase 1', phase:1, keys: phase1, bossAfter:true},
      {title:'Phase 2 — Part 1', phase:2, keys: phase2.slice(0,6), bossAfter:true},
      {title:'Phase 2 — Part 2', phase:2, keys: phase2.slice(6), bossAfter:true},
      {title:'Phase 3 — Part 1', phase:3, keys: phase3.slice(0,6), bossAfter:true},
      {title:'Phase 3 — Part 2', phase:3, keys: phase3.slice(6), bossAfter:true},
      {title:'Phase 4 — Part 1', phase:4, keys: phase4.slice(0,6), bossAfter:true},
      {title:'Phase 4 — Part 2', phase:4, keys: phase4.slice(6), bossAfter:true},
    ];

    let bossCount = 0;
    for (const sec of sections){
      tabWaves.appendChild(el('div', {}, [
        el('div', {class:'section-title'}, [
          el('div', {}, [
            el('div', {}, sec.title),
            el('div', {class:'section-sub'}, `Order rotated (start: ${startAnimal})`),
          ]),
        ]),
      ]));

      for (const wk of (sec.keys||[])){
        tabWaves.appendChild(renderWaveCard(state, wk, waves[wk]));
      }

      if (sec.bossAfter){
        bossCount += 1;

        // Boss checkpoints: available after every section (cp1..cp7).
        const cpKey = `cp${bossCount}`;
        const cpLoggedKey = `cp${bossCount}Logged`;
        const isOpen = !!(state?.ui?.nianBoss?.[cpKey]?.expanded);
        const isLogged = !!(state?.checkpoints?.nianBoss?.[cpLoggedKey]);

        // Align toggle style/wording with the normal wave expander.
        const btn = el('button', {class:'btn-mini btn-expander'}, isOpen ? 'Collapse checkpoint' : 'Expand checkpoint');
        btn.addEventListener('click', (ev)=>{
          ev.preventDefault();
          store.update(st=>{
            ensureNianCheckpointState(st);
            st.ui.nianBoss[cpKey] = st.ui.nianBoss[cpKey] || {};
            st.ui.nianBoss[cpKey].expanded = !st.ui.nianBoss[cpKey].expanded;
          });
        });

        tabWaves.appendChild(el('div', {class:'boss' + (isLogged ? ' claimed' : '')}, [
          el('div', {}, [
            el('div', {class:'title'}, 'NIAN BOSS'),
            el('div', {class:'hint'}, 'Checkpoint — after this section'),
          ]),
          el('div', {class:'boss-actions'}, [
            (isLogged ? el('div', {class:'pill good'}, 'LOGGED') : null),
            btn,
          ].filter(Boolean)),
        ]));

        if (isOpen){
          tabWaves.appendChild(renderNianCheckpointPanel(ctx, state, bossCount));
        }
      }
    }

    // Bonus boss: paid Politoed unlock (optional)
    const bonusOpen = !!(state?.ui?.bonusPolitoed?.expanded);
    const bonusLogged = !!(state?.checkpoints?.bonusPolitoed?.logged);
    const bonusBtn = el('button', {class:'btn-mini btn-expander'}, bonusOpen ? 'Collapse checkpoint' : 'Expand checkpoint');
    bonusBtn.addEventListener('click', (ev)=>{
      ev.preventDefault();
      store.update(st=>{
        ensureBonusPolitoedState(st);
        st.ui.bonusPolitoed.expanded = !st.ui.bonusPolitoed.expanded;
      });
    });

    tabWaves.appendChild(el('div', {class:'boss' + (bonusLogged ? ' claimed' : '')}, [
      el('div', {}, [
        el('div', {class:'title'}, 'BONUS BOSS'),
        el('div', {class:'hint'}, 'Optional paid unlock'),
      ]),
      el('div', {class:'boss-actions'}, [
        (bonusLogged ? el('div', {class:'pill good'}, 'LOGGED') : null),
        bonusBtn,
      ].filter(Boolean)),
    ]));

    if (bonusOpen){
      tabWaves.appendChild(renderBonusPolitoedPanel(ctx, state));
    }
  }

  return { render: renderWaves };
}
