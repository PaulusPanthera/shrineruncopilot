// js/ui/tabs/waves/planner/wavePlannerPanel.js
// alpha v1
// Per-wave planner UI: enemy selection, solve, fight plan, preview, and fight log.

import { $, $$, el, pill, formatPct, clampInt, sprite } from '../../../dom.js';
import { fixName } from '../../../../data/nameFixes.js';
import {
  ensureWavePlan,
  settingsForWave,
  getWaveDefMods,
  enemyThreatForMatchup,
  assumedEnemyThreatForMatchup,
  phaseDefenderLimit,
} from '../../../../domain/waves.js';
import {
  ITEM_CATALOG,
  TYPES_NO_FAIRY,
  plateName,
  gemName,
  moveTypesFromMovePool,
  tipCandidatesForTypes,
  lootBundle,
  normalizeBagKey,
  computeRosterUsage,
  availableCount,
  availableCountWithItemOverrides,
  enforceBagConstraints,
  isGem,
  isPlate,
  priceOfItem,
  buyOffer,
} from '../../../../domain/items.js';
import {
  initBattleForWave,
  stepBattleTurn,
  resetBattle,
  setManualAction,
  chooseReinforcement,
  ensurePPForRosterMon,
  setPP,
  battleLabelForRowKey,
  DEFAULT_MOVE_PP,
  isAoeMove,
  aoeHitsAlly,
  immuneFromAllyAbilityItem,
  spreadMult,
} from '../../../../domain/battle.js';
import { applyMovesetOverrides, defaultNatureForSpecies } from '../../../../domain/shrineRules.js';
import { applyCharmRulesSync, isStarterSpecies } from '../../../../domain/roster.js';
import { maybeAwardPhaseReward } from '../../../../domain/phaseRewards.js';
import { getItemIcon, getTypeIcon } from '../../../icons.js';
import { createDexApiHelpers } from '../../../dexApi.js';
import {
  spriteStatic,
  rosterLabel,
  filterMovePoolForCalc,
  enemyAbilityForSpecies,
  inferBattleWeatherFromLeads,
  withWeatherSettings,
} from '../../../battleUiHelpers.js';

import { byId, uniq, baseDefKey, formatPrioAvg } from '../wavesUtil.js';

// Local helper (kept here to avoid leaking extra exports from battleUiHelpers).
// Used by the Move Override selector so 0-PP moves can be shown/disabled correctly.
function ppCurFor(ppMap, monId, moveName){
  const n = Number(ppMap?.[monId]?.[moveName]?.cur);
  return Number.isFinite(n) ? n : DEFAULT_MOVE_PP;
}

// Cached fight outcome previews for the Fight plan panel.

const FIGHT_OUTCOME_PREVIEW_CACHE = new Map();

export function createWavePlannerPanelRenderer(ctx){
  const { data, calc, store, pokeApi, showOverviewForSlot } = ctx;

  const { ensureDexApi } = createDexApiHelpers({ store, pokeApi });

function renderWavePlanner(state, waveKey, slots, wp){
  if (!wp){
    // Rare: if wavePlans missing, normalize once
    store.update(s => { ensureWavePlan(data, s, waveKey, slots); });
    state = store.getState();
    wp = state.wavePlans[waveKey];
  }

  const phase = Number(slots[0]?.phase || 1);
  const defLimit = phaseDefenderLimit(phase);

  const slotByKey = new Map(slots.map(s=>[s.rowKey, s]));

  const selectedDef = new Set((wp.defenders||[]).slice(0, defLimit));


  function commitSelected(){
    store.update(s => {
      ensureWavePlan(data, s, waveKey, slots);
      const w = s.wavePlans[waveKey];
      w.defenders = Array.from(selectedDef).slice(0, defLimit);
      w.defenderStart = w.defenders.slice(0,2);
      // Attackers are global (active roster). Keep existing starter picks if valid.
      w.manualOrder = false;
      ensureWavePlan(data, s, waveKey, slots);
    });
  }

  // helper UI controls
  const stageSel = (cur, onChange)=>{
    const sel = el('select', {class:'sel-mini'}, Array.from({length:13}).map((_,i)=>{
      const v = i-6;
      return el('option', {value:String(v), selected:Number(cur)===v}, (v>=0?`+${v}`:`${v}`));
    }));
    sel.addEventListener('change', ()=> onChange(Number(sel.value)||0));
    return sel;
  };
  const hpPctInput = (cur, onChange)=>{
    const inp = el('input', {type:'number', min:'1', max:'100', step:'1', value:String(cur ?? 100), class:'inp-mini'});
    inp.addEventListener('change', ()=> onChange(clampInt(inp.value,1,100)));
    return inp;
  };
  const chip = (label, node)=> el('div', {class:'modchip'}, [el('span', {class:'lbl'}, label), node]);

  // Mod patchers (defenders only; attacker mods are global from Roster tab)
  function patchDefMods(rowKey, patch){
    store.update(s => {
      const w = s.wavePlans[waveKey];
      w.monMods = w.monMods || {atk:{}, def:{}};
      w.monMods.def = w.monMods.def || {};
      const cur = w.monMods.def[rowKey] || {};
      w.monMods.def[rowKey] = {...cur, ...(patch||{})};
    });
  }

  const getDefMods = (rowKey)=> getWaveDefMods(state.settings, wp, rowKey);

  function buildDefModRow(slotObj){
    const dm = getDefMods(slotObj.rowKey);
    const wrap = el('div', {class:'modrow'}, [
      chip('HP%', hpPctInput(dm.hpPct, v=>patchDefMods(slotObj.rowKey,{hpPct:v}))),
      chip('Atk', stageSel(dm.atkStage, v=>patchDefMods(slotObj.rowKey,{atkStage:v}))),
      chip('SpA', stageSel(dm.spaStage, v=>patchDefMods(slotObj.rowKey,{spaStage:v}))),
      chip('Def', stageSel(dm.defStage, v=>patchDefMods(slotObj.rowKey,{defStage:v}))),
      chip('SpD', stageSel(dm.spdStage, v=>patchDefMods(slotObj.rowKey,{spdStage:v}))),
      chip('Spe', stageSel(dm.speStage, v=>patchDefMods(slotObj.rowKey,{speStage:v}))),
    ]);

    // Prevent modifier interactions from toggling enemy selection (row click handler).
    const stop = (ev)=>{ ev.stopPropagation(); };
    wrap.addEventListener('click', stop);
    wrap.addEventListener('mousedown', stop);
    wrap.addEventListener('pointerdown', stop);
    wrap.addEventListener('contextmenu', stop);

    return wrap;
  }


  function isNeutralDefMods(dm){
    const hp = Number(dm?.hpPct ?? 100);
    if (hp !== 100) return false;
    return [dm?.atkStage, dm?.spaStage, dm?.defStage, dm?.spdStage, dm?.speStage]
      .every(x=> (Number(x||0) === 0));
  }

  function buildDefModFold(slotObj){
    const dm = getDefMods(slotObj.rowKey);
    const neutral = isNeutralDefMods(dm);

    const sum = el('summary', {class:'defmods-summary', title:'Adjust defender modifiers (HP% and stat stages)'}, [
      el('span', {class:'muted small'}, '⚙ Mods'),
      neutral ? null : el('span', {class:'defmods-dot', title:'Non-neutral modifiers'}, '●'),
    ].filter(Boolean));

    const body = buildDefModRow(slotObj);
    const det = el('details', {class:'defmods' + (neutral ? '' : ' nonneutral')}, [sum, body]);

    // Prevent modifier interactions from toggling enemy selection (row click handler).
    const stop = (ev)=>{ ev.stopPropagation(); };
    det.addEventListener('click', stop);
    det.addEventListener('mousedown', stop);
    det.addEventListener('pointerdown', stop);
    det.addEventListener('contextmenu', stop);

    return det;
  }

  // attacker mods are edited on the Roster tab

  // Enemy picker (lead pair + optional reinforcements)
  // Phase 1: limit is 2, swapping should be effortless. Duplicates are supported by rowKey.
  // Phase 2/3: allow picking up to the phase limit (3/4) so the fight simulator can model reinforcements.
  const enemyList = el('div', {class:'pick-grid'});

	    const selected = Array.from({length:defLimit}).map((_,i)=> (wp.defenders||[])[i] || null);
	    const selectedKeys = selected.filter(Boolean);
	    // rowKey -> list of slot positions (#1..#N)
	    const selectedSlotsByKey = {};
	    for (let i=0;i<selected.length;i++){
	      const k = selected[i];
	      if (!k) continue;
	      selectedSlotsByKey[k] = selectedSlotsByKey[k] || [];
	      selectedSlotsByKey[k].push(i+1);
	    }
	    const selectedBaseSet = new Set(Object.keys(selectedSlotsByKey));

  function setSelectedArr(next){
    const arr = Array.isArray(next) ? next.slice(0, defLimit) : [];
    // Keep order, allow duplicates, but pack slots left (remove gaps)
    const compact = arr.filter(Boolean).slice(0, defLimit);
    while (compact.length < defLimit) compact.push(null);

    store.update(s=>{
      ensureWavePlan(data, s, waveKey, slots);
      const w = s.wavePlans[waveKey];
      w.defenders = compact.filter(Boolean);
      w.defenderStart = w.defenders.slice(0,2);
      w.manualOrder = false;
      ensureWavePlan(data, s, waveKey, slots);
    });
  }

  // Dropdowns: show each species row ONCE (no duplicate instance numbering in the dropdown).
  const optionEls = [];
  for (const sl of slots){
    const label = `${sl.defender} · Lv ${sl.level}`;
    optionEls.push(el('option', {value:sl.rowKey}, label));
  }

  const slotLabelFor = (i)=>{
    const n = i + 1;
    if (n === 1) return 'Lead #1';
    if (n === 2) return 'Lead #2';
    return `Reinf #${n}`;
  };

  const makeSlot = (idx, curKey)=>{
    const sel = el('select', {class:'sel-mini', style:'min-width:270px'}, [
      el('option', {value:''}, '— empty —'),
      ...optionEls.map(o=>{
        const clone = o.cloneNode(true);
        const rk = clone.getAttribute('value');
        if (rk === curKey) clone.setAttribute('selected','selected');
        return clone;
      })
    ]);
    sel.addEventListener('change', ()=>{
      const next = selected.slice();
      next[idx] = sel.value || null;
      setSelectedArr(next);
    });
    return el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [
      el('span', {class:'muted small', style:'min-width:70px'}, slotLabelFor(idx)),
      sel,
    ]);
  };

	    const selectionSummary = selectedKeys.length
	      ? el('div', {class:'muted small', style:'margin-top:6px'},
	          'Join order: ' + selected
	            .map((rk, i)=> rk ? `${slotLabelFor(i)} ${slotByKey.get(rk)?.defender || rk}` : null)
	            .filter(Boolean)
	            .join(' · ')
	        )
	      : null;

  const slotControls = el('div', {class:'panel'}, [
    el('div', {class:'panel-title'}, 'Selected enemies'),
    el('div', {class:'muted small'}, `Pick up to ${defLimit}. Left-click add, right-click remove. Lead #1/#2 start; reinf join in order.`),
    ...Array.from({length:defLimit}).map((_,i)=> makeSlot(i, selected[i] || null)),
    selectionSummary,
  ].filter(Boolean));

	    for (const s of slots){
    ensureDexApi(s.defender);
	      const positions = selectedSlotsByKey[s.rowKey] || [];
	      const isSelected = positions.length > 0;

    const base = pokeApi.baseOfSync(s.defender, state.baseCache||{});
    const isUnlocked = !!state.unlocked?.[base];
    const isClaimed = !!state.cleared?.[baseDefKey(s.rowKey)];

    // In the wave list, show defenders a bit larger (static PNG) for readability.
    const spImg = el('img', {class:'sprite sprite-md', src:spriteStatic(calc, s.defender), alt:s.defender});
    spImg.onerror = ()=> spImg.style.opacity='0.25';
    const sp = el('div', {class:'pick-sprite', title:'Open Pokédex'}, [spImg]);

    const statusPill = isClaimed
      ? pill('CLAIMED','good')
      : (isUnlocked ? pill('UNLOCKED','warn') : pill('LOCKED','bad'));

	      const selPills = positions.length ? positions.slice(0,4).map(n=>pill(`#${n}`,'info')) : [];

	      const titleLine = el('div', {style:'display:flex; justify-content:space-between; align-items:center; gap:8px'}, [
	        el('div', {class:'pick-title'}, `${s.defender}`),
	        el('div', {style:'display:flex; gap:6px; align-items:center'}, [
	          ...selPills,
	          statusPill,
	        ].filter(Boolean)),
	      ]);

    const row = el('div', {class:'pick-item' + (isUnlocked ? ' unlocked':'' ) + (isClaimed ? ' cleared':'' ) + (isSelected ? ' selected':'' )}, [
      sp,
      el('div', {class:'pick-meta'}, [
        titleLine,
        el('div', {class:'pick-sub'}, `Lv ${s.level}` + ((s.tags||[]).length ? ` · ${s.tags.join(',')}` : '')),
        buildDefModFold(s),
      ]),
    ]);

    // Click zones: card selects defenders; sprite opens Pokédex; Mods opens modifier controls.
    row.title = 'Select defender: left-click add, right-click remove. Sprite opens Pokédex. Use Mods to adjust HP%/stages.';

	      // Left click = add/select (duplicates allowed). Right click = remove/unselect.
	      row.addEventListener('click', (ev)=>{
      if (ev?.target?.closest && (ev.target.closest('.modrow') || ev.target.closest('.defmods'))) return;
      const cur = (store.getState().wavePlans?.[waveKey]?.defenders || []).slice(0, defLimit);
      const arr = Array.from({length:defLimit}).map((_,i)=> cur[i] || null);
      const base = s.rowKey;
      const empty = arr.indexOf(null);
	      if (empty !== -1){
	        arr[empty] = base;
	        return setSelectedArr(arr);
	      }
	      // Full: FIFO overwrite
	      for (let i=0;i<defLimit-1;i++) arr[i] = arr[i+1];
	      arr[defLimit-1] = base;
	      return setSelectedArr(arr);
    });

    row.addEventListener('contextmenu', (ev)=>{
      ev.preventDefault();
      if (ev?.target?.closest && (ev.target.closest('.modrow') || ev.target.closest('.defmods'))) return;
      const cur = (store.getState().wavePlans?.[waveKey]?.defenders || []).slice(0, defLimit);
      const arr = Array.from({length:defLimit}).map((_,i)=> cur[i] || null);
      const base = s.rowKey;
      // remove the most recent occurrence
      for (let i=arr.length-1;i>=0;i--){
        if (arr[i] === base){
          arr[i] = null;
          break;
        }
      }
      return setSelectedArr(arr);
    });

    sp.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      showOverviewForSlot(s);
    });

    enemyList.appendChild(row);
  }

  const activeRoster = state.roster.filter(r=>r.active).slice(0,16);

  // Fight plan + suggestions (same as current v13 feature set)
  // NOTE: "Fight" should be the most obvious action on this screen, so the CTA lives in the panel title row.
  const planTitleRow = el('div', {class:'panel-title-row fightplan-title-row'}, [
    el('div', {class:'panel-title'}, 'Fight plan'),
  ]);

  // Wave toolbar slot (filled later once fight log controls are built)
  const waveToolsSlot = el('div', {class:'wave-tools-slot'});
  const planEl = el('div', {class:'panel'}, [
    planTitleRow,
    el('div', {class:'muted small'}, 'Uses your ACTIVE roster from the Roster tab. Auto-match is always enabled. Use suggested lead pairs to quickly set starters.'),
    waveToolsSlot,
  ]);

  // Starter pickers (optional manual override)
  const starterIds = (wp.attackerStart||[]).slice(0,2);
  const starterA = starterIds[0] || (activeRoster[0]?.id ?? null);
  const starterB = starterIds[1] || (activeRoster[1]?.id ?? null);

  const makeStarterSel = (value, otherValue, onPick)=>{
    const sel = el('select', {class:'sel-mini'}, [
      ...activeRoster.map(r=>el('option', {value:r.id, selected:r.id===value, disabled:r.id===otherValue}, rosterLabel(r))),
    ]);
    sel.addEventListener('change', ()=> onPick(sel.value));
    return sel;
  };

  const starterSpriteEl = (monId)=>{
    const rm = byId(state.roster||[], monId);
    const sp = rm ? (rm.effectiveSpecies||rm.baseSpecies) : null;
    if (!sp) return el('span', {class:'sprite sprite-sm'});
    return el('img', {class:'sprite sprite-sm', src: spriteStatic(calc, sp), title: sp, alt: sp});
  };

  let selA = null;
  let selB = null;
  const row = el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px'}, [
    el('span', {class:'muted small'}, 'Starters:'),
  ]);

  selA = makeStarterSel(starterA, starterB, (id)=>{
    store.update(s=>{
      const w = s.wavePlans[waveKey];
      w.attackerStart = [id, (w.attackerStart||[])[1] || starterB].slice(0,2);
      // ensure distinct
      if (w.attackerStart[0] === w.attackerStart[1]){
        const alt = activeRoster.find(r=>r.id!==w.attackerStart[0]);
        if (alt) w.attackerStart[1] = alt.id;
      }
      w.attackerOrder = w.attackerStart.slice(0,2);
      w.manualStarters = true;
      w.manualOrder = false;
      ensureWavePlan(data, s, waveKey, slots);
    });
  });
  selB = makeStarterSel(starterB, starterA, (id)=>{
    store.update(s=>{
      const w = s.wavePlans[waveKey];
      w.attackerStart = [(w.attackerStart||[])[0] || starterA, id].slice(0,2);
      if (w.attackerStart[0] === w.attackerStart[1]){
        const alt = activeRoster.find(r=>r.id!==w.attackerStart[0]);
        if (alt) w.attackerStart[0] = alt.id;
      }
      w.attackerOrder = w.attackerStart.slice(0,2);
      w.manualStarters = true;
      w.manualOrder = false;
      ensureWavePlan(data, s, waveKey, slots);
    });
  });

  const autoBtn = el('button', {class:'btn-mini'}, 'Auto');
  autoBtn.addEventListener('click', ()=>{
    store.update(s=>{
      const w = s.wavePlans[waveKey];
      w.manualStarters = false;
      w.manualOrder = false;
      ensureWavePlan(data, s, waveKey, slots);
    });
  });

  // Small static sprites next to the starter selectors (Fight plan only).
  row.appendChild(starterSpriteEl(starterA));
  row.appendChild(selA);
  row.appendChild(el('span', {class:'muted small'}, '+'));
  row.appendChild(starterSpriteEl(starterB));
  row.appendChild(selB);
  row.appendChild(autoBtn);
  planEl.appendChild(row);

  // Primary action: Fight (log next fight). This should be the most obvious action in the Fight plan.
  // Place it in the Fight plan title row (top-right), as the main CTA.
  const logLenNow = Number((wp.fightLog||[]).length || 0);
  const selDefsNow = (wp.defenders||[]).slice(0, defLimit).filter(Boolean).length;
  const startersNow = (starterA && starterB) ? 2 : (wp.attackerStart||wp.attackerOrder||[]).slice(0,2).filter(Boolean).length;
  let primaryFightBtn = el('button', {
    class:'btn btn-fight-primary',
    disabled: (logLenNow >= 4) || (selDefsNow < 2) || (startersNow < 2),
    title: 'Run and log the next fight using the current Fight plan (max 4 fights).'
  }, logLenNow >= 4 ? '⚔ Fight (4/4)' : '⚔ Fight');
  planTitleRow.appendChild(primaryFightBtn);

  // Move override pickers (optional)
  const makeMoveOverrideSel = (attId)=>{
    const mon = byId(state.roster||[], attId);
    if (!mon) return el('span', {class:'muted small'}, '—');
    const cur = (wp.attackMoveOverride||{})[attId] || '';
    const opts = [el('option', {value:'', selected: !cur}, 'Auto')];
    for (const mv of (mon.movePool||[])){
      if (!mv || mv.use === false || !mv.name) continue;
      const curPP = ppCurFor(state.pp || {}, attId, mv.name);
      const label = `${mv.name}${curPP <= 0 ? ' (0 PP)' : ''}`;
      // If the move is out of PP, it cannot be newly selected.
      // If it is currently selected, keep it selectable so the UI doesn't break; the solver will ignore it.
      const disabled = (cur !== mv.name) && (curPP <= 0);
      opts.push(el('option', {value: mv.name, selected: cur === mv.name, disabled}, label));
    }
    const sel = el('select', {class:'sel-mini'}, opts);
    sel.addEventListener('change', ()=>{
      const v = String(sel.value||'');
      store.update(s=>{
        const w = s.wavePlans[waveKey];
        w.attackMoveOverride = w.attackMoveOverride || {};
        if (!v) delete w.attackMoveOverride[attId];
        else w.attackMoveOverride[attId] = v;
        ensureWavePlan(data, s, waveKey, slots);
      });
    });
    return sel;
  };

  // Clear = current wave only. Shift+Clear = all waves.
  const clearMoveOverridesBtn = el('button', {
    class:'btn-mini',
    title:'Clear move overrides for the current wave. Shift+Clear clears all waves.'
  }, 'Clear');
  clearMoveOverridesBtn.addEventListener('click', (ev)=>{
    const global = !!(ev && ev.shiftKey);
    store.update(s=>{
      if (global){
        for (const k of Object.keys(s.wavePlans||{})){
          const w = s.wavePlans[k];
          if (w && w.attackMoveOverride) delete w.attackMoveOverride;
        }
      }else{
        const w = s.wavePlans[waveKey];
        if (w && w.attackMoveOverride) delete w.attackMoveOverride;
      }
      ensureWavePlan(data, s, waveKey, slots);
    });
  });

  const moveRow = el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px'}, [
    el('span', {class:'muted small'}, 'Moves:'),
    makeMoveOverrideSel(starterA),
    el('span', {class:'muted small'}, '+'),
    makeMoveOverrideSel(starterB),
    clearMoveOverridesBtn,
  ]);
  planEl.appendChild(moveRow);


  // Item override pickers (optional): select a held item for this wave from the Bag.
  // This does NOT change the roster's held item; it only affects Fight plan + solver simulations.
  const bagItemKeys = Object.keys(state.bag||{}).filter(k => Number(state.bag[k]||0) > 0);
  const sortedBagItems = bagItemKeys.slice().sort((a,b)=>String(a).localeCompare(String(b)));

  const makeItemOverrideSel = (attId)=>{
    const mon = byId(state.roster||[], attId);
    if (!mon) return el('span', {class:'muted small'}, '—');
    const cur = (wp.itemOverride||{})[attId] || '';

    // Respect Bag availability *with the wave overrides applied as swaps*.
    // (If you override a mon, it frees its roster-held item and consumes the override item instead.)
    const ovrMap = (wp.itemOverride && typeof wp.itemOverride === 'object') ? wp.itemOverride : {};

    const opts = [el('option', {value:'', selected: !cur}, 'Auto (roster held)')];
    if (!sortedBagItems.length){
      return el('select', {class:'sel-mini', disabled:true}, opts);
    }

    for (const it of sortedBagItems){
      const avail = availableCountWithItemOverrides(state, ovrMap, it);
      // Allow keeping the current selection even if it would be over-allocated.
      const disabled = (it !== cur) && (avail <= 0);
      opts.push(el('option', {value: it, selected: cur === it, disabled}, `${it} (bag: ${Number(state.bag?.[it]||0)})`));
    }

    const sel = el('select', {class:'sel-mini'}, opts);
    sel.addEventListener('change', ()=>{
      const v = String(sel.value||'');
      store.update(s=>{
        const w = s.wavePlans[waveKey];
        w.itemOverride = (w.itemOverride && typeof w.itemOverride === 'object') ? w.itemOverride : {};
        if (!v) delete w.itemOverride[attId];
        else w.itemOverride[attId] = v;
        ensureWavePlan(data, s, waveKey, slots);
      });
    });
    return sel;
  };

  // Clear = current wave only. Shift+Clear = all waves.
  const clearItemOverridesBtn = el('button', {
    class:'btn-mini',
    title:'Clear item overrides for the current wave. Shift+Clear clears all waves.'
  }, 'Clear');
  clearItemOverridesBtn.addEventListener('click', (ev)=>{
    const global = !!(ev && ev.shiftKey);
    store.update(s=>{
      if (global){
        for (const k of Object.keys(s.wavePlans||{})){
          const w = s.wavePlans[k];
          if (w && w.itemOverride) delete w.itemOverride;
        }
      }else{
        const w = s.wavePlans[waveKey];
        if (w && w.itemOverride) delete w.itemOverride;
      }
      ensureWavePlan(data, s, waveKey, slots);
    });
  });

    const slowWarnInline = pill('SLOW','bad danger');
  slowWarnInline.style.display = 'none';
  slowWarnInline.title = 'At least one matchup has the enemy acting first. Consider speed items or different leads.';

  const itemWarnInline = pill('ITEMS','bad danger');
  itemWarnInline.style.display = 'none';
  itemWarnInline.title = 'Better solutions are available if you equip items from the Bag (see the item tips below).';

  const charmWarnInline = pill('CHARMS','bad danger');
  charmWarnInline.style.display = 'none';
  charmWarnInline.title = 'Better solutions are available if you apply Strength/Evo charms on your roster (even if you need to buy them).';

  const itemRow = el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px'}, [
    el('span', {class:'muted small'}, 'Items:'),
    makeItemOverrideSel(starterA),
    el('span', {class:'muted small'}, '+'),
    makeItemOverrideSel(starterB),
    clearItemOverridesBtn,
    slowWarnInline,
    itemWarnInline,
    charmWarnInline,
    el('span', {class:'muted small'}, '· uses Bag availability; preview assumes equipped'),
  ]);
  planEl.appendChild(itemRow);

  const slotByKey2 = new Map(slots.map(s=>[s.rowKey,s]));
  const selectedPlanKeys = (wp.defenders||[]).slice(0, defLimit);
  const picked = selectedPlanKeys
    .map(k=>({key:k, slot:slotByKey2.get(baseDefKey(k))}))
    .filter(x=>x.slot);
  const allDef = picked.map(x=>x.slot);

  const startersOrdered = (wp.attackerOrder||wp.attackerStart||[]).slice(0,2).map(id=>byId(state.roster,id)).filter(Boolean);
  const a0 = startersOrdered[0] || null;
  const a1 = startersOrdered[1] || null;

  const lead0 = picked[0]?.slot || null;
  const lead1 = picked[1]?.slot || null;
  const leadIntCount = [lead0, lead1].filter(x => (x?.tags||[]).includes('INT')).length;
  const waveWeather = inferBattleWeatherFromLeads(data, state, [a0, a1].filter(Boolean), [lead0, lead1].filter(Boolean));

  const applyEnemyIntimidateToSettings = (s0, attMon, intCount)=>{
    const n = clampInt(intCount ?? 0, 0, 6);
    if (!s0 || n <= 0) return s0;
    if (s0.applyINT === false) return s0;
    const abRaw = attMon?.ability ?? s0.attackerAbility ?? '';
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
  };

  // NOTE: Fight plan display picks "best" moves for multiple defenders. To avoid misleading
  // repeats when a move has low PP (e.g., 1 PP left), callers can pass a temporary ppMap
  // (ppBudget) that is decremented as we lay out the plan lines.
  const bestMoveForMon = (att, defSlot, ppMapOverride=null)=>{
    if (!att || !defSlot) return null;
    const atk = {species:(att.effectiveSpecies||att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: att.strength?state.settings.strengthEV:state.settings.claimedEV};
    const def = {species:defSlot.defender, level:defSlot.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    const forced = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[att.id] || null) : null;
    const pool = filterMovePoolForCalc({ppMap: ppMapOverride || state.pp || {}, monId: att.id, movePool: att.movePool || [], forcedMoveName: forced});

    const sW0 = settingsForWave(state, wp, att.id, defSlot.rowKey, defSlot.defender);
    const sWInt = applyEnemyIntimidateToSettings(sW0, att, leadIntCount);
    const sW = withWeatherSettings(sWInt, waveWeather);

    return calc.chooseBestMove({
      data,
      attacker: atk,
      defender: def,
      movePool: pool,
      settings: sW,
      tags: defSlot.tags||[],
    }).best;
  };

  const attackerActsFirst = (best)=>{
    if (!best) return false;
    const aSpe = Number(best.attackerSpe ?? 0);
    const dSpe = Number(best.defenderSpe ?? 0);
    if (aSpe > dSpe) return true;
    if (aSpe < dSpe) return false;
    // tie
    return !(state.settings?.enemySpeedTieActsFirst ?? true);
  };

  const chooseLeadAssignment = (mA0,mA1,mB0,mB1)=>{
    const SPEED_PRIO_CAP = 3.5;
    const tuple = (m0,m1)=>{
      const ohko = (m0?.oneShot ? 1 : 0) + (m1?.oneShot ? 1 : 0);
      const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
      const avgPrio = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
      const slowerCount = (!attackerActsFirst(m0) ? 1 : 0) + (!attackerActsFirst(m1) ? 1 : 0);
      const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
      return {ohko, worstPrio, avgPrio, slowerCount, overkill};
    };
    const better = (x,y)=>{
      if (x.ohko !== y.ohko) return x.ohko > y.ohko;
      if (x.worstPrio !== y.worstPrio) return x.worstPrio < y.worstPrio;
      const xOk = ((x.avgPrio ?? 9) <= SPEED_PRIO_CAP);
      const yOk = ((y.avgPrio ?? 9) <= SPEED_PRIO_CAP);
      // Only care about outspeeding when we can't keep prioØ in the good band.
      if (!xOk && !yOk){
        if ((x.slowerCount ?? 0) !== (y.slowerCount ?? 0)) return (x.slowerCount ?? 0) < (y.slowerCount ?? 0);
      }
      if (x.avgPrio !== y.avgPrio) return x.avgPrio < y.avgPrio;
      return x.overkill <= y.overkill;
    };
    const t1 = tuple(mA0,mB1);
    const t2 = tuple(mA1,mB0);
    return better(t1,t2) ? {swap:false, tuple:t1} : {swap:true, tuple:t2};
  };

  let startersClear = 0;
  for (const ds of allDef){
    const m0 = bestMoveForMon(a0, ds);
    const m1 = bestMoveForMon(a1, ds);
    if ((m0 && m0.oneShot) || (m1 && m1.oneShot)) startersClear += 1;
  }

  const planTable = el('div', {class:'plan'});

  if (a0 && a1 && lead0 && lead1){
    // Local PP budget for rendering the plan lines (does not mutate real state).
    // This prevents "uses Ice Punch twice" style display when only 1 PP remains.
    const ppBudget = JSON.parse(JSON.stringify(state.pp || {}));
    const initBudgetForMon = (mon)=>{
      if (!mon || !mon.id) return;
      const id = mon.id;
      ppBudget[id] = ppBudget[id] || {};
      for (const m of (mon.movePool||[])){
        if (!m || m.use === false || !m.name) continue;
        const src = state.pp?.[id]?.[m.name];
        if (src) ppBudget[id][m.name] = JSON.parse(JSON.stringify(src));
        else if (!ppBudget[id][m.name]) ppBudget[id][m.name] = {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
      }
    };
    const reservePPUse = (monId, moveName)=>{
      if (!monId || !moveName) return;
      ppBudget[monId] = ppBudget[monId] || {};
      const ent = ppBudget[monId][moveName] || {cur: DEFAULT_MOVE_PP, max: DEFAULT_MOVE_PP};
      const cur = Number(ent.cur ?? ent.max ?? DEFAULT_MOVE_PP);
      ent.cur = Math.max(0, cur - 1);
      ppBudget[monId][moveName] = ent;
    };
    initBudgetForMon(a0);
    initBudgetForMon(a1);

    const mA0 = bestMoveForMon(a0, lead0);
    const mA1 = bestMoveForMon(a0, lead1);
    const mB0 = bestMoveForMon(a1, lead0);
    const mB1 = bestMoveForMon(a1, lead1);
    const chosen = chooseLeadAssignment(mA0,mA1,mB0,mB1);
    const left = chosen.swap ? {att:a0, def:lead1, best:mA1} : {att:a0, def:lead0, best:mA0};
    const right = chosen.swap ? {att:a1, def:lead0, best:mB0} : {att:a1, def:lead1, best:mB1};

    // Reserve the two lead actions so later "bench" coverage uses the remaining PP.
    reservePPUse(left.att?.id, left.best?.move);
    reservePPUse(right.att?.id, right.best?.move);
    const prAvg = ((left.best?.prio ?? 9) + (right.best?.prio ?? 9)) / 2;

    // Deterministic 1-turn min-roll sim for the chosen lead assignment.
    // Purpose: make Fight plan headline lines match the battle engine in STU-break → AoE sweep cases.
    // Example: partner chips STU first (prio) and then EQ should show full damage on the STU target.
    const planSim = (()=>{
      try{
        if (!(left?.best?.move && right?.best?.move)) return null;

        const defByKey = new Map([[lead0.rowKey, lead0],[lead1.rowKey, lead1]]);
        const hpDef = {[lead0.rowKey]: 1, [lead1.rowKey]: 1};
        const hpAtk = {[a0.id]: 1, [a1.id]: 1};

        const atkObj = (rm, s)=>({
          species:(rm.effectiveSpecies||rm.baseSpecies),
          level: s.claimedLevel,
          ivAll: s.claimedIV,
          evAll: rm.strength ? s.strengthEV : s.claimedEV,
        });
        const defObj = (slot)=>({
          species:(slot.baseSpecies || slot.defender),
          level: slot.level,
          ivAll: (slot.ivAll ?? state.settings.wildIV ?? 0),
          evAll: (slot.evAll ?? state.settings.wildEV ?? 0),
        });

        const rrVsDef = (attMon, moveName, defSlot, curFrac)=>{
          const s0 = settingsForWave(state, wp, attMon.id, defSlot.rowKey, defSlot.defender);
          const s1 = applyEnemyIntimidateToSettings(s0, attMon, leadIntCount);
          const s = withWeatherSettings({...s1, defenderCurHpFrac: (curFrac ?? 1)}, waveWeather);
          const rr = calc.computeDamageRange({data, attacker: atkObj(attMon, s), defender: defObj(defSlot), moveName, settings: s, tags: defSlot.tags || []});
          return (rr && rr.ok) ? rr : null;
        };

        const rrVsAlly = (attMon, moveName, allyMon, curFrac)=>{
          const s0 = settingsForWave(state, wp, attMon.id, null);
          const s = withWeatherSettings({...s0, defenderItem: allyMon.item || null, defenderHpFrac: 1, defenderCurHpFrac: (curFrac ?? 1), applyINT: false, applySTU: false}, waveWeather);
          const rr = calc.computeDamageRange({data, attacker: atkObj(attMon, s), defender: atkObj(allyMon, s), moveName, settings: s, tags: []});
          return (rr && rr.ok) ? rr : null;
        };

        const actions = [
          {att: left.att, move: left.best.move, prio: (left.best.prio ?? 9), spe: Number(left.best.attackerSpe ?? 0), targetKey: left.def.rowKey},
          {att: right.att, move: right.best.move, prio: (right.best.prio ?? 9), spe: Number(right.best.attackerSpe ?? 0), targetKey: right.def.rowKey},
        ];
        actions.sort((x,y)=>{
          // Battle engine parity: action order is speed-desc (move "prio" is a planning tier, not turn priority).
          if ((y.spe??0) !== (x.spe??0)) return (y.spe??0) - (x.spe??0);
          return String(x.att.id||'').localeCompare(String(y.att.id||''));
        });

        const out = {};
        for (const act of actions){
          const aoe = isAoeMove(act.move);
          const hitsAlly = aoe && aoeHitsAlly(act.move);
          const ally = (act.att.id === a0.id) ? a1 : a0;

          const targets = [];
          if (aoe){
            for (const ds of [lead0, lead1]){
              if (!ds) continue;
              if ((hpDef[ds.rowKey] ?? 0) > 0) targets.push({kind:'def', slot: ds});
            }
            if (hitsAlly && ally && (hpAtk[ally.id] ?? 0) > 0) targets.push({kind:'ally', mon: ally});
          } else {
            const ds = defByKey.get(act.targetKey);
            if (ds && (hpDef[ds.rowKey] ?? 0) > 0) targets.push({kind:'def', slot: ds});
          }
          if (!targets.length) continue;

          const per = [];
          for (const t of targets){
            if (t.kind === 'def'){
              const cur = hpDef[t.slot.rowKey] ?? 1;
              const rr = rrVsDef(act.att, act.move, t.slot, cur);
              if (rr) per.push({kind:'def', key: t.slot.rowKey, name: t.slot.defender, rr});
            } else {
              const cur = hpAtk[t.mon.id] ?? 1;
              const rr = rrVsAlly(act.att, act.move, t.mon, cur);
              if (rr){
                const immune = immuneFromAllyAbilityItem(t.mon, rr.moveType);
                per.push({kind:'ally', id: t.mon.id, name: rosterLabel(t.mon), immune, rr});
              }
            }
          }
          if (!per.length) continue;

          let damaged = 0;
          for (const o of per){
            if (o.kind === 'ally' && o.immune) continue;
            if (Number(o.rr?.minPct || 0) > 0) damaged += 1;
          }
          const mult = aoe ? spreadMult(damaged) : 1.0;

          const main = per.find(o=>o.kind==='def' && o.key===act.targetKey) || per.find(o=>o.kind==='def') || null;
          const side = aoe ? (per.find(o=>o.kind==='def' && o.key!==act.targetKey) || null) : null;
          const ff = per.find(o=>o.kind==='ally') || null;

          out[act.att.id] = {
            mult,
            main: main ? {key: main.key, defender: main.name, minPct: Number(main.rr.minPct||0), maxPct: Number(main.rr.maxPct ?? main.rr.minPct ?? 0)} : null,
            side: side ? {key: side.key, defender: side.name, minPct: Number(side.rr.minPct||0), maxPct: Number(side.rr.maxPct ?? side.rr.minPct ?? 0)} : null,
            ff: ff ? {allyName: ff.name, moveType: ff.rr.moveType, immune: !!ff.immune, minPct: ff.immune?0:Number(ff.rr.minPct||0), maxPct: ff.immune?0:Number(ff.rr.maxPct ?? ff.rr.minPct ?? 0)} : null,
          };

          // Apply deterministic min-roll damage to advance HP fractions.
          for (const o of per){
            const rawMin = Number(o.rr?.minPct || 0);
            const finalMin = (o.kind === 'ally' && o.immune) ? 0 : (rawMin * mult);
            if (finalMin <= 0) continue;
            if (o.kind === 'def') hpDef[o.key] = Math.max(0, (hpDef[o.key] ?? 1) - (finalMin / 100));
            else hpAtk[o.id] = Math.max(0, (hpAtk[o.id] ?? 1) - (finalMin / 100));
          }
        }

        return out;
      }catch(e){
        return null;
      }
    })();

    const line = (x)=>{
      const best = x.best || null;
      const sim = (planSim && x.att) ? (planSim[x.att.id] || null) : null;
      const slower = !!(best && !attackerActsFirst(best));

      const aoe = !!(best && isAoeMove(best.move));
      const hitsAlly = !!(best && aoeHitsAlly(best.move));
      const enemyCount = (aoe && lead0 && lead1) ? 2 : 1;
      const ally = (a0 && a1 && x.att) ? (x.att.id === a0.id ? a1 : a0) : null;

      // AOE side-hit preview (other defender) for the fight plan display.
      // Use deterministic 1-turn sim when available so STU-break ordering is reflected.
      let aoeSide = null;
      if (sim && sim.side){
        aoeSide = {
          defender: sim.side.defender,
          minPct: Number(sim.side.minPct||0),
          maxPct: Number(sim.side.maxPct ?? sim.side.minPct ?? 0),
        };
      } else if (best && aoe && lead0 && lead1){
        const otherDef = (x.def && lead0 && x.def.rowKey === lead0.rowKey) ? lead1 : lead0;
        if (otherDef && otherDef.rowKey !== x.def.rowKey){
          try{
            const atk = {species:(x.att.effectiveSpecies||x.att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: x.att.strength?state.settings.strengthEV:state.settings.claimedEV};
            // NOTE: wave defender slots may omit ivAll/evAll; fall back to wild defaults to avoid NaN→0% previews.
            const defOther = {
              species: (otherDef.baseSpecies || otherDef.defender),
              level: otherDef.level,
              ivAll: (otherDef.ivAll ?? state.settings.wildIV ?? 0),
              evAll: (otherDef.evAll ?? state.settings.wildEV ?? 0),
            };
            const s0 = settingsForWave(state, wp, x.att.id, otherDef.rowKey, otherDef.defender);
            const s = withWeatherSettings({...s0, defenderCurHpFrac: 1}, waveWeather);
            const rr = calc.computeDamageRange({data, attacker: atk, defender: defOther, moveName: best.move, settings: s, tags: otherDef.tags || []});
            if (rr && rr.ok && Number.isFinite(rr.minPct)){
              aoeSide = {
                defender: otherDef.defender,
                minPct: Number(rr.minPct||0),
                maxPct: Number(rr.maxPct ?? rr.minPct ?? 0),
              };
            }
          }catch(e){ aoeSide = null; }
        }
      }

      // Friendly-fire preview (ally hit) + spread multiplier.
      let ff = null;
      if (sim && sim.ff){
        ff = {allyName: sim.ff.allyName, moveType: sim.ff.moveType, immune: !!sim.ff.immune, minPct: Number(sim.ff.minPct||0), maxPct: Number(sim.ff.maxPct ?? sim.ff.minPct ?? 0)};
      } else if (best && hitsAlly && ally){
        try{
          const atk = {species:(x.att.effectiveSpecies||x.att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: x.att.strength?state.settings.strengthEV:state.settings.claimedEV};
          const defAlly = {species:(ally.effectiveSpecies||ally.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: ally.strength?state.settings.strengthEV:state.settings.claimedEV};
          const sFF0 = settingsForWave(state, wp, x.att.id, x.def.rowKey, x.def.defender);
          const sFF = withWeatherSettings({...sFF0, defenderItem: ally.item || null, defenderHpFrac: 1, applyINT: false, applySTU: false}, waveWeather);
          const rr = calc.computeDamageRange({data, attacker: atk, defender: defAlly, moveName: best.move, settings: sFF, tags: []});
          if (rr && rr.ok){
            const immune = immuneFromAllyAbilityItem(ally, rr.moveType);
            ff = {
              allyName: rosterLabel(ally),
              moveType: rr.moveType,
              immune,
              minPct: immune ? 0 : Number(rr.minPct||0),
              maxPct: immune ? 0 : Number(rr.maxPct||rr.minPct||0),
            };
          }
        }catch(e){ /* ignore */ }
      }

      // Spread penalty should be based on how many targets are actually damaged (immunity matters).
      // Prefer the per-turn planSim targets (they know if the other lead was already KO'd before the AoE user acts).
      const sideRef = (sim && sim.side) ? sim.side : aoeSide;
      const targetsDamaged = aoe
        ? (
            ((Number((sim?.main?.minPct ?? best?.minPct) || 0) > 0) ? 1 : 0)
            + ((sideRef && Number(sideRef.minPct || 0) > 0) ? 1 : 0)
            + ((hitsAlly && ff && !ff.immune && Number(ff.minPct || 0) > 0) ? 1 : 0)
          )
        : 1;
      const mult = aoe ? (Number(sim?.mult) || spreadMult(targetsDamaged)) : 1.0;

      const baseMin = best ? Number((sim?.main?.minPct ?? best.minPct) || 0) : 0;
      const baseMax = best ? Number((sim?.main?.maxPct ?? best.maxPct ?? best.minPct) || 0) : 0;
      const adjMin = baseMin * mult;
      const adjMax = baseMax * mult;
      const oneShotAdj = best ? (adjMin >= 100) : false;

      // Apply spread mult to friendly fire preview too (same mult as the move use).
      if (ff && !ff.immune){
        ff = {...ff, minAdj: ff.minPct * mult, maxAdj: ff.maxPct * mult, couldKO: (ff.maxPct * mult) >= 100};
      } else if (ff) {
        ff = {...ff, minAdj: 0, maxAdj: 0, couldKO: false};
      }

      const sideTxt = (sideRef && aoe) ? ` · also ${sideRef.defender}: ${formatPct((sideRef.minPct||0)*mult)} min` : '';
      const out = best
        ? `${rosterLabel(x.att)} → ${x.def.defender}: ${best.move} (P${best.prio} · ${formatPct(adjMin)} min${aoe ? ` · AOE×${mult===1? '1.00':'0.75'}` : ''}${sideTxt})`
        : `${rosterLabel(x.att)} → ${x.def.defender}: —`;

      const speNote = (best)=>{
        if (!best) return '';
        const aSpe = Number(best.attackerSpe ?? 0);
        const dSpe = Number(best.defenderSpe ?? 0);
        const tieFirst = (state.settings?.enemySpeedTieActsFirst ?? true);
        if (aSpe === dSpe) return tieFirst ? `Speed tie (${aSpe} vs ${dSpe}) · enemy acts first on tie` : `Speed tie (${aSpe} vs ${dSpe}) · you act first on tie`;
        return `Speed: you ${aSpe} vs enemy ${dSpe}`;
      };

      // Optional outgoing tooltip (late game): show roll range + crit range in a tooltip (does not change displayed min% lines).
      let outTooltip = null;
      if (best && (state.settings?.outTipCrit ?? false)){
        try{
          const atk = {species:(x.att.effectiveSpecies||x.att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: x.att.strength?state.settings.strengthEV:state.settings.claimedEV};
          const def0 = {species:x.def.defender, level: x.def.level, ivAll: (x.def.ivAll ?? state.settings.wildIV ?? 0), evAll: (x.def.evAll ?? state.settings.wildEV ?? 0)};
          const s0 = settingsForWave(state, wp, x.att.id, x.def.rowKey, x.def.defender);
          const sCrit = withWeatherSettings({...s0, defenderCurHpFrac: 1, calcCrit: true}, waveWeather);
          const rr = calc.computeDamageRange({data, attacker: atk, defender: def0, moveName: best.move, settings: sCrit, tags: x.def.tags || []});
          if (rr && rr.ok){
            const rollMin = (Number(rr.minPct||0) * mult);
            const rollMax = (Number(rr.maxPct ?? rr.minPct ?? 0) * mult);
            const cMin = (rr.critMinPct!=null ? Number(rr.critMinPct||0) * mult : null);
            const cMax = (rr.critMaxPct!=null ? Number(rr.critMaxPct||0) * mult : null);            outTooltip = [
              `Roll range: ${formatPct(rollMin)}–${formatPct(rollMax)}`,
              (cMin!=null && cMax!=null) ? `Crit range: ${formatPct(cMin)}–${formatPct(cMax)} (x${Number(state.settings?.critMult ?? 1.5).toFixed(1)})` : null,
              (rr.critChance!=null) ? `Crit chance: ${Math.round(Number(rr.critChance||0)*10000)/100}% (stage ${Number(rr.critStage||0)})` : null,
            ].filter(Boolean).join('\n');
          }
        }catch(e){ outTooltip = null; }
      }

      const pills = [];
      if (best){
        (function(){
          const p = oneShotAdj ? pill('OHKO','good') : pill('NO','bad');
          if (outTooltip) p.title = outTooltip;
          pills.push(p);
        })();
        if (aoe){
          const p = pill('AOE','warn');
          const allyTxt = hitsAlly ? ' + may hit partner' : '';
          p.title = `AOE move: hits ${enemyCount} defender(s)${allyTxt}. Spread penalty applies when >1 target: ×0.75.`;
          pills.push(p);
        }
        if (hitsAlly && ally){
          const kindBase = (ff && ff.couldKO && !(state.settings?.allowFriendlyFire)) ? 'bad' : 'warn';
          const p = pill('FF', `${kindBase} danger`);
          if (!ff){
            p.title = `Friendly fire: ${best.move} can hit your partner (${rosterLabel(ally)}).`;
          } else if (ff.immune){
            p.title = `Friendly fire: partner ${ff.allyName} is immune to ${ff.moveType} (ability/item).`;
          } else {
            const koTxt = ff.couldKO ? 'RISK: could KO partner. ' : '';
            const settingTxt = ff.couldKO && !(state.settings?.allowFriendlyFire) ? 'Auto will avoid this if possible (setting OFF).' : (ff.couldKO ? 'Allowed (setting ON).' : '');
            p.title = `Friendly fire: hits partner ${ff.allyName} for ${formatPct(ff.minAdj)}–${formatPct(ff.maxAdj)} (AOE×${mult===1? '1.00':'0.75'}). ${koTxt}${settingTxt}`.trim();
          }
          pills.push(p);
        }
        if (slower){
          const p = pill('SLOW','bad danger');
          p.title = `Enemy may act first. ${speNote(best)}`;
          pills.push(p);
        }
      }

      return el('div', {class:'plan-line'}, [
        el('div', {class:'plan-left'}, [el('strong', {}, x.def.defender), el('span', {class:'muted'}, ` · Lv ${x.def.level}`)]),
        el('div', {class:'plan-right'}, [
          el('span', {}, out),
          ...pills,
        ])
      ]);
    };

    planTable.appendChild(el('div', {class:'muted small', style:'margin:6px 0 10px'}, `Lead pair plan · prioØ ${formatPrioAvg(prAvg)}`));
    planTable.appendChild(line(left));
    planTable.appendChild(line(right));

  // Incoming preview: show the predicted enemy move even if it would not land in reality
  // (e.g. you act first and OHKO). This helps verify logic and catch misplays.
  const incomingRow = (defSlot, myAttack)=>{
    if (!defSlot) return null;
    const best = myAttack?.best || null;
    const prevented = !!(best && best.oneShot && attackerActsFirst(best));

      const t0 = enemyThreatForMatchup(data, state, wp, a0, defSlot, {weather: waveWeather}) || assumedEnemyThreatForMatchup(data, state, wp, a0, defSlot, {weather: waveWeather});
      const t1 = enemyThreatForMatchup(data, state, wp, a1, defSlot, {weather: waveWeather}) || assumedEnemyThreatForMatchup(data, state, wp, a1, defSlot, {weather: waveWeather});
      const pick = (x,y)=>{
        if (!x && !y) return null;
        if (x && !y) return {th:x, target: rosterLabel(a0)};
        if (!x && y) return {th:y, target: rosterLabel(a1)};
        const dx = Number(x.minPct||0);
        const dy = Number(y.minPct||0);
        if (dx !== dy){
          return dx > dy ? {th:x, target: rosterLabel(a0)} : {th:y, target: rosterLabel(a1)};
        }
        const cx = Number(x.ohkoChance||0);
        const cy = Number(y.ohkoChance||0);
        if (cx !== cy){
          return cx > cy ? {th:x, target: rosterLabel(a0)} : {th:y, target: rosterLabel(a1)};
        }
        return {th:x, target: rosterLabel(a0)};
      };
      const pickRes = pick(t0,t1);
      if (!pickRes) return null;
      const th = pickRes.th;
      // AoE moves (e.g. Electroweb) hit BOTH active attackers.
      const aoe = !!th.aoe;
      const other = aoe ? (pickRes.target === rosterLabel(a0) ? t1 : t0) : null;
      const minA = Number(th.minPct||0);
      const maxA = Number(th.maxPct ?? th.minPct ?? 0);
      const minB = aoe ? Number((other && other.move === th.move ? other.minPct : th.minPct) || 0) : 0;
      const maxB = aoe ? Number((other && other.move === th.move ? other.maxPct : th.maxPct) || maxA) : 0;
      const displayMin = aoe ? Math.max(minA, minB) : minA;
      const displayMax = aoe ? Math.max(maxA, maxB) : maxA;
      const target = aoe ? 'BOTH' : pickRes.target;

      const p = pill(th.oneShot ? 'IN OHKO' : `IN ${formatPct(displayMin)}`, th.oneShot ? 'bad' : 'warn');
      if (prevented) p.style.opacity = '0.55';
      const why = th.chosenReason === 'ohkoChance' ? 'chosen: OHKO chance' : (th.chosenReason === 'maxDamage' ? 'chosen: max damage' : '');
      const linesTip = [];
      linesTip.push(`Incoming: ${th.move}${aoe ? " (AOE → BOTH)" : ""}`);
      linesTip.push(`Type: ${th.moveType} · ${th.category}` + (why ? ` · ${why}` : "") + (th.assumed ? " (assumed)" : ""));
      linesTip.push(`Damage: ${formatPct(displayMin)}–${formatPct(displayMax)}` + (aoe ? " (worst target)" : ""));
      if (aoe){
        const n0 = rosterLabel(a0);
        const n1 = rosterLabel(a1);
        const a0Min = (t0 && t0.move === th.move) ? Number(t0.minPct||0) : minA;
        const a0Max = (t0 && t0.move === th.move) ? Number(t0.maxPct ?? t0.minPct ?? 0) : maxA;
        const a1Min = (t1 && t1.move === th.move) ? Number(t1.minPct||0) : minB;
        const a1Max = (t1 && t1.move === th.move) ? Number(t1.maxPct ?? t1.minPct ?? 0) : maxB;
        const a0Approx = (t0 && t0.move === th.move) ? '' : '~';
        const a1Approx = (t1 && t1.move === th.move) ? '' : '~';
        linesTip.push(`${n0}: ${a0Approx}${formatPct(a0Min)}–${a0Approx}${formatPct(a0Max)}`);
        linesTip.push(`${n1}: ${a1Approx}${formatPct(a1Min)}–${a1Approx}${formatPct(a1Max)}`);
      }
              // Risk view (rolls + crit)
      if (state.settings?.inTipRisk ?? true){
        const pr = Number(th.ohkoChanceRoll||0);
        const pc = Number(th.ohkoChanceCrit||0);
        const pt = Number(th.ohkoChanceTotal||0);
        const pct = (x)=>`${Math.round((x||0)*100)}%`;
        if ((displayMax) >= 100) linesTip.push(`OHKO chance (roll): ${pct(pr)}`);
        if ((state.settings?.inTipCritWorst ?? true) && (pc>0 || pt>0)) {
        const cc = Number(th.critChance ?? (1/16));
        const ccPct = `${Math.round(cc*10000)/100}%`;
        linesTip.push(`OHKO chance (crit): ${pct(pc)} · total: ${pct(pt)} (crit ${ccPct})`);
      }
      }

      if (state.settings?.inTipCritWorst ?? true){
        // Use real crit range if available, otherwise fall back to multiplier estimate.
        let cMin = null, cMax = null;
        if (aoe){
          const c0min = (t0 && t0.move === th.move && t0.critMinPct!=null) ? Number(t0.critMinPct||0) : (th.critMinPct!=null ? Number(th.critMinPct||0) : null);
          const c0max = (t0 && t0.move === th.move && t0.critMaxPct!=null) ? Number(t0.critMaxPct||0) : (th.critMaxPct!=null ? Number(th.critMaxPct||0) : null);
          const c1min = (t1 && t1.move === th.move && t1.critMinPct!=null) ? Number(t1.critMinPct||0) : (other && other.critMinPct!=null ? Number(other.critMinPct||0) : null);
          const c1max = (t1 && t1.move === th.move && t1.critMaxPct!=null) ? Number(t1.critMaxPct||0) : (other && other.critMaxPct!=null ? Number(other.critMaxPct||0) : null);
          if (c0min!=null && c1min!=null){
            cMin = Math.max(c0min, c1min);
            cMax = Math.max(c0max||c0min, c1max||c1min);
          }
        }
        if (cMin==null && th.critMinPct!=null){
          cMin = Number(th.critMinPct||0);
          cMax = Number(th.critMaxPct ?? th.critMinPct ?? 0);
        }
        if (cMin==null){
          const mult = Number(state.settings?.critMult ?? 1.5);
          cMin = displayMin * mult;
          cMax = displayMax * mult;
        }
        linesTip.push(`Crit range: ${formatPct(cMin)}–${formatPct(cMax)} (x${Number(state.settings?.critMult ?? 1.5).toFixed(1)})`);
      }
      if (prevented) linesTip.push('NOTE: this would be prevented by your faster OHKO');
      const NL = String.fromCharCode(10);
      p.title = linesTip.join(NL);
      return el('div', {class:'muted small', style:'margin-top:6px'}, [`${defSlot.defender} incoming → ${target}: `, p]);
      return el('div', {class:'muted small', style:'margin-top:6px'}, [`${defSlot.defender} incoming → ${target}: `, p]);
    };

    const inc0 = incomingRow(left.def, left);
    const inc1 = incomingRow(right.def, right);
    if (inc0) planTable.appendChild(inc0);
    if (inc1) planTable.appendChild(inc1);

    const slowAny = (!!left.best && !attackerActsFirst(left.best)) || (!!right.best && !attackerActsFirst(right.best));
    if (slowAny){
      // Make the warning obvious near the item slots and in the plan readout.
      slowWarnInline.style.display = '';
      planTable.appendChild(el('div', {class:'danger-text small', style:'margin-top:6px'}, '⚠ Speed warning: at least one matchup has the enemy acting first (SLOW).'));
    }

    // Item suggestions (Fight plan): recommend AVAILABLE bag items only when they materially improve
    // the matchup (flip SLOW→FAST, enable OHKO, or allow a lower-prio OHKO).
    // NOTE: This is advisory only; it does not auto-apply overrides.
    const heldItemInWave = (mon)=>{
      if (!mon) return null;
      const ovr = (wp && wp.itemOverride && mon.id) ? (wp.itemOverride[mon.id] || null) : null;
      return ovr || (mon.item || null);
    };
    const canUseBagItem = (mon, itemName)=>{
      if (!mon || !itemName) return false;
      const cur = heldItemInWave(mon);
      if (cur && cur === itemName) return true;
      return availableCountWithItemOverrides(state, (wp && wp.itemOverride) ? wp.itemOverride : {}, itemName) > 0;
    };
    const candidateTipItems = (mon)=>{
      if (!mon) return [];
      const types = moveTypesFromMovePool(data, mon.movePool || []);
      const out = [];
      for (const it of tipCandidatesForTypes(types)){
        if (canUseBagItem(mon, it)) out.push(it);
      }
      return Array.from(new Set(out));
    };
    const bestMoveForMonWithItem = (att, defSlot, itemName)=>{
      if (!att || !defSlot || !itemName) return null;
      const atk = {species:(att.effectiveSpecies||att.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: att.strength?state.settings.strengthEV:state.settings.claimedEV};
      const def = {species:defSlot.defender, level:defSlot.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
      const forced = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[att.id] || null) : null;
      const pool = filterMovePoolForCalc({ppMap: state.pp || {}, monId: att.id, movePool: att.movePool || [], forcedMoveName: forced});

      const sW0 = settingsForWave(state, wp, att.id, defSlot.rowKey, defSlot.defender);
      const sW1 = {...sW0, attackerItem: itemName};
      const sWInt = applyEnemyIntimidateToSettings(sW1, att, leadIntCount);
      const sW = withWeatherSettings(sWInt, waveWeather);
      try{
        return calc.chooseBestMove({data, attacker: atk, defender: def, movePool: pool, settings: sW, tags: defSlot.tags||[]}).best;
      }catch(e){
        return null;
      }
    };
    const itemTipsForMatchup = (att, defSlot, baseBest)=>{
      if (!att || !defSlot || !baseBest) return [];
      const baseFast = attackerActsFirst(baseBest);
      const tips = [];
      for (const it of candidateTipItems(att)){
        const b = bestMoveForMonWithItem(att, defSlot, it);
        if (!b) continue;
        const fast = attackerActsFirst(b);
        const gainFast = (!baseFast && fast);
        const gainOhko = (!baseBest.oneShot && !!b.oneShot);
        const gainPrio = (Number.isFinite(Number(b.prio)) && Number.isFinite(Number(baseBest.prio)))
          ? (Number(b.prio) < Number(baseBest.prio) && (!!b.oneShot || !baseBest.oneShot))
          : false;
        if (!gainFast && !gainOhko && !gainPrio) continue;
        tips.push({item: it, best: b, gainFast, gainOhko, gainPrio});
      }
      tips.sort((a,b)=>{
        const ao = a.gainFast?1:0; const bo = b.gainFast?1:0;
        if (ao !== bo) return bo-ao;
        const ah = a.gainOhko?1:0; const bh = b.gainOhko?1:0;
        if (ah !== bh) return bh-ah;
        const ap = a.gainPrio?1:0; const bp = b.gainPrio?1:0;
        if (ap !== bp) return bp-ap;
        const apr = Number(a.best?.prio ?? 9);
        const bpr = Number(b.best?.prio ?? 9);
        if (apr !== bpr) return apr-bpr;
        return Math.abs(Number(a.best?.minPct ?? 0) - 100) - Math.abs(Number(b.best?.minPct ?? 0) - 100);
      });
      return tips.slice(0, 2);
    };



    // Charm suggestions (Fight plan): recommend applying Strength/Evo charms if they materially improve
    // the matchup (flip SLOW→FAST, enable OHKO, or allow a lower-prio OHKO).
    // These can be worth showing even when none are currently in the Bag, because you can usually buy them.
    const canConsiderCharm = (mon, kind)=>{
      if (!mon) return false;
      const base = mon.baseSpecies || mon.effectiveSpecies || '';
      if (isStarterSpecies(base)) return false;
      if (kind === 'Strength Charm') return !mon.strength;
      if (kind === 'Evo Charm') return !mon.evo;
      return false;
    };

    const cloneMonForCharm = (mon, kind)=>{
      if (!mon) return null;
      const c = { ...mon };
      c.movePool = (mon.movePool||[]).map(m=>({ ...m }));
      if (kind === 'Strength Charm') c.strength = true;
      if (kind === 'Evo Charm') c.evo = true;
      try{ applyCharmRulesSync(data, state, c); }catch(e){}
      return c;
    };

    const bestMoveForMonWithCharm = (att, defSlot, kind)=>{
      if (!att || !defSlot || !kind) return null;
      const hyp = cloneMonForCharm(att, kind);
      if (!hyp) return null;
      if (kind === 'Evo Charm'){
        const eff = hyp.effectiveSpecies || hyp.baseSpecies;
        const curEff = att.effectiveSpecies || att.baseSpecies;
        if (!eff || eff === curEff) return null;
      }

      const atk = {
        species: (hyp.effectiveSpecies||hyp.baseSpecies),
        level: state.settings.claimedLevel,
        ivAll: state.settings.claimedIV,
        evAll: hyp.strength ? state.settings.strengthEV : state.settings.claimedEV,
      };
      const def = {
        species: defSlot.defender,
        level: defSlot.level,
        ivAll: state.settings.wildIV,
        evAll: state.settings.wildEV,
      };

      const forced = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[att.id] || null) : null;
      const pool = filterMovePoolForCalc({ppMap: state.pp || {}, monId: att.id, movePool: hyp.movePool || [], forcedMoveName: forced});

      const sW0 = settingsForWave(state, wp, att.id, defSlot.rowKey, defSlot.defender);
      const sWInt = applyEnemyIntimidateToSettings(sW0, hyp, leadIntCount);
      const sW = withWeatherSettings(sWInt, waveWeather);
      try{
        return calc.chooseBestMove({data, attacker: atk, defender: def, movePool: pool, settings: sW, tags: defSlot.tags||[]}).best;
      }catch(e){
        return null;
      }
    };

    const charmTipsForMatchup = (att, defSlot, baseBest)=>{
      if (!att || !defSlot || !baseBest) return [];
      const baseFast = attackerActsFirst(baseBest);
      const tips = [];
      for (const kind of ['Strength Charm','Evo Charm']){
        if (!canConsiderCharm(att, kind)) continue;
        const b = bestMoveForMonWithCharm(att, defSlot, kind);
        if (!b) continue;
        const fast = attackerActsFirst(b);
        const gainFast = (!baseFast && fast);
        const gainOhko = (!baseBest.oneShot && !!b.oneShot);
        const gainPrio = (Number.isFinite(Number(b.prio)) && Number.isFinite(Number(baseBest.prio)))
          ? (Number(b.prio) < Number(baseBest.prio) && (!!b.oneShot || !baseBest.oneShot))
          : false;
        if (!gainFast && !gainOhko && !gainPrio) continue;
        const have = availableCount(state, kind) > 0;
        tips.push({kind, best:b, gainFast, gainOhko, gainPrio, have});
      }
      tips.sort((a,b)=>{
        const ao = a.gainFast?1:0; const bo = b.gainFast?1:0;
        if (ao !== bo) return bo-ao;
        const ah = a.gainOhko?1:0; const bh = b.gainOhko?1:0;
        if (ah !== bh) return bh-ah;
        const ap = a.gainPrio?1:0; const bp = b.gainPrio?1:0;
        if (ap !== bp) return bp-ap;
        const apr = Number(a.best?.prio ?? 9);
        const bpr = Number(b.best?.prio ?? 9);
        if (apr !== bpr) return apr-bpr;
        return Math.abs(Number(a.best?.minPct ?? 0) - 100) - Math.abs(Number(b.best?.minPct ?? 0) - 100);
      });
      return tips.slice(0, 2);
    };
    const tipsLeft = itemTipsForMatchup(left.att, left.def, left.best);
    const tipsRight = itemTipsForMatchup(right.att, right.def, right.best);
    const fmtTip = (t)=>{
      const flags = [t.gainFast ? 'FAST' : null, t.gainOhko ? 'OHKO' : null, t.gainPrio ? 'lower prio' : null].filter(Boolean);
      const fx = flags.length ? ` (${flags.join(', ')})` : '';
      return `${t.item}${fx} → ${t.best?.move||'—'} (P${t.best?.prio||'?'} ${formatPct(t.best?.minPct||0)})`;
    };
    const tipLines = [];
    if (tipsLeft.length) tipLines.push(`${rosterLabel(left.att)} vs ${left.def.defender}: ${tipsLeft.map(fmtTip).join(' · ')}`);
    if (tipsRight.length) tipLines.push(`${rosterLabel(right.att)} vs ${right.def.defender}: ${tipsRight.map(fmtTip).join(' · ')}`);
    if (tipLines.length){
      itemWarnInline.style.display = '';
      itemWarnInline.title = `Better solutions with items:\n${tipLines.join('\n')}`;
      planTable.appendChild(el('div', {class:'danger-text small', style:'margin-top:8px'}, `⚠ Better with items: ${tipLines.join(' · ')}`));
    }

    const charmLeft = charmTipsForMatchup(left.att, left.def, left.best);
    const charmRight = charmTipsForMatchup(right.att, right.def, right.best);

    const fmtCharm = (t)=>{
      const flags = [t.gainFast ? 'FAST' : null, t.gainOhko ? 'OHKO' : null, t.gainPrio ? 'lower prio' : null].filter(Boolean);
      const fx = flags.length ? ` (${flags.join(', ')})` : '';
      const buy = t.have ? '' : ' (buy)';
      return `${t.kind}${buy}${fx} → ${t.best?.move||'—'} (P${t.best?.prio||'?'} ${formatPct(t.best?.minPct||0)})`;
    };

    const charmLines = [];
    if (charmLeft.length) charmLines.push(`${rosterLabel(left.att)} vs ${left.def.defender}: ${charmLeft.map(fmtCharm).join(' · ')}`);
    if (charmRight.length) charmLines.push(`${rosterLabel(right.att)} vs ${right.def.defender}: ${charmRight.map(fmtCharm).join(' · ')}`);
    if (charmLines.length){
      charmWarnInline.style.display = '';
      charmWarnInline.title = `Better solutions with charms:\n${charmLines.join('\n')}`;
      planTable.appendChild(el('div', {class:'danger-text small', style:'margin-top:8px'}, `⚠ Better with charms: ${charmLines.join(' · ')}`));
    }

    // Bench coverage
    const bench = picked.slice(2).map(x=>x.slot);
    if (bench.length){
      const benchLines = [];
      for (const ds of bench){
        const am = bestMoveForMon(a0, ds, ppBudget);
        const bm = bestMoveForMon(a1, ds, ppBudget);
        const pick = (am && am.oneShot && (!bm || !bm.oneShot || (am.prio??9) <= (bm.prio??9)))
          ? {monId: a0.id, who:rosterLabel(a0), m:am}
          : {monId: a1.id, who:rosterLabel(a1), m:bm};
        // Reserve the displayed bench pick so subsequent duplicates reflect PP.
        reservePPUse(pick.monId, pick.m?.move);
        benchLines.push(`${ds.defender}: ${pick.who} ${pick.m?.move||'—'} (P${pick.m?.prio||'?'} ${formatPct(pick.m?.minPct||0)})`);
      }
      planTable.appendChild(el('div', {class:'muted small', style:'margin-top:8px'}, `Bench: ${benchLines.join(' · ')}`));
    }
  } else {
    planTable.appendChild(el('div', {class:'muted small'}, 'Select 2 enemies and ensure 2 active starters are available to build a lead-pair plan.'));
  }

  planEl.appendChild(el('div', {class:'muted small'}, `Starters have OHKO coverage on ${startersClear}/${allDef.length} selected defenders.`));
  planEl.appendChild(planTable);

	    // Outcome preview (always uses the REAL battle engine logic):
	    // This makes Auto behavior explainable and ensures the Fight plan display matches
	    // what will happen when you click Fight.
	    const outcomePreviewEl = (()=>{
	      if (!a0 || !a1) return null;
	      const defs = (wp.defenders || []).slice(0, defLimit);
	      if (defs.length < 2) return null;
	      const aId = a0.id;
	      const bId = a1.id;
	      if (!aId || !bId || String(aId) === String(bId)) return null;

	      const ovr = wp.attackMoveOverride || {};
    const iovr = wp.itemOverride || {};
	      const okeys = Object.keys(ovr).slice().sort((x,y)=>String(x).localeCompare(String(y)));
	      const oBits = okeys.map(k => `${k}:${ovr[k]}`).join('|');
    const ikeys = Object.keys(iovr).slice().sort((x,y)=>String(x).localeCompare(String(y)));
    const iBits = ikeys.map(k => `${k}:${iovr[k]}`).join('|');

	      const ppSig = (id)=>{
	        const mon = byId(state.roster||[], id);
	        const moves = (mon?.movePool||[]).filter(m=>m && m.use !== false && m.name).map(m=>m.name).slice().sort((x,y)=>String(x).localeCompare(String(y)));
	        const bits = moves.map(mn => String(state.pp?.[id]?.[mn]?.cur ?? DEFAULT_MOVE_PP)).join('/');
	        return `${id}:${bits}`;
	      };

	      const sig = [
	        `wave:${waveKey}|phase:${phase}|defLimit:${defLimit}`,
	        `defs:${defs.join(',')}`,
	        `atk:${aId},${bId}`,
	        `ovr:${oBits}`,
      `iovr:${iBits}`,
	        `ff:${state.settings?.allowFriendlyFire?1:0}`,
	        `stu:${state.settings?.applySTU?1:0}`,
	        `stuaoe:${state.settings?.sturdyAoeSolve?1:0}`,
	        `pp:${ppSig(aId)}|${ppSig(bId)}`,
	      ].join('~');

	      // Tiny LRU-ish cap.
	      if (FIGHT_OUTCOME_PREVIEW_CACHE.size > 250) FIGHT_OUTCOME_PREVIEW_CACHE.clear();
	      const cached = FIGHT_OUTCOME_PREVIEW_CACHE.get(sig);
	      const preview = cached || (()=>{
	        const ra = byId(state.roster||[], aId);
	        const rb = byId(state.roster||[], bId);
	        if (!ra || !rb) return null;

	        // Minimal isolated state for preview (no PP / log mutation on real state).
	        const sPrev = {
	          settings: state.settings,
	          roster: [JSON.parse(JSON.stringify(ra)), JSON.parse(JSON.stringify(rb))],
	          pp: JSON.parse(JSON.stringify(state.pp || {})),
	          wavePlans: {},
	          battles: {},
	        };

	        // Ensure PP exists for the two attackers and snapshot.
	        const aMon = byId(sPrev.roster, aId);
	        const bMon = byId(sPrev.roster, bId);
	        ensurePPForRosterMon(sPrev, aMon);
	        ensurePPForRosterMon(sPrev, bMon);
	        const ppBefore = {
	          [aId]: JSON.parse(JSON.stringify(sPrev.pp?.[aId] || {})),
	          [bId]: JSON.parse(JSON.stringify(sPrev.pp?.[bId] || {})),
	        };

	        const tmpKey = `${waveKey}__preview_${Date.now()}_${Math.random().toString(16).slice(2)}`;
	        sPrev.wavePlans[tmpKey] = {
	          ...(wp||{}),
	          defenders: defs.slice(),
	          defenderStart: defs.slice(0,2),
	          attackerOrder: [aId,bId],
	          attackerStart: [aId,bId],
	        };

	        const b = initBattleForWave({data, calc, state:sPrev, waveKey: tmpKey, slots});
	        if (!b){
	          delete sPrev.wavePlans[tmpKey];
	          return null;
	        }

	        let guard = 0;
	        while (guard++ < 60 && sPrev.battles?.[tmpKey]?.status === 'active'){
	          const bb = sPrev.battles[tmpKey];
	          if (bb.pending){
	            if (bb.pending.side === 'def'){
	              const choice = bb.def.bench[0];
	              if (choice) chooseReinforcement(sPrev, tmpKey, 'def', bb.pending.slotIndex, choice);
	              else bb.pending = null;
	            } else {
	              const choice = bb.atk.bench[0];
	              if (choice) chooseReinforcement(sPrev, tmpKey, 'atk', bb.pending.slotIndex, choice);
	              else bb.pending = null;
	            }
	            continue;
	          }
	          stepBattleTurn({data, calc, state:sPrev, waveKey: tmpKey, slots});
	        }

	        const bb = sPrev.battles?.[tmpKey];
	        const status = bb?.status || 'active';
	        const turnCount = Number(bb?.turnCount || 0);
	        const logLines = (bb?.log || []).slice(1); // skip "Fight started"
	        const atkHist = (bb?.history || []).filter(x=>x.side==='atk');
	        const prioAvg = atkHist.length ? (atkHist.reduce((sum,x)=>sum + (Number(x.prio)||9), 0) / atkHist.length) : 9;
	        const prioWorst = atkHist.length ? (atkHist.reduce((mx,x)=>Math.max(mx, (Number(x.prio)||9)), 0)) : 9;

	        const ppDelta = [];
	        for (const monId of [aId,bId]){
	          const before = ppBefore[monId] || {};
	          const after = sPrev.pp?.[monId] || {};
	          for (const [mv, obj] of Object.entries(after)){
	            const prevCur = Number(before?.[mv]?.cur ?? obj.cur ?? DEFAULT_MOVE_PP);
	            const nextCur = Number(obj.cur ?? DEFAULT_MOVE_PP);
	            if (prevCur !== nextCur) ppDelta.push({monId, move: mv, prevCur, nextCur});
	          }
	        }

	        delete sPrev.battles[tmpKey];
	        delete sPrev.wavePlans[tmpKey];

	        return {status, turnCount, prioAvg, prioWorst, logLines, ppDelta, attackers:[aId,bId]};
	      })();

	      if (!cached && preview) FIGHT_OUTCOME_PREVIEW_CACHE.set(sig, preview);
	      if (!preview) return null;

	      const statusKind = (preview.status === 'won') ? 'good' : (preview.status === 'lost' ? 'bad' : 'warn');
	      const statusTxt = (preview.status === 'won') ? 'WON' : (preview.status === 'lost' ? 'LOST' : String(preview.status).toUpperCase());
	      const turnsTxt = preview.turnCount ? `${preview.turnCount} turn${preview.turnCount===1?'':'s'}` : '—';

	      const used = (preview.ppDelta||[])
	        .map(d=>({
	          ...d,
	          used: Number(d.prevCur||0) - Number(d.nextCur||0),
	          name: rosterLabel(byId(state.roster||[], d.monId) || {baseSpecies:String(d.monId)}),
	        }))
	        .filter(d => d.used > 0)
	        .sort((a,b)=>String(a.name).localeCompare(String(b.name)) || String(a.move).localeCompare(String(b.move)));
	      const ppTxt = used.length ? used.map(d=>`${d.name} ${d.move} -${d.used}`).join(' · ') : '—';

	      const summaryRow = el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06)'}, [
	        el('div', {}, [pill(statusTxt, statusKind)]),
	        el('div', {class:'muted small'}, `Outcome preview: ${turnsTxt} · prioØ ${formatPrioAvg(preview.prioAvg)} · worst P${formatPrioAvg(preview.prioWorst)} · PP: ${ppTxt}`),
	      ]);

	      const logBox = el('div', {class:'preview-log'}, (preview.logLines||[]).map(l=>el('div', {}, l)));
	      const details = el('details', {style:'margin-top:8px'}, [
	        el('summary', {class:'muted small'}, 'Show battle log'),
	        logBox,
	      ]);

	      return el('div', {class:'plan-outcome'}, [summaryRow, details]);
	    })();
	    if (outcomePreviewEl) planEl.appendChild(outcomePreviewEl);

	    // ---------------- Fight controls + fight log (compact) ----------------
	    // This replaces the older "Wave fights" tracker. It models the 4 in-game fights for this wave.
	    // Entries are undoable individually (claims + PP deltas).
	    const baseCache = state.baseCache || {};
	    const baseByRowKey = (()=>{
	      const m = new Map();
	      for (const x of (data.calcSlots||[])){
	        const rk = String(x.rowKey || x.key || '');
	        if (!rk) continue;
	        const sp = fixName(x.defender || x.species || x.name || '');
	        if (!sp) continue;
	        m.set(rk, pokeApi.baseOfSync(sp, baseCache));
	      }
	      return m;
	    })();
	    const baseStillClearedAnywhere = (s, base)=>{
	      for (const rk of Object.keys(s.cleared||{})){
	        if (!s.cleared[rk]) continue;
	        const b = baseByRowKey.get(baseDefKey(rk)) || baseByRowKey.get(String(rk));
	        if (b === base) return true;
	      }
	      return false;
	    };

	    const getFightLog = ()=> (store.getState().wavePlans?.[waveKey]?.fightLog || []);

	    const ensurePP = (s, monId)=>{
	      const rm = byId(s.roster||[], monId);
	      if (!rm) return;
	      ensurePPForRosterMon(s, rm);
	    };

	    const applyPPCost = (s, monId, moveName)=>{
	      if (!monId || !moveName) return null;
	      ensurePP(s, monId);
	      s.pp = s.pp || {};
	      s.pp[monId] = s.pp[monId] || {};
	      const entry = s.pp[monId][moveName];
	      if (!entry) return null;
	      const prevCur = Number(entry.cur ?? entry.max ?? DEFAULT_MOVE_PP);
	      entry.cur = Math.max(0, prevCur - 1);
	      return {monId, move: moveName, prevCur};
	    };

	    const pickEnemyThreat = (s, wpLocal, defSlot, att0, att1)=>{
	      const wLocal = inferBattleWeatherFromLeads(data, s, [att0, att1].filter(Boolean), [defSlot]);
	      const t0 = enemyThreatForMatchup(data, s, wpLocal, att0, defSlot, {weather: wLocal}) || assumedEnemyThreatForMatchup(data, s, wpLocal, att0, defSlot, {weather: wLocal});
	      const t1 = enemyThreatForMatchup(data, s, wpLocal, att1, defSlot, {weather: wLocal}) || assumedEnemyThreatForMatchup(data, s, wpLocal, att1, defSlot, {weather: wLocal});
	      if (!t0 && !t1) return null;
	      if (t0 && !t1) return {th:t0, target:'A'};
	      if (!t0 && t1) return {th:t1, target:'B'};
	      // Prefer higher OHKO chance, else higher damage.
	      const c0 = Number(t0.ohkoChance||0);
	      const c1 = Number(t1.ohkoChance||0);
	      if (c0 !== c1) return c0 > c1 ? {th:t0, target:'A'} : {th:t1, target:'B'};
	      const d0 = Number(t0.minPct||0);
	      const d1 = Number(t1.minPct||0);
	      if (d0 !== d1) return d0 > d1 ? {th:t0, target:'A'} : {th:t1, target:'B'};
	      return {th:t0, target:'A'};
	    };

	    const makeFightEntry = (s, wpLocal, aId, bId, defKeys)=>{
	      const aMon = byId(s.roster||[], aId);
	      const bMon = byId(s.roster||[], bId);
	      const defs = (defKeys||[]).filter(Boolean);
	      if (!aMon || !bMon) return null;
	      if (String(aId) === String(bId)) return null;
	      if (defs.length < 2) return null;

	      // Snapshot roster HP% before the sim (for Life Orb / recoil persistence).
	      // NOTE: This is a LOG-only side effect (manual Fight logging), not a preview mechanic.
	      const hpBeforeRoster = {};
	      for (const id of [aId, bId]){
	        const rm = byId(s.roster||[], id);
	        const prev = rm?.mods?.hpPct;
	        hpBeforeRoster[id] = (prev === undefined || prev === null) ? null : Number(prev);
	      }

	      // Seed PP for the two attackers and snapshot before.
	      ensurePPForRosterMon(s, aMon);
	      ensurePPForRosterMon(s, bMon);
	      const ppBefore = {
	        [aId]: JSON.parse(JSON.stringify(s.pp?.[aId] || {})),
	        [bId]: JSON.parse(JSON.stringify(s.pp?.[bId] || {})),
	      };

	      const tmpKey = `${waveKey}__log_${Date.now()}_${Math.random().toString(16).slice(2)}`;
	      s.wavePlans = s.wavePlans || {};
	      s.battles = s.battles || {};
	      // Temporary wave plan used only for deterministic simulation.
	      s.wavePlans[tmpKey] = {
	        ...(wpLocal||{}),
	        defenders: defs.slice(),
	        defenderStart: defs.slice(0,2),
	        attackerOrder: [aId,bId],
	        attackerStart: [aId,bId],
	      };

	      const b = initBattleForWave({data, calc, state:s, waveKey: tmpKey, slots});
	      if (!b){
	        delete s.wavePlans[tmpKey];
	        return null;
	      }

	      // Auto-run until won/lost, auto-picking reinforcements in the given order.
	      let guard = 0;
	      while (guard++ < 60 && s.battles?.[tmpKey]?.status === 'active'){
	        const bb = s.battles[tmpKey];
	        if (bb.pending){
	          if (bb.pending.side === 'def'){
	            const choice = bb.def.bench[0];
	            if (choice) chooseReinforcement(s, tmpKey, 'def', bb.pending.slotIndex, choice);
	            else bb.pending = null;
	          } else {
	            const choice = bb.atk.bench[0];
	            if (choice) chooseReinforcement(s, tmpKey, 'atk', bb.pending.slotIndex, choice);
	            else bb.pending = null;
	          }
	          continue;
	        }
	        stepBattleTurn({data, calc, state:s, waveKey: tmpKey, slots});
	      }

	      const bb = s.battles?.[tmpKey];
	      const status = bb?.status || 'active';
	      const logLines = (bb?.log || []).slice(1); // skip "Fight started"
	      const atkHist = (bb?.history || []).filter(x=>x.side==='atk');
	      const defHist = (bb?.history || []).filter(x=>x.side==='def');
	      const defActs = defHist.length;
		      const prioAvg = atkHist.length ? (atkHist.reduce((sum,x)=>sum + (Number(x.prio)||9), 0) / atkHist.length) : 9;
		      const prioWorst = atkHist.length ? (atkHist.reduce((mx,x)=>Math.max(mx, (Number(x.prio)||9)), 0)) : 9;
		      const turnCount = Number(bb?.turnCount || 0);

	      // Consumables across fights/waves:
	      // - Battle sim consumes Gems and Air Balloon in-battle (runtime-only).
	      // - When a fight is LOGGED, we debit the Bag and remove the consumed held item assignment.
	      const bagDelta = [];
	      const consumedItems = [];
	      const consumed = Array.isArray(bb?.consumed) ? bb.consumed.slice() : [];
	      if (consumed.length){
	        s.bag = s.bag || {};
	        const waveOvr = (wpLocal && typeof wpLocal.itemOverride === 'object') ? wpLocal.itemOverride : null;
	        for (const c of consumed){
	          const monId = c?.attackerId;
	          const item = c?.item;
	          if (!monId || !item) continue;

	          const prevCount = Number(s.bag?.[item] || 0);
	          const nextCount = Math.max(0, prevCount - 1);
	          s.bag[item] = nextCount;
	          bagDelta.push({item, prev: prevCount, next: nextCount});

	          // Remove the consumed item from the holder so subsequent fights can't reuse it.
	          let source = null;
	          let prevOverride = null;
	          let prevRosterItem = null;
	          if (waveOvr && waveOvr[monId] === item){
	            source = 'waveOverride';
	            prevOverride = item;
	            delete waveOvr[monId];
	          } else {
	            const rm = byId(s.roster||[], monId);
	            if (rm && rm.item === item){
	              source = 'roster';
	              prevRosterItem = item;
	              rm.item = null;
	            }
	          }
	          consumedItems.push({monId, item, source, prevOverride, prevRosterItem});
	        }
	        if (waveOvr && !Object.keys(waveOvr).length){
	          delete wpLocal.itemOverride;
	        }
	      }

	      // Compute ppDelta based on snapshot.
	      const ppDelta = [];
	      for (const monId of [aId,bId]){
	        const before = ppBefore[monId] || {};
	        const after = s.pp?.[monId] || {};
	        for (const [mv, obj] of Object.entries(after)){
	          const prevCur = Number(before?.[mv]?.cur ?? obj.cur ?? DEFAULT_MOVE_PP);
	          const nextCur = Number(obj.cur ?? DEFAULT_MOVE_PP);
	          if (prevCur !== nextCur){
	            ppDelta.push({monId, move: mv, prevCur, nextCur});
	          }
	        }
	      }

      // Capture item overrides (UI metadata only). Only store explicit overrides.
      const itemOverride = {};
      const ovr = (wpLocal && typeof wpLocal.itemOverride === 'object') ? wpLocal.itemOverride : null;
      if (ovr && ovr[aId]) itemOverride[aId] = ovr[aId];
      if (ovr && ovr[bId]) itemOverride[bId] = ovr[bId];

	      // Claims (applied when entry is pushed): all selected defenders by base rowKey.
	      const claimRowKeys = Array.from(new Set(defs.map(k=>baseDefKey(k))));
	      const claimBases = claimRowKeys.map(rk=>{
	        const sl = slotByKey2.get(rk);
	        return sl ? pokeApi.baseOfSync(sl.defender, baseCache) : rk;
	      });

	      // Persist attacker HP% back to roster (log-only) and compute hpDelta for undo.
	      const hpDelta = [];
	      for (const id of [aId, bId]){
	        const rm = byId(s.roster||[], id);
	        if (!rm) continue;
	        const prevHp = hpBeforeRoster[id];
	        const nextHp = (bb && bb.hpAtk && bb.hpAtk[id] != null) ? Number(bb.hpAtk[id]) : null;
	        if (Number.isFinite(nextHp)){
	          rm.mods = {...(rm.mods||{})};
	          rm.mods.hpPct = Math.max(0, Math.min(100, Math.round(nextHp)));
	          hpDelta.push({monId: id, prevHpPct: prevHp, nextHpPct: rm.mods.hpPct});
	        }
	      }

	      // Cleanup temp battle
	      delete s.battles[tmpKey];
	      delete s.wavePlans[tmpKey];

	      const lines = [
	        `ATTACKERS: ${rosterLabel(aMon)} + ${rosterLabel(bMon)} · DEFENDERS: ${defs.map((rk,i)=>`#${i+1} ${(slotByKey2.get(rk)?.defender || rk)}`).join(' · ')}`,
	        ...logLines,
	        status === 'won' ? 'Result: WON' : (status === 'lost' ? 'Result: LOST' : `Result: ${status}`),
	      ];

	      return {
	        id: `f${Date.now()}_${Math.random().toString(16).slice(2)}`,
	        ts: Date.now(),
	        attackers: [aId,bId],
	        defenders: defs.slice(),
	        prioAvg,
		        prioWorst,
	        defActs,
		        turnCount,
		        status,
	        lines,
	        claimRowKeys,
	        claimBases,
	        ppDelta,
	        hpDelta,
	        itemOverride,
	        bagDelta,
	        consumedItems,
	      };
	    };

	    const undoEntryById = (entryId)=>{
	      store.update(s=>{
	        const w = s.wavePlans?.[waveKey];
	        if (!w || !Array.isArray(w.fightLog)) return;
	        const idx = w.fightLog.findIndex(e=>e.id===entryId);
	        if (idx < 0) return;
	        const entry = w.fightLog[idx];
	        w.fightLog.splice(idx,1);

	        // Restore Bag + consumed item assignments (best-effort; undo is intended newest-first).
	        for (const d of (entry.bagDelta||[]).slice().reverse()){
	          if (!d || !d.item) continue;
	          s.bag = s.bag || {};
	          const cur = Number(s.bag?.[d.item] || 0);
	          const prev = Number(d.prev || 0);
	          const next = Number(d.next || 0);
	          // Reverse only the logged delta so later Bag edits (shop buys/sells) remain intact.
	          const delta = prev - next;
	          s.bag[d.item] = Math.max(0, cur + (Number.isFinite(delta) ? delta : 0));
	        }
	        for (const c of (entry.consumedItems||[]).slice().reverse()){
	          if (!c || !c.monId || !c.item) continue;
	          if (c.source === 'waveOverride'){
	            w.itemOverride = (w.itemOverride && typeof w.itemOverride === 'object') ? w.itemOverride : {};
	            w.itemOverride[c.monId] = c.item;
	          } else if (c.source === 'roster'){
	            const rm = byId(s.roster||[], c.monId);
	            if (rm) rm.item = c.item;
	          }
	        }
	        if (w.itemOverride && typeof w.itemOverride === 'object' && !Object.keys(w.itemOverride).length){
	          delete w.itemOverride;
	        }
	
	        // Restore PP.
	        for (const d of (entry.ppDelta||[])){
	          if (!s.pp?.[d.monId]?.[d.move]) continue;
	          s.pp[d.monId][d.move].cur = d.prevCur;
	        }

	        // Restore roster HP% (Life Orb / recoil) for logged fights.
	        for (const d of (entry.hpDelta||[])){
	          const rm = byId(s.roster||[], d.monId);
	          if (!rm) continue;
	          if (d.prevHpPct === null || d.prevHpPct === undefined){
	            if (rm.mods){
	              rm.mods = {...rm.mods};
	              delete rm.mods.hpPct;
	              if (!Object.keys(rm.mods).length) delete rm.mods;
	            }
	          } else {
	            rm.mods = {...(rm.mods||{})};
	            rm.mods.hpPct = Number(d.prevHpPct);
	          }
	        }
	
	        // Revert claims for this entry if no other remaining log entry still claims them.
	        const stillClaimed = new Set();
	        for (const e of (w.fightLog||[])) for (const rk of (e.claimRowKeys||[])) stillClaimed.add(rk);
	
	        const affectedBases = new Set(entry.claimBases||[]);
	        for (const rk of (entry.claimRowKeys||[])){
	          if (stillClaimed.has(rk)) continue;
	          if (s.cleared) delete s.cleared[rk];
	        }
	        for (const b of affectedBases){
	          if (!baseStillClearedAnywhere(s, b)){
	            if (s.unlocked) delete s.unlocked[b];
	          }
	        }
	      });
	    };

	    const clearAllLog = ()=>{
	      const ids = (getFightLog()||[]).map(e=>e.id).slice().reverse();
	      // Undo all entries newest-first.
	      for (const id of ids) undoEntryById(id);
	    };

	    // Manual fight logging action (invoked by the primary Fight button in the Fight plan).
	    const undoBtn = el('button', {class:'btn-mini btn-undo'}, '↩ Undo');
	    const auto4Btn = el('button', {class:'btn-mini'}, 'Auto x4');
	    const countLabel = el('div', {class:'muted small', style:'margin-right:auto'}, `Fights: ${(wp.fightLog||[]).length}/4`);
	
	    const pushEntry = (s, w, entry)=>{
	      if (!entry) return;
	      w.fightLog = Array.isArray(w.fightLog) ? w.fightLog : [];
	      if (w.fightLog.length >= 4) return; // enforce 4 fights
	      // PP is already spent by the battle sim that produced this entry.

	      // Apply claims.
	      s.unlocked = s.unlocked || {};
	      s.cleared = s.cleared || {};
	      for (const b of (entry.claimBases||[])) s.unlocked[b] = true;
	      for (const rk of (entry.claimRowKeys||[])) s.cleared[rk] = true;

	      // Add to bottom (oldest first).
	      w.fightLog.push(entry);

      // If this wave just completed, check phase completion rewards.
      if (w.fightLog.length >= 4){
        maybeAwardPhaseReward(data, s, phase);
      }
	    };

	    const runManualFight = ()=>{
	      const cur = store.getState();
	      const w = cur.wavePlans?.[waveKey];
	      const logLen = (w?.fightLog||[]).length;
	      if (logLen >= 4){
	        alert('Already have 4 fights logged. Undo one to re-run.');
	        return;
	      }
	      const defs = (w?.defenders||[]).slice(0, defLimit);
	      if (defs.length < 2){
	        alert('Select at least 2 enemies first.');
	        return;
	      }
	      const atks = (w?.attackerStart||w?.attackerOrder||[]).slice(0,2);
	      if (atks.length < 2){
	        alert('Need 2 starters.');
	        return;
	      }
	      store.update(s=>{
	        const ww = s.wavePlans?.[waveKey];
	        if (!ww) return;
	        ensureWavePlan(data, s, waveKey, slots);
	        const entry = makeFightEntry(s, ww, atks[0], atks[1], defs);
	        pushEntry(s, ww, entry);
	      });
	    };

    primaryFightBtn.addEventListener('click', runManualFight);

	    undoBtn.addEventListener('click', ()=>{
	      const w = store.getState().wavePlans?.[waveKey];
	      const list = (w?.fightLog||[]);
	      const last = list.length ? list[list.length-1] : null;
	      if (last) undoEntryById(last.id);
	    });

	    // Auto x4 uses the evolved solver logic (ported from previous full solve) and then simulates 4 fights.
	    auto4Btn.addEventListener('click', ()=>{
	      const st = store.getState();
	      const act = (st.roster||[]).filter(r=>r.active);
	      if (act.length < 2){
	        alert('Need at least 2 active roster mons.');
	        return;
	      }

	      const curW = st.wavePlans?.[waveKey] || {};

	      // Compute PP signature as if this wave's current fight log was undone (so repeated clicks can cycle alts).
	      const ppAfterClear = (()=>{
	        // IMPORTANT: undo deltas newest-first, otherwise repeated usage of the same move
	        // across multiple fights will not rewind back to the true baseline.
	        const pp = JSON.parse(JSON.stringify(st.pp || {}));
	        const log = (curW.fightLog || []).slice().reverse();
	        for (const e of log){
	          for (const d of (e.ppDelta || [])){
	            if (!pp?.[d.monId]?.[d.move]) continue;
	            pp[d.monId][d.move].cur = d.prevCur;
	          }
	        }
	        return pp;
	      })();

	      const signature = (()=>{
	        const parts = [];
	        parts.push(`wave:${waveKey}|phase:${phase}|defLimit:${defLimit}`);
		        parts.push(`altslack:${Number(st.settings?.autoAltAvgSlack ?? 0)}`);
	        parts.push(`altlim:${Number(st.settings?.variationLimit ?? 8)}`);
	        parts.push(`altcap:${Number(st.settings?.variationGenCap ?? 5000)}`);
      const ovr = curW.attackMoveOverride || {};
      const iovr = curW.itemOverride || {};
      const okeys = Object.keys(ovr).slice().sort((a,b)=>String(a).localeCompare(String(b)));
      const oBits = okeys.map(k => `${k}:${ovr[k]}`).join('|');
      const ikeys = Object.keys(iovr).slice().sort((a,b)=>String(a).localeCompare(String(b)));
      const iBits = ikeys.map(k => `${k}:${iovr[k]}`).join('|');
      parts.push(`ovr:${oBits}`);
      parts.push(`iovr:${iBits}`);
      parts.push(`useitems:${st.settings?.autoSolveUseItems?1:0}`);
      parts.push(`optitems:${st.settings?.autoSolveOptimizeItems?1:0}`);
      parts.push(`deep:${st.settings?.autoSolveDeepSearch?1:0}`);
      parts.push(`ff:${st.settings?.allowFriendlyFire?1:0}`);
      const bag = st.bag || {};
      const bKeys = Object.keys(bag).slice().sort((a,b)=>String(a).localeCompare(String(b)));
      const bBits = bKeys.map(k => `${k}:${bag[k]}`).join('|');
      parts.push(`bag:${bBits}`);
	        const ids = act.map(r=>r.id).slice().sort((a,b)=>String(a).localeCompare(String(b)));
	        for (const id of ids){
	          const r = byId(st.roster||[], id);
	          if (!r) continue;
	          const sp = (r.effectiveSpecies||r.baseSpecies||'');
	          const item = r.item || '';
	          const evo = r.evo ? 1 : 0;
	          const str = r.strength ? 1 : 0;
	          const moves = (r.movePool||[])
	            .filter(m=>m && m.use !== false && m.name)
	            .map(m=>m.name)
	            .slice().sort((a,b)=>String(a).localeCompare(String(b)));
	          const ppBits = moves.map(mn => String(ppAfterClear?.[id]?.[mn]?.cur ?? DEFAULT_MOVE_PP)).join('/');
	          parts.push(`${id}:${sp}:${item}:${evo}:${str}:${moves.join('|')}:${ppBits}`);
	        }
	        return parts.join('~');
	      })();

	      const reuse = (curW.solve && curW.solve.signature === signature && Array.isArray(curW.solve.alts) && curW.solve.alts.length);
	      let alts = null;
	      let idx = 0;
	      let bestPatternKey = null;
	      let altsAllBest = null;
	      let altsAllBestTotal = 0;
	      let altsAllBestTruncated = false;
	      let genCapped = false;
	      let genCap = 0;

	      if (reuse){
	        alts = curW.solve.alts;
	        idx = ((Number(curW.solve.idx)||0) + 1) % alts.length;
	        bestPatternKey = curW.solve.bestPatternKey || null;
	        altsAllBest = Array.isArray(curW.solve.altsAllBest) ? curW.solve.altsAllBest : null;
	        altsAllBestTotal = Number(curW.solve.altsAllBestTotal || 0);
	        altsAllBestTruncated = !!curW.solve.altsAllBestTruncated;
	        genCapped = !!curW.solve.genCapped;
	        genCap = Number(curW.solve.genCap || 0);
	      } else {
	        // Compute fresh alternatives.
	        const computed = (function(){
	          // Build rowKey -> slot map (keep duplicates by rowKey).
	          const slotByKey = new Map();
	          for (const sl of (slots||[])){
	            const rk = String(sl.rowKey || sl.key || '');
	            if (!rk) continue;
	            slotByKey.set(rk, sl);
	          }

	          // Detect defenders that have Sturdy in this wave (via STU tag).
	          // Simple ground logic: avoid selecting STU defenders as "padding" targets or filler unless unavoidable.
	          const isSturdyKey = (rk)=>{
	            const sl = slotByKey.get(String(rk));
	            return Array.isArray(sl?.tags) && sl.tags.includes('STU');
	          };
	          const waveKeys = Array.from(slotByKey.keys());
	          if (!waveKeys.length) return null;

	                    // Auto x4 is a global solver and does NOT depend on Selected enemies (lead pair).
        // (Lead pair remains meaningful for the manual Fight button + Fight plan preview.)
        const leadPair = null;

        const maxFuturePhase = Math.min(3, phase + 2);
	          const futureCount = (rowKey)=>{
	            const sl = slotByKey.get(String(rowKey));
	            const base = sl ? pokeApi.baseOfSync(sl.defender, st.baseCache||{}) : String(rowKey);
	            let c = 0;
	            for (const x of (data.calcSlots || [])){
	              const ph = Number(x.phase || x.Phase || 0);
	              if (!(ph > phase && ph <= maxFuturePhase)) continue;
	              const sp = fixName(x.defender || x.species || x.name || '');
	              const b = pokeApi.baseOfSync(sp, st.baseCache||{});
	              if (b === base) c++;
	            }
	            return c;
	          };

	          // Pick up to 8 defender rowKeys to consider for padding (future-light first).
	          // Ensure the selected lead pair is included.
	          let chosenKeys = waveKeys.slice().sort((a,b)=>{
	            const fa = futureCount(a);
	            const fb = futureCount(b);
	            if (fa !== fb) return fa - fb;
	            return String(a).localeCompare(String(b));
	          });
	          if (leadPair){
	            const { lead0, lead1 } = leadPair;
	            chosenKeys = [lead0, lead1, ...chosenKeys.filter(k=>k!==lead0 && k!==lead1)];
	          }
	          chosenKeys = chosenKeys.slice(0, 8);
	          if (chosenKeys.length < 2) return null;

	          const attIds = act.map(r=>r.id);
	          const attPairs = [];
	          for (let i=0;i<attIds.length;i++) for (let j=i+1;j<attIds.length;j++) attPairs.push([attIds[i],attIds[j]]);

	          // Cache best move calc per (attId,rowKey) to keep enumeration fast.
	          const moveCache = new Map();
	          const bestMoveFor2 = (attId, defKey, weather)=>{
	            const w = String(weather||'');
	            const key = `${attId}||${defKey}||w:${w}`;
	            if (moveCache.has(key)) return moveCache.get(key);
	            const r = byId(st.roster, attId);
	            const defSlot = slotByKey.get(String(defKey));
	            if (!r || !defSlot){
	              moveCache.set(key, null);
	              return null;
	            }
	            const atk = {species:(r.effectiveSpecies||r.baseSpecies), level: st.settings.claimedLevel, ivAll: st.settings.claimedIV, evAll: r.strength?st.settings.strengthEV:st.settings.claimedEV};
	            const def = {species:defSlot.defender, level:defSlot.level, ivAll: st.settings.wildIV, evAll: st.settings.wildEV};
	            const forced = (st.wavePlans?.[waveKey]?.attackMoveOverride||{})[attId] || null;
	            const mp = filterMovePoolForCalc({ppMap: ppAfterClear || {}, monId: r.id, movePool: r.movePool || [], forcedMoveName: forced});
	            const s0 = settingsForWave(st, st.wavePlans?.[waveKey]||{}, attId, defSlot.rowKey, defSlot.defender);
	            const s = withWeatherSettings(s0, weather);
	            const res = calc.chooseBestMove({data, attacker:atk, defender:def, movePool:mp, settings: s, tags: defSlot.tags||[]});
	            const best = res?.best || null;
	            moveCache.set(key, best);
	            return best;
	          };

	          const scoreTuple = (m0, m1)=>{
	            const SPEED_PRIO_CAP = 3.5;
	            const ohko = (m0?.oneShot ? 1 : 0) + (m1?.oneShot ? 1 : 0);
	            const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
	            const avgPrio = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
	            const slowerCount = (m0?.slower ? 1 : 0) + (m1?.slower ? 1 : 0);
	            const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
	            return {ohko, worstPrio, avgPrio, slowerCount, overkill, speedCap: SPEED_PRIO_CAP};
	          };
	          const betterT = (a,b)=>{
	            if (a.ohko !== b.ohko) return a.ohko > b.ohko;
	            if (a.worstPrio !== b.worstPrio) return a.worstPrio < b.worstPrio;
	            const cap = Number(a.speedCap ?? 3.5);
	            const aOk = ((a.avgPrio ?? 9) <= cap);
	            const bOk = ((b.avgPrio ?? 9) <= cap);
	            // Only care about outspeeding when we can't keep prioØ in the good band.
	            if (!aOk && !bOk){
	              if ((a.slowerCount ?? 0) !== (b.slowerCount ?? 0)) return (a.slowerCount ?? 0) < (b.slowerCount ?? 0);
	            }
	            if (a.avgPrio !== b.avgPrio) return a.avgPrio < b.avgPrio;
	            return a.overkill <= b.overkill;
	          };

	          // --- Auto x4: STU AoE 1-turn clear detection (schedule scoring parity with battle engine) ---
	          // The schedule generator uses a fast (per-target) tuple score. That under-values STU+add pairs
	          // when a 1-turn plan exists (chip STU then AoE sweeps, or AoE leaves STU at 1 HP then finisher).
	          // We detect that deterministic 1-turn clear and upgrade the tuple to OHKO=2 so these plans
	          // are not pruned/ignored during schedule generation.

	          const clampHpPctLocal = (x)=>{
	            const n = Number(x);
	            if (!Number.isFinite(n)) return 0;
	            return Math.max(0, Math.min(100, n));
	          };
	          const clampDmgPctLocal = (x)=>{
	            const n = Number(x);
	            if (!Number.isFinite(n)) return 0;
	            return Math.max(0, Math.min(9999, n));
	          };

	          const canUseMoveName = (monId, moveName)=>{
	            if (!monId || !moveName) return false;
	            const cur = Number(ppAfterClear?.[monId]?.[moveName]?.cur ?? DEFAULT_MOVE_PP);
	            return cur > 0;
	          };

	          const atkObjFromId = (monId)=>{
	            const rm = byId(st.roster, monId);
	            if (!rm) return null;
	            return {
	              species:(rm.effectiveSpecies||rm.baseSpecies),
	              level: st.settings.claimedLevel,
	              ivAll: st.settings.claimedIV,
	              evAll: rm.strength?st.settings.strengthEV:st.settings.claimedEV,
	            };
	          };

	          const defObjFromKey = (rowKey)=>{
	            const sl = slotByKey.get(String(rowKey));
	            if (!sl) return null;
	            return {
	              species: sl.defender,
	              level: sl.level,
	              ivAll: st.settings.wildIV,
	              evAll: st.settings.wildEV,
	            };
	          };

	          const movePoolForAuto4 = (monId)=>{
	            const rm = byId(st.roster, monId);
	            if (!rm) return [];
	            let pool = (rm.movePool||[]).filter(m=>m && m.use !== false && m.name && canUseMoveName(monId, m.name));
	            const forced = (st.wavePlans?.[waveKey]?.attackMoveOverride||{})[monId] || null;
	            if (forced){
	              const f = pool.filter(m=>m.name===forced);
	              if (f.length) pool = f;
	              else pool = []; // forced but no PP
	            }
	            return pool;
	          };

	          const rrVsDef = (attId, moveName, defKey, curHpFrac)=>{
	            const atk = atkObjFromId(attId);
	            const def = defObjFromKey(defKey);
	            const sl = slotByKey.get(String(defKey));
	            if (!atk || !def || !sl) return null;
	            const wpSolve = st.wavePlans?.[waveKey] || {};
	            const s0 = settingsForWave(st, wpSolve, attId, sl.rowKey, sl.defender);
	            const s = withWeatherSettings({...s0, defenderCurHpFrac: (Number.isFinite(Number(curHpFrac)) ? Number(curHpFrac) : 1)}, waveWeather);
	            try{
	              const rr = calc.computeDamageRange({data, attacker: atk, defender: def, moveName, settings: s, tags: sl.tags||[]});
	              return (rr && rr.ok) ? rr : null;
	            }catch(e){
	              return null;
	            }
	          };

	          const wouldFriendlyFireKOPartnerLocal = (aoeUserId, moveName, allyId)=>{
	            if (!aoeUserId || !moveName || !allyId) return false;
	            if (!!st.settings?.allowFriendlyFire) return false;
	            if (!isAoeMove(moveName) || !aoeHitsAlly(moveName)) return false;
	            const allyMon = byId(st.roster, allyId);
	            if (!allyMon) return false;
	            const atk = atkObjFromId(aoeUserId);
	            const def = atkObjFromId(allyId);
	            if (!atk || !def) return false;
	            const wpSolve = st.wavePlans?.[waveKey] || {};
	            const s0 = settingsForWave(st, wpSolve, aoeUserId, null);
	            const s = withWeatherSettings({...s0, defenderHpFrac: 1, defenderCurHpFrac: 1, defenderItem: allyMon.item || null, applySTU: false, applyINT: false}, waveWeather);
	            try{
	              const rr = calc.computeDamageRange({data, attacker: atk, defender: def, moveName, settings: s, tags: []});
	              if (!rr || !rr.ok) return false;
	              const immune = immuneFromAllyAbilityItem(allyMon, rr.moveType);
	              if (immune) return false;
	              const maxPct = clampDmgPctLocal(Number(rr.maxPct ?? rr.minPct ?? 0));
	              // Conservative: ignore spread reduction and assume full damage.
	              return maxPct >= 100;
	            }catch(e){
	              return false;
	            }
	          };

	          const simulateTwoAtkActionsLocal = (defKeys, actions)=>{
	            // Deterministic min% sim for the two attacker actions only (mirrors battle engine order: speed desc).
	            const hp = {};
	            for (const k of defKeys) hp[k] = 100;

	            const withSpe = (actions||[]).map(a=>{
	              const sampleKey = a.sampleTargetKey || a.targetKey || defKeys[0];
	              const rr = rrVsDef(a.attackerId, a.move, sampleKey, (hp[sampleKey] ?? 100) / 100);
	              return {...a, actorSpe: Number(rr?.attackerSpe)||0};
	            });
	            withSpe.sort((a,b)=>{
	              // Battle engine parity: action order is speed-desc.
	              const sa = Number(a.actorSpe)||0;
	              const sb = Number(b.actorSpe)||0;
	              if (sb !== sa) return sb - sa;
	              return String(a.attackerId||'').localeCompare(String(b.attackerId||''));
	            });
for (const act of withSpe){
	              if (!act || !act.attackerId || !act.move) continue;
	              if (isAoeMove(act.move)){
	                const alive = defKeys.filter(k => (hp[k] ?? 0) > 0);
	                const hits = [];
	                for (const dk of alive){
	                  const rr = rrVsDef(act.attackerId, act.move, dk, (hp[dk] ?? 100) / 100);
	                  if (!rr) continue;
	                  hits.push({dk, min: clampDmgPctLocal(Number(rr.minPct)||0)});
	                }
	                const targetsDamaged = hits.filter(h => (h.min||0) > 0).length;
	                const mult = spreadMult(targetsDamaged);
	                for (const h of hits){
	                  const dmg = clampDmgPctLocal((h.min||0) * mult);
	                  hp[h.dk] = clampHpPctLocal((hp[h.dk] ?? 0) - dmg);
	                }
	              } else {
	                // single target; redirect if target already fainted
	                let tk = act.targetKey;
	                if (!tk || (hp[tk] ?? 0) <= 0){
	                  tk = defKeys.find(k => (hp[k] ?? 0) > 0) || null;
	                }
	                if (!tk) continue;
	                const rr = rrVsDef(act.attackerId, act.move, tk, (hp[tk] ?? 100) / 100);
	                if (!rr) continue;
	                const dmg = clampDmgPctLocal(Number(rr.minPct)||0);
	                hp[tk] = clampHpPctLocal((hp[tk] ?? 0) - dmg);
	              }
	            }
	            return hp;
	          };
const sturdyAoeSolveScore = (aId, bId, stuKey, otherKey)=>{
if (!(st.settings?.sturdyAoeSolve ?? true)) return null;
if (!stuKey || !otherKey) return null;

const defKeys = [String(stuKey), String(otherKey)];
const poolA0 = movePoolForAuto4(aId) || [];
const poolB0 = movePoolForAuto4(bId) || [];
const poolA = poolA0.filter(m=>m && m.name && canUseMoveName(aId, m.name));
const poolB = poolB0.filter(m=>m && m.name && canUseMoveName(bId, m.name));
if (!poolA.length || !poolB.length) return null;

let best = null;
const prioOf = (m)=> (Number.isFinite(Number(m?.prio)) ? Number(m.prio) : 3);

for (const mA of poolA){
  const isAoeA = isAoeMove(mA.name);
  if (isAoeA && wouldFriendlyFireKOPartnerLocal(aId, mA.name, bId)) continue;

  for (const mB of poolB){
    const isAoeB = isAoeMove(mB.name);
    if (!isAoeA && !isAoeB) continue; // need at least one AoE to count as STU AoE solve
    if (isAoeB && wouldFriendlyFireKOPartnerLocal(bId, mB.name, aId)) continue;

    const pA = prioOf(mA);
    const pB = prioOf(mB);

    const tgtsA = isAoeA ? [String(otherKey)] : [String(stuKey), String(otherKey)];
    const tgtsB = isAoeB ? [String(otherKey)] : [String(stuKey), String(otherKey)];

    for (const tA of tgtsA){
      for (const tB of tgtsB){
        const hpNext = simulateTwoAtkActionsLocal(defKeys, [
          {attackerId: aId, move: mA.name, prio: pA, targetKey: tA, sampleTargetKey: tA},
          {attackerId: bId, move: mB.name, prio: pB, targetKey: tB, sampleTargetKey: tB},
        ]);
        const stuAlive = (hpNext[String(stuKey)] ?? 0) > 0;
        const otherAlive = (hpNext[String(otherKey)] ?? 0) > 0;
        if (stuAlive || otherAlive) continue;

        const worstPrio = Math.max(pA, pB);
        const avgPrio = (pA + pB) / 2;
        const cand = {worstPrio, avgPrio};

        if (!best) best = cand;
        else {
          if (cand.worstPrio < best.worstPrio) best = cand;
          else if (cand.worstPrio === best.worstPrio && cand.avgPrio < best.avgPrio) best = cand;
        }
      }
    }
  }
}
return best;
};


	          // Enumerate all ways to pad n unique defenders to 8 slots (stars-and-bars).
	          // Preference: do NOT duplicate STU defenders (we still fight them once to claim them, but don't waste fights repeating them).
	          // If this constraint makes it impossible (e.g., all defenders are STU), fall back to unconstrained enumeration.
	          const enumerateDistributions = (keys)=>{
	            const n = keys.length;
	            const extra = Math.max(0, 8 - n);
	            const out = [];
	            if (extra === 0){
	              out.push(keys.slice());
	              return out;
	            }
	            const parts = new Array(n).fill(0);

	            const build = ()=>{
	              const expanded = [];
	              for (let i=0;i<n;i++){
	                const cnt = 1 + parts[i];
	                for (let k=0;k<cnt;k++) expanded.push(keys[i]);
	              }
	              out.push(expanded);
	            };

	            const recNoStu = (idx, rem)=>{
	              if (idx === n - 1){
	                if (isSturdyKey(keys[idx]) && rem > 0) return;
	                parts[idx] = rem;
	                build();
	                return;
	              }
	              const maxX = (isSturdyKey(keys[idx])) ? 0 : rem;
	              for (let x=0;x<=maxX;x++){
	                parts[idx] = x;
	                recNoStu(idx+1, rem-x);
	              }
	            };
	            recNoStu(0, extra);

	            if (out.length) return out;

	            // Fallback: unconstrained enumeration.
	            const out2 = [];
	            const parts2 = new Array(n).fill(0);
	            const build2 = ()=>{
	              const expanded = [];
	              for (let i=0;i<n;i++){
	                const cnt = 1 + parts2[i];
	                for (let k=0;k<cnt;k++) expanded.push(keys[i]);
	              }
	              out2.push(expanded);
	            };
	            const rec2 = (idx, rem)=>{
	              if (idx === n - 1){
	                parts2[idx] = rem;
	                build2();
	                return;
	              }
	              for (let x=0;x<=rem;x++){
	                parts2[idx] = x;
	                rec2(idx+1, rem-x);
	              }
	            };
	            rec2(0, extra);
	            return out2;
	          };

	          // Cache best attacker-pair CHOICES for a defender-pair (by rowKey).
	          // We keep *tie-best* attacker pairs (same OHKO + prio quality) so the "All combos"
	          // explorer can show real alternatives that v16 exposed.
	          const pairBestCache = new Map();
	          const TIE_CAP = 10; // safety: keep at most N tie-best attacker pairs per defender-pair
	          const getPairChoicesByKeys = (k0, k1)=>{
	            const a = String(k0);
	            const b = String(k1);
	            const kk = (a < b) ? `${a}||${b}` : `${b}||${a}`;
	            if (pairBestCache.has(kk)) return pairBestCache.get(kk);

	            const defSlotA = slotByKey.get(String(a));
	            const defSlotB = slotByKey.get(String(b));
	            const defLeads = [defSlotA, defSlotB].filter(Boolean);

	            // STU+add defender pair? If so, we can detect a deterministic 1-turn AoE solve
	            // (chip STU then AoE sweep, or AoE leaves STU at 1 HP then finisher) and upgrade
	            // the tuple score to OHKO=2 so schedule generation doesn't avoid this pairing.
	            const isStuPair = (st.settings?.sturdyAoeSolve ?? true) && (isSturdyKey(a) !== isSturdyKey(b));
	            const stuKey = isStuPair ? (isSturdyKey(a) ? a : b) : null;
	            const addKey = isStuPair ? (isSturdyKey(a) ? b : a) : null;

	            const cands = [];
	            for (const [aId0, bId0] of attPairs){

	              const aMon0 = byId(st.roster, aId0);
	              const bMon0 = byId(st.roster, bId0);
	              const weather = inferBattleWeatherFromLeads(data, st, [aMon0,bMon0].filter(Boolean), defLeads);
	              const mA0 = bestMoveFor2(aId0, a, weather);
	              const mA1 = bestMoveFor2(aId0, b, weather);
	              const mB0 = bestMoveFor2(bId0, a, weather);
	              const mB1 = bestMoveFor2(bId0, b, weather);

	              // Try both assignments and keep the better.
	              const t01 = scoreTuple(mA0, mB1);
	              const t10 = scoreTuple(mA1, mB0);
	              let tuple = t01;
	              if (!betterT(t01, t10)) tuple = t10;

	            // STU AoE parity: if this attacker pair can fully clear (STU+add) in 1 turn deterministically,
	            // upgrade the tuple so schedules pairing STU with the correct add are not pruned.
	            // NOTE: This must happen BEFORE pruning; some valid STU AoE solves have 0 immediate OHKOs
	            // under the simple per-target tuple (e.g., chip + AoE sweep).
	            if (isStuPair && stuKey && addKey){
	              const sc = sturdyAoeSolveScore(aId0, bId0, stuKey, addKey);
	              if (sc){
	                tuple = {...tuple, ohko: 2, worstPrio: sc.worstPrio, avgPrio: sc.avgPrio};
	              }
	            }

	            // Drop hopeless pairs (no OHKO at all) to prune.
	            if (tuple.ohko <= 0) continue;

	              // Canonicalize attacker pair order to avoid duplicates.
	              const pair = [aId0, bId0].slice().sort((x,y)=>String(x).localeCompare(String(y)));
	              const cand = {aId: pair[0], bId: pair[1], score: tuple};
	              cands.push(cand);
	            }

	            // Sort best-first using the same tuple comparator.
	            cands.sort((x,y)=>{
	              if (betterT(x.score, y.score)) return -1;
	              if (betterT(y.score, x.score)) return 1;
	              // stable-ish: by ids
	              const ax = `${x.aId}+${x.bId}`;
	              const ay = `${y.aId}+${y.bId}`;
	              return ax.localeCompare(ay);
	            });

	            const best = cands[0] || null;
	            if (!best){
	              pairBestCache.set(kk, null);
	              return null;
	            }


	            // Keep tie-best by core prio quality (ignore overkill so we keep meaningful roster alternatives).
	            const sameCore = (x,y)=>(
	              x.ohko === y.ohko &&
	              x.worstPrio === y.worstPrio &&
	              Math.abs(x.avgPrio - y.avgPrio) <= 1e-9
	            );
	            const ties = [];
	            for (const cand of cands){
	              if (!sameCore(cand.score, best.score)) break;
	              ties.push(cand);
	              if (ties.length >= TIE_CAP) break;
	            }

	            // STU+add special-case: keep a couple of AoE-capable attacker pairs even if their
	            // single-target tuple score is slightly worse. This prevents early pruning from
	            // hiding valid STU AoE solves (e.g., Earthquake) during Auto x4 schedule generation.
	            if (isStuPair && ties.length < TIE_CAP){
	              const stuKey = isSturdyKey(a) ? a : b;
	              const addKey = isSturdyKey(a) ? b : a;
	              const wpSolve = st.wavePlans?.[waveKey] || {};
	              const slotAdd = slotByKey.get(String(addKey));
	              const slotStu = slotByKey.get(String(stuKey));

	              const canUseMove = (monId, moveName)=>{
	                const cur = Number(ppAfterClear?.[monId]?.[moveName]?.cur ?? DEFAULT_MOVE_PP);
	                return cur > 0;
	              };

	              const atkObjFromRoster = (rm)=>({
	                species:(rm.effectiveSpecies||rm.baseSpecies),
	                level: st.settings.claimedLevel,
	                ivAll: st.settings.claimedIV,
	                evAll: rm.strength?st.settings.strengthEV:st.settings.claimedEV,
	              });
	              const defObjFromRoster = (rm)=>({
	                species:(rm.effectiveSpecies||rm.baseSpecies),
	                level: st.settings.claimedLevel,
	                ivAll: st.settings.claimedIV,
	                evAll: rm.strength?st.settings.strengthEV:st.settings.claimedEV,
	              });

	              const hasSturdyAoeKillAdd = (aoeUserId, allyId)=>{
	                if (!slotAdd || !slotStu) return false;
	                const rm = byId(st.roster, aoeUserId);
	                const ally = byId(st.roster, allyId);
	                if (!rm || !ally) return false;

	                let mp = (rm.movePool||[]).filter(m=>m && m.use !== false && m.name);
	                const forced = (st.wavePlans?.[waveKey]?.attackMoveOverride||{})[aoeUserId] || null;
	                if (forced){
	                  const filtered = mp.filter(m=>m.name===forced);
	                  if (filtered.length) mp = filtered;
	                }
	                mp = mp.filter(m=>canUseMove(aoeUserId, m.name));
	                const aoeMoves = mp.filter(m=>isAoeMove(m.name));
	                if (!aoeMoves.length) return false;

	                const atk = atkObjFromRoster(rm);
	                const defAdd = {species: slotAdd.defender, level: slotAdd.level, ivAll: st.settings.wildIV, evAll: st.settings.wildEV};
	                const defStu = {species: slotStu.defender, level: slotStu.level, ivAll: st.settings.wildIV, evAll: st.settings.wildEV};

	                for (const mv of aoeMoves){
	                  // Respect FF disallow only when the AoE could KO the partner at full HP.
	                  if (aoeHitsAlly(mv.name) && !(st.settings?.allowFriendlyFire)){
	                    try{
	                      const rrA = calc.computeDamageRange({
	                        data,
	                        attacker: atk,
	                        defender: defObjFromRoster(ally),
	                        moveName: mv.name,
	                        settings: withWeatherSettings(settingsForWave(st, wpSolve, aoeUserId, null), waveWeather),
	                        tags: [],
	                      });
	                      if (rrA && rrA.ok){
	                        const immune = immuneFromAllyAbilityItem(ally, rrA.moveType);
	                        if (!immune){
	                          const maxAdj = Number(rrA.maxPct ?? rrA.minPct ?? 0) * spreadMult(3);
	                          if (maxAdj >= 100) continue;
	                        }
	                      }
	                    }catch(e){ /* ignore */ }
	                  }

	                  let rrAdd = null;
	                  let rrStu = null;
	                  try{
	                    rrAdd = calc.computeDamageRange({
	                      data,
	                      attacker: atk,
	                      defender: defAdd,
	                      moveName: mv.name,
	                      settings: withWeatherSettings(settingsForWave(st, wpSolve, aoeUserId, slotAdd.rowKey, slotAdd.defender), waveWeather),
	                      tags: slotAdd.tags||[],
	                    });
	                    rrStu = calc.computeDamageRange({
	                      data,
	                      attacker: atk,
	                      defender: defStu,
	                      moveName: mv.name,
	                      settings: withWeatherSettings(settingsForWave(st, wpSolve, aoeUserId, slotStu.rowKey, slotStu.defender), waveWeather),
	                      tags: slotStu.tags||[],
	                    });
	                  }catch(e){ rrAdd = null; rrStu = null; }
	                  if (!rrAdd || !rrAdd.ok || !rrStu || !rrStu.ok) continue;

	                  // Deterministic: min-roll; spread applies once when 2 defenders are hit.
	                  const mult = spreadMult(2);
	                  const minAdjAdd = Number(rrAdd.minPct||0) * mult;
	                  const minAdjStu = Number(rrStu.minPct||0) * mult;
	                  if (minAdjAdd >= 100 && minAdjStu > 0) return true;
	                }
	                return false;
	              };

	              const have = new Set(ties.map(x=>`${x.aId}+${x.bId}`));
	              const extras = [];
	              for (const cand of cands){
	                if (extras.length >= 3) break;
	                const key2 = `${cand.aId}+${cand.bId}`;
	                if (have.has(key2)) continue;
	                const ok = hasSturdyAoeKillAdd(cand.aId, cand.bId) || hasSturdyAoeKillAdd(cand.bId, cand.aId);
	                if (ok){
	                  extras.push(cand);
	                  have.add(key2);
	                }
	              }
	              for (const ex of extras){
	                if (ties.length >= TIE_CAP) break;
	                ties.push(ex);
	              }
	            }

	            pairBestCache.set(kk, ties);
	            return ties;
	          };

	          const scoreSchedule = (pairs)=>{
	            let totalOhko = 0;
	            let worstWorstPrio = 0;
	            let sumAvgPrio = 0;
	            let sumOverkill = 0;
	            for (const p of pairs){
	              const sc = p.best.score;
	              totalOhko += sc.ohko;
	              worstWorstPrio = Math.max(worstWorstPrio, sc.worstPrio);
	              sumAvgPrio += sc.avgPrio;
	              sumOverkill += sc.overkill;
	            }
	            return {totalOhko, worstWorstPrio, sumAvgPrio, sumOverkill};
	          };
	          const cmpScore = (a,b)=>{
	            if (a.totalOhko !== b.totalOhko) return b.totalOhko - a.totalOhko;
	            if (a.worstWorstPrio !== b.worstWorstPrio) return a.worstWorstPrio - b.worstWorstPrio;
	            if (a.sumAvgPrio !== b.sumAvgPrio) return a.sumAvgPrio - b.sumAvgPrio;
	            return a.sumOverkill - b.sumOverkill;
	          };

	          const bestSingleTargetMove = (mA, mB)=>{
	            const cands = [mA, mB].filter(Boolean);
	            if (!cands.length) return null;
	            cands.sort((x,y)=>{
	              const xo = x.oneShot?1:0;
	              const yo = y.oneShot?1:0;
	              if (xo !== yo) return yo-xo;
	              const xp = x.prio ?? 9;
	              const yp = y.prio ?? 9;
	              if (xp !== yp) return xp-yp;
	              if (x.oneShot && y.oneShot){
	                const xk = Math.abs((x.minPct||0)-100);
	                const yk = Math.abs((y.minPct||0)-100);
	                if (xk !== yk) return xk-yk;
	              }
	              return (y.minPct||0) - (x.minPct||0);
	            });
	            return cands[0];
	          };

	          const pickFillKey = (aId, bId)=>{
	            let best = null;
	            let bestNonStu = null;
	            for (const rk of chosenKeys){
	              const sl = slotByKey.get(String(rk));
	              if (!sl) continue;
	              const mA = bestMoveFor2(aId, rk, null);
	              const mB = bestMoveFor2(bId, rk, null);
	              const m = bestSingleTargetMove(mA, mB);
	              if (!m) continue;
	              const tuple = {
	                ohko: m.oneShot ? 1 : 0,
	                prio: m.prio ?? 9,
	                over: Math.abs((m.minPct||0)-100),
	                minPct: m.minPct || 0,
	              };
	              const better = (x,y)=>{
	                if (!y) return true;
	                if (x.ohko !== y.ohko) return x.ohko > y.ohko;
	                if (x.prio !== y.prio) return x.prio < y.prio;
	                if (x.over !== y.over) return x.over < y.over;
	                return x.minPct >= y.minPct;
	              };
	              if (better(tuple, best?.tuple)) best = {rowKey: sl.rowKey, tuple};
	              if (!isSturdyKey(rk)){
	                if (better(tuple, bestNonStu?.tuple)) bestNonStu = {rowKey: sl.rowKey, tuple};
	              }
	            }
	            // Prefer non-sturdy filler. Only fall back to sturdy if there is no other option.
	            return bestNonStu?.rowKey || best?.rowKey || chosenKeys[0];
	          };

	          const fightKey = (f)=>{
	            const pair = [f.aId, f.bId].slice().sort((x,y)=>String(x).localeCompare(String(y))).join('+');
	            const defs = (f.defs||[]).slice().sort((x,y)=>String(x).localeCompare(String(y))).join('|');
	            return `${pair}@${defs}`;
	          };
	          const altKeyFromFights = (fights)=> fights.map(fightKey).slice().sort().join('||');

	          // Variation limits (global setting)
	          const cycleLimit = Math.max(1, Math.min(50, Math.floor(Number(st.settings?.variationLimit ?? 8) || 8)));
	          // Generation cap: protect against blow-ups on huge waves, but allow deeper search on
	          // normal (<=8 defender) waves so Auto x4 can reliably find the best schedule.
	          const genCapSetting = Math.max(200, Math.min(50000, Math.floor(Number(st.settings?.variationGenCap ?? 5000) || 5000)));
	          const deep = (st.settings?.autoSolveDeepSearch ?? true);
	          const genCap = (deep && chosenKeys.length <= 8) ? Math.max(genCapSetting, 20000) : genCapSetting;

	          // Generate ALL unique candidates across ALL padding distributions.
	          // NOTE: We still apply a safety cap (genCap) to avoid pathological blow-ups on huge waves.
	          const candidates = [];
	          const seen = new Set();
	          let genCapped = false;

	          const paddedLists = enumerateDistributions(chosenKeys);

	          for (const defKeys of paddedLists){
	            if (genCapped) break;
	            if (!Array.isArray(defKeys) || defKeys.length !== 8) continue;

	            // Build best defender-pair -> attacker-pair mapping for this padded list.
	            const pairBest = Array.from({length:8}, ()=>Array(8).fill(null));
	            for (let i=0;i<8;i++){
	              for (let j=i+1;j<8;j++){
	                pairBest[i][j] = getPairChoicesByKeys(defKeys[i], defKeys[j]);
	              }
	            }

	            let schedules = [];
	            const recMatch = (mask, pairs)=>{
	              if (mask === 0){
	                schedules.push({pairs, score: scoreSchedule(pairs)});
	                return;
	              }
	              let i = 0;
	              while (i < 8 && ((mask & (1<<i)) === 0)) i++;
	              for (let j=i+1;j<8;j++){
	                if ((mask & (1<<j)) === 0) continue;
	                const b = pairBest[i][j];
					if (!b || !b.length) continue;
					recMatch(mask & ~(1<<i) & ~(1<<j), pairs.concat([{i,j,choices:b, best:b[0]}]));
				}
	            };
	            recMatch((1<<8)-1, []);

	            // If the user selected a lead pair, try to keep schedules that pair them together.
	            // This makes Auto x4 align with the current Fight plan selection when possible.
	            if (leadPair){
	              const leadOnly = schedules.filter(sch => (sch?.pairs||[]).some(p=>{
	                const a = baseDefKey(String(defKeys[p.i]));
	                const b = baseDefKey(String(defKeys[p.j]));
	                return (a === leadPair.lead0 && b === leadPair.lead1) || (a === leadPair.lead1 && b === leadPair.lead0);
	              }));
	              if (leadOnly.length) schedules = leadOnly;
	            }

	            // Sort schedules so we scan good ones first (helps stability), but we still keep ALL unique keys.
	            schedules.sort((x,y)=> cmpScore(x.score, y.score));

	            const fightBasesForSchedule = (sch)=> (sch.pairs||[]).slice(0,4).map(p=>{
	              const d0 = String(defKeys[p.i]);
	              const d1 = String(defKeys[p.j]);
	              const defsBase = [d0, d1].slice().sort((x,y)=>String(x).localeCompare(String(y)));
	              const choices = Array.isArray(p.choices) ? p.choices : (p.best ? [p.best] : []);
	              return {defsBase, choices};
	            });

	            const cloneFights = (arr)=> (arr||[]).map(f=>({aId:f.aId, bId:f.bId, defs:(f.defs||[]).slice()}));

	            const fightHasLeadPair = (defs)=>{
	              if (!leadPair) return false;
	              const set = new Set((defs||[]).map(k=>baseDefKey(String(k))));
	              return set.has(leadPair.lead0) && set.has(leadPair.lead1);
	            };
	            const orderFightsForLead = (fights)=>{
	              if (!leadPair) return fights;
	              const idx = fights.findIndex(f=>fightHasLeadPair(f.defs));
	              if (idx <= 0) return fights;
	              return [fights[idx], ...fights.slice(0,idx), ...fights.slice(idx+1)];
	            };

	            // Build candidate alts from a given defender-pairing schedule.
	            // IMPORTANT: Cap per-schedule expansion so we don't exhaust genCap on the first few
	            // high-branch schedules (e.g., many tie-best attacker pairs). This improves breadth
	            // and prevents missing globally-better schedules like STU-break → AoE clears.
	            const addCandidatesFromSchedule = (sch, perScheduleCap)=>{
	              const bases = fightBasesForSchedule(sch);
	              if (!bases.length) return;
	              const fights = [];
	              let addedHere = 0;
	              const rec = (idx)=>{
	                if (genCapped) return;
	                if (Number.isFinite(Number(perScheduleCap)) && addedHere >= perScheduleCap) return;
	                if (idx >= bases.length){
	                  const leadOk = !leadPair || fights.some(f=>fightHasLeadPair(f.defs));
	                  const fightsOrdered = orderFightsForLead(fights);
	                  const key = altKeyFromFights(fightsOrdered);
	                  if (!seen.has(key)){
	                    seen.add(key);
	                    candidates.push({fights: cloneFights(fightsOrdered), key, leadOk});
	                    addedHere++;
	                    if (candidates.length >= genCap){
	                      genCapped = true;
	                    }
	                  }
	                  return;
	                }
	                const base = bases[idx];
	                const opts = (base.choices||[]);
	                for (const opt of opts){
	                  if (genCapped) break;
	                  const aId = opt.aId;
	                  const bId = opt.bId;
	                  const isLeadFight = !!(leadPair && Array.isArray(base.defsBase) && base.defsBase.includes(leadPair.lead0) && base.defsBase.includes(leadPair.lead1));
	                  let defs = isLeadFight ? [leadPair.lead0, leadPair.lead1] : (base.defsBase||[]).slice();
	                  const fill = (defLimit > 2) ? pickFillKey(aId, bId) : null;
	                  while (defs.length < defLimit && fill) defs.push(String(fill));
	                  if (!isLeadFight){
	                    defs = defs.slice().sort((x,y)=>String(x).localeCompare(String(y)));
	                  }
	                  fights.push({defs, aId, bId});
	                  rec(idx+1);
	                  fights.pop();
	                }
	              };
	              rec(0);
	            };

	            // Round-robin-ish breadth: cap expansion per schedule so we sample across many
	            // defender matchings instead of fully expanding the earliest one.
	            const perSchCap = Math.max(
	              10,
	              Math.min(200, Math.floor(genCap / Math.max(1, schedules.length * 4)))
	            );
	            for (const sch of schedules){
	              if (genCapped) break;
	              addCandidatesFromSchedule(sch, perSchCap);
	            }
	          }

	          if (!candidates.length) return null;

	          // If the user picked a lead pair, prefer schedules that actually include that pairing.
	          // (When available, this makes Auto x4 align with the Fight plan selection instead of
	          // "solving around" it by pairing one lead with a different filler.)
	          const candidatesToScore = (leadPair && candidates.some(c=>c.leadOk))
	            ? candidates.filter(c=>c.leadOk)
	            : candidates;

	          // Sim-score ALL candidates once, then:
	          // - altsCycle: bestAvg + slack (then bestWorst), capped to MAX_OUT
	          // - altsAllBest: ALL candidates matching the single best prio pattern (avg then worst)
	          const scored = [];
	          const simState = JSON.parse(JSON.stringify(st));
	          const EPS = 1e-9;

	          const patternKeyFromPrios = (prios)=>{
	            const nums = (prios||[]).map(x=>Math.round(Number(x||0)*2)/2).sort((a,b)=>a-b);
	            return nums.map(n=>`P${formatPrioAvg(n)}`).join(' · ');
	          };

	          // Prefer solutions that do NOT keep Sturdy mons on the field across many segments.
	          // This is a *tie-breaker* after (avg prioØ, worst prioØ).
	          const sturdyCountFromFights = (fights)=>{
	            let n = 0;
	            for (const f of (fights||[])){
	              for (const rk of (f?.defs||[])){
	                if (isSturdyKey(rk)) n++;
	              }
	            }
	            return n;
	          };

	          const lexKey = (alt)=>{
	            const parts = (alt?.fights||[]).map(fightKey).slice().sort();
	            return parts.join('||');
	          };

	
        // --- Auto x4: bag-aware item overrides (used when a fight would otherwise fail) ---
        const effectiveItemForMon = (stateX, wpX, monId)=>{
          if (!monId) return null;
          const ovr = (wpX && wpX.itemOverride && typeof wpX.itemOverride === 'object') ? wpX.itemOverride : null;
          const rm = byId(stateX.roster||[], monId);
          const base = (ovr && Object.prototype.hasOwnProperty.call(ovr, monId)) ? (ovr[monId] || null) : null;
          return base || (rm?.item || null);
        };

        const setItemOverride = (wpX, monId, item)=>{
          wpX.itemOverride = (wpX && typeof wpX.itemOverride === 'object') ? wpX.itemOverride : {};
          if (!item){
            delete wpX.itemOverride[monId];
          } else {
            wpX.itemOverride[monId] = item;
          }
        };

        const canAssignItem = (stateX, wpX, monId, item)=>{
          if (!item) return true;
          const cur = effectiveItemForMon(stateX, wpX, monId);
          if (cur === item) return true;
          const rem = availableCountWithItemOverrides(stateX, wpX.itemOverride || {}, item);
          return rem > 0;
        };

        const candidateItemsForMon = (stateX, monId)=>{
          const rm = byId(stateX.roster||[], monId);
          if (!rm) return [];
          const types = moveTypesFromMovePool(data, rm.movePool||[]);
          const base = [];
          base.push('Choice Scarf');
          base.push('Life Orb');
          base.push('Expert Belt');
          for (const t of (types||[])){
            base.push(plateName(t));
            base.push(gemName(t));
          }
          // Keep deterministic, small set.
          const seen = new Set();
          const out = [];
          for (const it of base){
            if (!it || seen.has(it)) continue;
            seen.add(it);
            if ((stateX.bag||{})[it] > 0) out.push(it);
            if (out.length >= 10) break;
          }
          return out;
        };

        const movePoolForItemEval = (stateX, wpX, monId)=>{
          const rm = byId(stateX.roster||[], monId);
          if (!rm) return [];
          const forced = (wpX?.attackMoveOverride||{})[monId] || null;
          return filterMovePoolForCalc({ppMap: stateX.pp || {}, monId, movePool: rm.movePool || [], forcedMoveName: forced});
        };

        const atkObjFromIdX = (stateX, monId)=>{
          const rm = byId(stateX.roster||[], monId);
          if (!rm) return null;
          return {
            species:(rm.effectiveSpecies||rm.baseSpecies),
            level: stateX.settings.claimedLevel,
            ivAll: stateX.settings.claimedIV,
            evAll: rm.strength?stateX.settings.strengthEV:stateX.settings.claimedEV,
          };
        };

        const defObjFromKeyX = (stateX, defKey)=>{
          const sl = slotByKey.get(String(defKey));
          if (!sl) return null;
          return {
            species: sl.defender,
            level: sl.level,
            ivAll: stateX.settings.wildIV,
            evAll: stateX.settings.wildEV,
          };
        };

        const bestMoveWithItem = (stateX, wpX, attId, defKey, item, weather)=>{
          const rm = byId(stateX.roster||[], attId);
          const sl = slotByKey.get(String(defKey));
          if (!rm || !sl) return null;
          const atk = atkObjFromIdX(stateX, attId);
          const def = defObjFromKeyX(stateX, defKey);
          if (!atk || !def) return null;
          const mp = movePoolForItemEval(stateX, wpX, attId);
          if (!mp.length) return null;
          const s0 = settingsForWave(stateX, wpX, attId, sl.rowKey, sl.defender);
          const s1 = withWeatherSettings(s0, weather);
          const s = {...s1, attackerItem: item || s1.attackerItem || null};
          const res = calc.chooseBestMove({data, attacker:atk, defender:def, movePool:mp, settings:s, tags: sl.tags||[]});
          return res?.best || null;
        };

        const scoreItem = (stateX, wpX, attId, defKeys, item, weather)=>{
          const defs = (defKeys||[]).map(k=>String(k));
          let ohko = 0;
          let worstPrio = 9;
          let avgPrioSum = 0;
          let slowerCount = 0;
          let over = 0;
          let n = 0;
          for (const dk of defs){
            const bm = bestMoveWithItem(stateX, wpX, attId, dk, item, weather);
            if (!bm) continue;
            n++;
            if (bm.oneShot) ohko++;
            const p = Number.isFinite(Number(bm.prio)) ? Number(bm.prio) : 9;
            worstPrio = Math.max(worstPrio, p);
            avgPrioSum += p;
            if (bm.slower) slowerCount++;
            over += Math.abs((Number(bm.minPct)||0) - 100);
          }
          const avgPrio = n ? (avgPrioSum / n) : 9;
          return {ohko, worstPrio, avgPrio, slowerCount, over, item: item || null};
        };

        const betterItemScore = (a,b, strict=false)=>{
          if (!b) return true;
          if ((a.ohko||0) !== (b.ohko||0)) return (a.ohko||0) > (b.ohko||0);
          if ((a.worstPrio||9) !== (b.worstPrio||9)) return (a.worstPrio||9) < (b.worstPrio||9);
          const cap = 3.5;
          if ((a.avgPrio||9) <= cap && (b.avgPrio||9) <= cap){
            // In-band: ignore outspeed penalties.
          } else {
            if ((a.slowerCount||0) !== (b.slowerCount||0)) return (a.slowerCount||0) < (b.slowerCount||0);
          }
          if ((a.avgPrio||9) !== (b.avgPrio||9)) return (a.avgPrio||9) < (b.avgPrio||9);
          if ((a.over||0) !== (b.over||0)) return (a.over||0) < (b.over||0);
          // If fully tied, keep current items unless we are in non-strict (salvage) mode.
          return strict ? false : (String(a.item||'').localeCompare(String(b.item||'')) <= 0);
        };

        const suggestItemsForFight = (stateX, wpX, aId, bId, defKeys, opts)=>{
          const aMon = byId(stateX.roster||[], aId);
          const bMon = byId(stateX.roster||[], bId);
          const defSlots = (defKeys||[]).map(k=>slotByKey.get(String(k))).filter(Boolean);
          const weather = inferBattleWeatherFromLeads(data, stateX, [aMon,bMon].filter(Boolean), defSlots.slice(0,2));
          let changed = false;

          const strict = !!(opts && opts.strict);

          const rankedFor = (id)=>{
            const cur = effectiveItemForMon(stateX, wpX, id);
            const cands = [null, cur, ...candidateItemsForMon(stateX, id)].filter((x,i,arr)=>arr.indexOf(x)===i);
            let best = null;
            for (const it of cands){
              if (it && !canAssignItem(stateX, wpX, id, it)) continue;
              const sc = scoreItem(stateX, wpX, id, defKeys, it, weather);
              if (betterItemScore(sc, best)) best = sc;
            }
            return best ? best.item : null;
          };

          // Evaluate small cross-product for the two attackers (conflict-safe).
          const aCur = effectiveItemForMon(stateX, wpX, aId);
          const bCur = effectiveItemForMon(stateX, wpX, bId);

          const aItems = [null, aCur, ...candidateItemsForMon(stateX, aId)].filter((x,i,arr)=>arr.indexOf(x)===i).slice(0,6);
          const bItems = [null, bCur, ...candidateItemsForMon(stateX, bId)].filter((x,i,arr)=>arr.indexOf(x)===i).slice(0,6);

          // Baseline: current items. This avoids "wasting" scarce items when no real gain exists.
          const curA = scoreItem(stateX, wpX, aId, defKeys, aCur, weather);
          const curB = scoreItem(stateX, wpX, bId, defKeys, bCur, weather);
          let bestCombo = {
            ohko: (curA.ohko||0) + (curB.ohko||0),
            worstPrio: Math.max(curA.worstPrio||9, curB.worstPrio||9),
            avgPrio: ((curA.avgPrio||9) + (curB.avgPrio||9)) / 2,
            slowerCount: (curA.slowerCount||0) + (curB.slowerCount||0),
            over: (curA.over||0) + (curB.over||0),
          };
          let bestComboItems = {a: aCur||null, b: bCur||null};

          for (const itA of aItems){
            const tmpOvrA = JSON.parse(JSON.stringify(wpX.itemOverride || {}));
            const tmpWpA = {...wpX, itemOverride: tmpOvrA};
            if (itA && !canAssignItem(stateX, tmpWpA, aId, itA)) continue;
            setItemOverride(tmpWpA, aId, itA);

            for (const itB of bItems){
              const tmpOvr = JSON.parse(JSON.stringify(tmpWpA.itemOverride || {}));
              const tmpWp = {...wpX, itemOverride: tmpOvr};
              if (itB && !canAssignItem(stateX, tmpWp, bId, itB)) continue;
              setItemOverride(tmpWp, bId, itB);

              // Validate bag counts for just these used items.
              const usedItems = new Set([itA,itB].filter(Boolean));
              let ok = true;
              for (const it of usedItems){
                if (availableCountWithItemOverrides(stateX, tmpWp.itemOverride || {}, it) < 0){
                  ok = false; break;
                }
              }
              if (!ok) continue;

              const scA = scoreItem(stateX, tmpWp, aId, defKeys, itA, weather);
              const scB = scoreItem(stateX, tmpWp, bId, defKeys, itB, weather);
              const combo = {
                ohko: (scA.ohko||0) + (scB.ohko||0),
                worstPrio: Math.max(scA.worstPrio||9, scB.worstPrio||9),
                avgPrio: ((scA.avgPrio||9) + (scB.avgPrio||9)) / 2,
                slowerCount: (scA.slowerCount||0) + (scB.slowerCount||0),
                over: (scA.over||0) + (scB.over||0),
              };
              if (betterItemScore(combo, bestCombo, strict)){
                bestCombo = combo;
                bestComboItems = {a: itA||null, b: itB||null};
              }
            }
          }

          // Apply the best combo if it changes something.
          if (bestComboItems.a !== aCur){
            setItemOverride(wpX, aId, bestComboItems.a);
            changed = true;
          }
          if (bestComboItems.b !== bCur){
            setItemOverride(wpX, bId, bestComboItems.b);
            changed = true;
          }

          return changed;
        };

        for (const cand of candidatesToScore){
	            // Re-init sim state to baseline (PP is ppAfterClear) for this candidate.
	            simState.pp = JSON.parse(JSON.stringify(ppAfterClear || {}));
	            simState.battles = {};
	            simState.wavePlans = JSON.parse(JSON.stringify(st.wavePlans || {}));
	            const wTmp = simState.wavePlans?.[waveKey] || JSON.parse(JSON.stringify(curW || {}));
	            simState.wavePlans[waveKey] = wTmp;

          // Auto-solver item overrides (bag-aware). Start from the current wave's overrides.
          wTmp.itemOverride = JSON.parse(JSON.stringify(curW.itemOverride || {}));


	            const prios = [];
	            const turns = [];
	            let defActsTotal = 0;
	            let defActsMax = 0;
	            let ppSpent = 0;
	            let allWon = true;
	            for (const spec of (cand.fights||[])){
	              const canItems = (st.settings?.autoSolveUseItems ?? true);
	              const fullOpt = (st.settings?.autoSolveOptimizeItems ?? true);
	              const ppSnapFight = JSON.parse(JSON.stringify(simState.pp || {}));
	              // Full optimization (optional): suggest items even for already-winning fights.
	              if (canItems && fullOpt){
	                try{ suggestItemsForFight(simState, wTmp, spec?.aId, spec?.bId, spec?.defs||[], {strict:true}); }catch(_e){}
	              }
	              let e = makeFightEntry(simState, wTmp, spec?.aId, spec?.bId, spec?.defs);
	              if (!e || e.status !== 'won'){
	                // Try to salvage using bag-available items (per-wave overrides).
	                if (canItems){
	                  simState.pp = ppSnapFight;
	                  const changed = suggestItemsForFight(simState, wTmp, spec?.aId, spec?.bId, spec?.defs||[], {strict:false});
	                  if (changed){
	                    e = makeFightEntry(simState, wTmp, spec?.aId, spec?.bId, spec?.defs);
	                  }
	                }
	              }
	              if (!e || e.status !== 'won'){
	                allWon = false;
	                break;
	              }
	              prios.push(Number.isFinite(Number(e?.prioAvg)) ? Number(e.prioAvg) : 9);
	              turns.push(Number.isFinite(Number(e?.turnCount)) ? Number(e.turnCount) : 99);
	              const da = Number(e?.defActs || 0);
	              defActsTotal += da;
	              defActsMax = Math.max(defActsMax, da);
	              for (const d of (e.ppDelta || [])){
	                const used = Number(d.prevCur||0) - Number(d.nextCur||0);
	                if (used > 0) ppSpent += used;
	              }
	            }
	            if (!allWon) continue;

	            // Auto x4 selection: prioØ-first (lower is better), then turns, then PP usage.
	            const avgPrio = prios.length ? (prios.reduce((s,x)=>s+x,0) / prios.length) : 9;
	            const maxPrio = prios.length ? Math.max(...prios) : 9;
	            const avgTurns = turns.length ? (turns.reduce((s,x)=>s+x,0) / turns.length) : 99;
	            const maxTurns = turns.length ? Math.max(...turns) : 99;
	            const stu = sturdyCountFromFights(cand.fights);
	            scored.push({
	              alt:{fights:cand.fights, itemOverride: JSON.parse(JSON.stringify(wTmp.itemOverride || {}))},
	              avgPrio,
	              maxPrio,
	              defActsTotal,
	              defActsMax,
	              avgTurns,
	              maxTurns,
	              ppSpent,
	              stu,
	              pat: patternKeyFromPrios(prios),
	              key: cand.key,
	              lex: lexKey({fights:cand.fights})
	            });
	          }

	          if (!scored.length) return null;

	          // Best schedule selection:
	          // - Primary: prioØ, BUT when prioØ is already in the "good" band (≤ 3.5),
	          //   prefer schedules that take fewer enemy actions (outspeed / no-damage).
	          // - Then: turns, PP, STU tie-breakers.
	          const SPEED_PRIO_CAP = 3.5;
        const capOk = (x)=> (Number(x?.avgPrio ?? 9) <= (SPEED_PRIO_CAP + EPS));
        const anyOk = scored.some(capOk);

        // Best schedule selection:
        // - If ANY schedule keeps prioØ in the good band (≤ 3.5), ignore speed/outspeed and rank by prio/turns/PP.
        // - Only when NO schedule is in-band do we start caring about taking hits / being outspeed.
        const cmpSchedule = (a,b)=>{
          const aOk = capOk(a);
          const bOk = capOk(b);
          if (anyOk){
            if (aOk !== bOk) return aOk ? -1 : 1;
          }
          if ((a.avgPrio||9) !== (b.avgPrio||9)) return (a.avgPrio||9) - (b.avgPrio||9);
          if ((a.maxPrio||9) !== (b.maxPrio||9)) return (a.maxPrio||9) - (b.maxPrio||9);

          // Fallback-only: speed proxy (fewer executed enemy actions).
          if (!anyOk){
            if ((a.defActsTotal||0) !== (b.defActsTotal||0)) return (a.defActsTotal||0) - (b.defActsTotal||0);
            if ((a.defActsMax||0) !== (b.defActsMax||0)) return (a.defActsMax||0) - (b.defActsMax||0);
          }

          if ((a.avgTurns||99) !== (b.avgTurns||99)) return (a.avgTurns||99) - (b.avgTurns||99);
          if ((a.maxTurns||99) !== (b.maxTurns||99)) return (a.maxTurns||99) - (b.maxTurns||99);
          if ((a.ppSpent||999) !== (b.ppSpent||999)) return (a.ppSpent||999) - (b.ppSpent||999);
          if ((a.stu||0) !== (b.stu||0)) return (b.stu||0) - (a.stu||0);
          // lex is stable key to avoid churn
          return String(a.lex||'').localeCompare(String(b.lex||''));
        };

	          scored.sort(cmpSchedule);
	          const bestSchedule = scored[0];
	          const bestPatternKey = bestSchedule?.pat || '—';
	          const bestAvg = Number(bestSchedule?.avgPrio ?? 9);

	          // Build the "best pattern" list (this is what the modal should show by default).
	          const bestMatches = scored.filter(x=> x.pat === bestPatternKey);
	          bestMatches.sort(cmpSchedule);
	          const MAX_BEST = cycleLimit;
	          const altsAllBest = bestMatches.slice(0, MAX_BEST).map(x=>x.alt);
	          const altsAllBestTotal = bestMatches.length;
	          const altsAllBestTruncated = bestMatches.length > MAX_BEST;

	          // Cycle list: within bestAvg + slack (avg prioØ), cap.
	          const slack = Math.max(0, Number(st.settings?.autoAltAvgSlack ?? 0));
	          const cutoff = bestAvg + slack + EPS;
	          const kept = scored.filter(x=> (x.avgPrio ?? 9) <= cutoff);
	          kept.sort(cmpSchedule);
	          const altsCycle = kept.slice(0, cycleLimit).map(x=>x.alt);

	          return {altsCycle, bestPatternKey, altsAllBest, altsAllBestTotal, altsAllBestTruncated, genCapped, genCap};
	        })();

	        if (computed && computed.altsCycle && computed.altsCycle.length){
	          alts = computed.altsCycle;
	          idx = 0;
	          bestPatternKey = computed.bestPatternKey || null;
	          altsAllBest = computed.altsAllBest || null;
	          altsAllBestTotal = Number(computed.altsAllBestTotal || 0);
	          altsAllBestTruncated = !!computed.altsAllBestTruncated;
	          genCapped = !!computed.genCapped;
	          genCap = Number(computed.genCap || 0);
	        }
	      }

	      if (!alts || !alts.length){
	        alert('Could not auto-solve this wave with current roster/moves.');
	        return;
	      }

	      // Clear current log and re-simulate.
	      clearAllLog();
	      store.update(s=>{
	        const w = s.wavePlans?.[waveKey];
	        if (!w) return;
	        ensureWavePlan(data, s, waveKey, slots);
	        w.solve = {alts, idx, signature, bestPatternKey, altsAllBest, altsAllBestTotal, altsAllBestTruncated, genCapped: !!genCapped, genCap: Number(genCap||0)};
	        const chosen = alts[idx] || alts[0];
	        if (chosen && chosen.itemOverride && typeof chosen.itemOverride === 'object'){
	          w.itemOverride = JSON.parse(JSON.stringify(chosen.itemOverride));
	        }
	        for (const spec of (chosen.fights||[])){
	          const entry = makeFightEntry(s, w, spec.aId, spec.bId, spec.defs);
	          pushEntry(s, w, entry);
	        }
	      });
	    });

	
  // Auto-solve cycling hint (when multiple alternatives exist)
  const altHint = el('div', {class:'muted small', style:'white-space:nowrap'}, '');
  const altsLen = (wp.solve?.alts || []).length;
  if (altsLen > 1){
    const curIdx = ((Number(wp.solve?.idx) || 0) % altsLen + altsLen) % altsLen;
    altHint.textContent = `Alt ${curIdx+1}/${altsLen} (click Auto x4 to cycle)`;
    altHint.style.display = '';
  } else {
    altHint.style.display = 'none';
  }



  // Explorer: show ALL auto-solve alternatives (battle combinations) with their prio patterns.
  // This is a read-only layer; selecting one applies it like Auto x4 (clears and re-sims 4 fights once).
  const viewCombosBtn = el('button', {class:'btn-mini btn-strong fightlog-toggle'}, 'All combos');
  viewCombosBtn.title = 'Show all auto-solve alternatives for this wave';
  {
    const has = (wp.solve?.altsAllBest || wp.solve?.alts || []).length > 0;
    viewCombosBtn.disabled = !has;
  }

  const openCombosModal = ()=>{
    viewCombosBtn.classList.add('is-active');
    const stBase = store.getState();
    const wBase = stBase.wavePlans?.[waveKey];
    const solve = wBase?.solve || {};
    const alts = (solve.altsAllBest || solve.alts || []);
    const bestPatternKey = solve.bestPatternKey || null;
    const bestTotal = Number(solve.altsAllBestTotal || 0);
    const bestTrunc = !!solve.altsAllBestTruncated;

    // Global variation limit (used for cycling + default combo displays)
    const lim = Math.max(1, Math.min(50, Math.floor(Number(stBase.settings?.variationLimit ?? 8) || 8)));
    const genCapped = !!solve.genCapped;
    const genCap = Number(solve.genCap || 0);
    if (!alts.length){
      alert('No alternatives yet. Click Auto x4 first.');
      return;
    }

    // PP baseline = current PP with THIS wave's fight log rewound, so previews match cycling behavior.
    const ppBaseline = (function(){
      const pp = JSON.parse(JSON.stringify(stBase.pp || {}));
      const log = (wBase.fightLog || []).slice().reverse();
      for (const e of log){
        for (const d of (e.ppDelta || [])){
          if (!pp?.[d.monId]?.[d.move]) continue;
          pp[d.monId][d.move].cur = d.prevCur;
        }
      }
      return pp;
    })();

    const simAlt = (alt)=>{
      const sim = JSON.parse(JSON.stringify(stBase));
      sim.pp = JSON.parse(JSON.stringify(ppBaseline));
      sim.battles = {};
      sim.wavePlans = JSON.parse(JSON.stringify(stBase.wavePlans || {}));
      sim.wavePlans[waveKey] = sim.wavePlans[waveKey] || {};
      const wSim = sim.wavePlans[waveKey];
      if (alt && alt.itemOverride && typeof alt.itemOverride === 'object'){
        wSim.itemOverride = JSON.parse(JSON.stringify(alt.itemOverride));
      }

      const entries = [];
      const prios = [];
      for (const spec of (alt?.fights || [])){
        const e = makeFightEntry(sim, wSim, spec?.aId, spec?.bId, spec?.defs);
        if (!e) continue;
        entries.push(e);
        prios.push(Number.isFinite(Number(e.prioAvg)) ? Number(e.prioAvg) : 9);
      }
      const avg = prios.length ? (prios.reduce((s,x)=>s+x,0) / prios.length) : 9;
      const max = prios.length ? Math.max(...prios) : 9;
      // Pattern key is order-insensitive (sorted), so equivalent schedules group together.
      const pat = (prios||[])
        .map(x=>Math.round(Number(x||0)*2)/2)
        .sort((a,b)=>a-b)
        .map(p=>`P${formatPrioAvg(p)}`)
        .join(' · ');
      return {entries, prios, avg, max, pat};
    };

    const metas = alts.map((alt, idx)=>{
      const sim = simAlt(alt);
      return {idx, alt, ...sim};
    });
    metas.sort((a,b)=>{
      if (a.avg != b.avg) return a.avg - b.avg;
      if (a.max != b.max) return a.max - b.max;
      return a.idx - b.idx;
    });

    // Group by prio pattern for quick scanning (e.g., P1 · P1 · P1 · P1.5)
    const groups = new Map();
    for (const m of metas){
      const k = m.pat || '—';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const groupKeys = Array.from(groups.keys()).sort((a,b)=>{
      // Sort groups by their best avg.
      const ma = groups.get(a)[0]?.avg ?? 9;
      const mb = groups.get(b)[0]?.avg ?? 9;
      if (ma != mb) return ma - mb;
      return String(a).localeCompare(String(b));
    });

    const close = ()=>{
      viewCombosBtn.classList.remove('is-active');
      modal.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev)=>{ if (ev.key === 'Escape') close(); };

          const altLexKey = (alt)=>{
            const parts = (alt?.fights||[]).map(f=>{
              const pair = [f?.aId, f?.bId].filter(Boolean).slice().sort((x,y)=>String(x).localeCompare(String(y))).join('+');
              const defs = (f?.defs||[]).filter(Boolean).slice().sort((x,y)=>String(x).localeCompare(String(y))).join('|');
              return `${pair}@${defs}`;
            }).slice().sort();
            return parts.join('||');
          };

          const applyAlt = (alt)=>{
            close();
            // Apply like Auto x4: clear current log, then simulate chosen fights once.
            clearAllLog();
            store.update(s=>{
              const w = s.wavePlans?.[waveKey];
              if (!w) return;
              ensureWavePlan(data, s, waveKey, slots);
              w.solve = w.solve || {};
              w.solve.alts = Array.isArray(w.solve.alts) ? w.solve.alts : [];
              const k = altLexKey(alt);
              let idx = w.solve.alts.findIndex(a => altLexKey(a) === k);
              if (idx < 0){
                w.solve.alts.unshift(alt);
                idx = 0;
              }
              // Keep alt list bounded by the global variation limit.
              if (Array.isArray(w.solve.alts) && w.solve.alts.length > lim){
                w.solve.alts = w.solve.alts.slice(0, lim);
                if (idx >= w.solve.alts.length) idx = 0;
              }
              w.solve.idx = idx;

              const chosen = alt;
              if (!chosen) return;
              if (chosen.itemOverride && typeof chosen.itemOverride === 'object'){
                w.itemOverride = JSON.parse(JSON.stringify(chosen.itemOverride));
              }
              for (const spec of (chosen.fights||[])){
                const entry = makeFightEntry(s, w, spec.aId, spec.bId, spec.defs);
                pushEntry(s, w, entry);
              }
            });
          };

	            const subtitle = bestPatternKey
	              ? (
	                `Best prio combo: ${bestPatternKey}` +
	                (bestTotal ? (` · showing ${alts.length} of ${bestTotal}${bestTrunc ? ' (limited)' : ''}`) : (` · showing ${alts.length}`)) +
	                ` · limit ${lim}` +
	                (genCapped && genCap ? ` · gen cap hit (${genCap})` : '')
	              )
	              : 'Grouped by prio pattern (P1 / P1.5 / …). Click an entry to expand. Choose one to apply it.';

const headLeft = el('div', {}, [
      el('div', {class:'modal-title'}, 'All battle combinations'),
      el('div', {class:'muted small'}, subtitle),
    ]);
    const btnClose = el('button', {class:'btn btn-mini'}, 'Close');
    btnClose.addEventListener('click', close);

    const list = el('div', {class:'alts-list'}, []);

    for (const gk of groupKeys){
      const arr = groups.get(gk) || [];
      const bestAvg = arr[0]?.avg ?? 9;
      const groupHead = el('div', {class:'alts-grouphead'}, [
        el('div', {style:'display:flex; gap:10px; align-items:center; flex-wrap:wrap'}, [
          el('strong', {}, gk),
          pill(`avg ${formatPrioAvg(bestAvg)}`, 'info'),
          el('span', {class:'muted small'}, `${arr.length} alt${arr.length===1?'':'s'}`),
        ]),
      ]);
      list.appendChild(groupHead);

      for (const m of arr){
        const patPills = (m.prios||[]).map(p=>pill(`P${formatPrioAvg(p)}`, 'info'));

        const btnUse = el('button', {class:'btn-mini'}, 'Use');
        btnUse.addEventListener('click', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); applyAlt(m.alt); });

        const sumLeft = el('div', {style:'display:flex; flex-direction:column; gap:6px'}, [
          el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [
            el('strong', {}, `Alt ${m.idx+1}`),
            pill(`avg ${formatPrioAvg(m.avg)}`, 'warn'),
            pill(`worst ${formatPrioAvg(m.max)}`, 'warn'),
          ]),
          el('div', {style:'display:flex; gap:6px; flex-wrap:wrap'}, patPills),
        ]);

        // Accessibility: <summary> should not contain interactive elements.
        // Put actions just below the summary so keyboard users get a clean toggle.
        const summary = el('summary', {class:'altcombo-summary'}, [sumLeft]);

        const actions = el('div', {class:'altcombo-actions'}, [btnUse]);

        const fights = el('div', {class:'altcombo-fights'}, (m.alt?.fights||[]).map((spec, i)=>{
          const a = byId(stBase.roster||[], spec.aId);
          const b = byId(stBase.roster||[], spec.bId);
          const defs = (spec.defs||[]).map((rk, di)=>`#${di+1} ${(slotByKey2.get(rk)?.defender || rk)}`).join(' · ');
          const pr = Number.isFinite(Number(m.entries?.[i]?.prioAvg)) ? formatPrioAvg(m.entries[i].prioAvg) : '—';
          return el('div', {class:'altcombo-fight'}, [
            el('div', {class:'muted small'}, `Fight ${i+1} · prioØ ${pr}`),
            el('div', {class:'small'}, `${rosterLabel(a)} + ${rosterLabel(b)}  →  ${defs}`),
          ]);
        }));

        const details = el('details', {class:'altcombo'}, [summary, actions, fights]);
        list.appendChild(details);
      }
    }

    const modalCard = el('div', {class:'modal-card modal-wide'}, [
      el('div', {class:'modal-head'}, [headLeft, btnClose]),
      el('div', {class:'modal-body'}, [list]),
    ]);

    const modal = el('div', {class:'modal alts-modal', role:'dialog', 'aria-modal':'true'}, [modalCard]);
    modal.addEventListener('click', (ev)=>{ if (ev.target === modal) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
  };

  viewCombosBtn.addEventListener('click', openCombosModal);
  const controlsRow = el('div', {style:'display:flex; gap:8px; flex-wrap:wrap; align-items:center'}, [
    countLabel,
    altHint,
  ]);

  const expandAll = !!(state.ui && state.ui.wavesLogExpandAll);
  const toggleExpandBtn = el('button', {class:'btn-mini btn-strong fightlog-toggle' + (expandAll ? ' is-active' : ''), 'aria-pressed': expandAll ? 'true' : 'false'}, expandAll ? 'Collapse all' : 'Expand all');
  toggleExpandBtn.title = 'Toggle expanding all fight log entries';
  toggleExpandBtn.addEventListener('click', ()=>{
    store.update(s=>{
      s.ui = s.ui || {};
      s.ui.wavesLogExpandAll = !s.ui.wavesLogExpandAll;
    });
  });

  // Wave toolbar: keep controls near the Fight plan (less clutter inside the log itself)
  if (waveToolsSlot){
    waveToolsSlot.innerHTML = '';
    waveToolsSlot.appendChild(el('div', {
      style:'margin-top:8px; display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center'
    }, [
      el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [controlsRow]),
      el('div', {style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [undoBtn, auto4Btn]),
    ]));
  }

  const fightHead = el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap'}, [
    el('div', {class:'panel-title', style:'margin-bottom:0'}, 'Fight log'),
    el('div', {class:'fightlog-tools', style:'display:flex; gap:8px; align-items:center; flex-wrap:wrap'}, [viewCombosBtn, toggleExpandBtn]),
  ]);

  const fightPanel = el('div', {class:'panel fightlog-panel'}, [
    fightHead,
    el('div', {class:'muted small', style:'margin-top:6px'}, 'Sorted by prioØ (best first). Click an entry (or ▸) to expand.'),
  ]);

  const fightLog = (wp.fightLog||[]);
  const fightLogView = fightLog.slice().sort((a,b)=>{
    const ap = Number.isFinite(Number(a?.prioAvg)) ? Number(a.prioAvg) : 9;
    const bp = Number.isFinite(Number(b?.prioAvg)) ? Number(b.prioAvg) : 9;
    if (ap !== bp) return ap - bp;
    return Number(a?.ts||0) - Number(b?.ts||0);
  });
  if (fightLogView.length){
    const list = el('div', {class:'fightlog-list'}, []);
    for (const e of fightLogView){
      const pr = `prioØ ${formatPrioAvg(e.prioAvg)}`;
      const turns = Number(e.turnCount || 0);
      let ppSpent = 0;
      const ppByMon = new Map();
      for (const d of (e.ppDelta || [])){
        const used = Number(d.prevCur||0) - Number(d.nextCur||0);
        if (used > 0){
          ppSpent += used;
          const k = String(d.monId||'');
          ppByMon.set(k, (ppByMon.get(k) || 0) + used);
        }
      }

      const ppBreakdown = Array.from(ppByMon.entries())
        .filter(([,v])=>Number(v||0) > 0)
        .map(([monId, used])=>{
          const m = byId(state.roster||[], monId);
          const nm = m ? rosterLabel(m) : String(monId);
          return `${nm}-${used}`;
        })
        .join(' · ');

      const statusTxt = (e.status === 'won') ? 'WON' : (e.status === 'lost' ? 'LOST' : (e.status ? String(e.status).toUpperCase() : '—'));
      const statusKind = (e.status === 'won') ? 'good' : (e.status === 'lost' ? 'bad' : 'warn');

      const sumLeft = el('div', {class:'fightlog-sumleft'}, [
        el('div', {class:'fightlog-prio'}, pr),
        el('div', {class:'fightlog-meta'}, [
          pill(statusTxt, statusKind),
          pill(turns ? `${turns} turn${turns===1?'':'s'}` : '— turns', 'info'),
          (function(){
            const p = pill(ppSpent ? `PP -${ppSpent}` : 'PP —', 'info');
            if (ppBreakdown) p.title = `PP spent: ${ppBreakdown}`;
            return p;
          })(),
        ]),
        (e.summary ? el('div', {class:'muted small'}, e.summary) : null),
      ].filter(Boolean));

      const setStartersBtn = el('button', {class:'btn-mini'}, 'Set starters');
      setStartersBtn.title = 'Apply these attackers as the Fight plan starters (does not change moves/items).';
      setStartersBtn.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w) return;
          const atks = Array.isArray(e.attackers) ? e.attackers.slice(0,2) : [];
          if (atks.length < 2) return;
          w.attackerStart = atks;
          w.attackerOrder = atks;
          w.manualStarters = true;
          ensureWavePlan(data, s, waveKey, slots);
        });
      });

      const undoEntryBtn = el('button', {class:'btn-mini btn-undo'}, '↩ Undo');
      undoEntryBtn.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        undoEntryById(e.id);
      });

      // Accessibility: avoid interactive elements inside <summary>.
      // Actions live in the expanded body.
      let details = null;

      const expBtn = el('button', {class:'btn-mini btn-expander', type:'button', title:'Expand/collapse', 'aria-label':'Expand/collapse entry'}, '▸');
      expBtn.addEventListener('click', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); if (details) details.open = !details.open; });

      const sumRow = el('div', {class:'fightlog-summary-row'}, [sumLeft, expBtn]);
      const summary = el('summary', {class:'fightlog-summary'}, [sumRow]);

      const setDefsBtn = el('button', {class:'btn-mini'}, 'Select enemies');
      setDefsBtn.title = 'Apply these defenders as the selected enemies for this wave.';
      setDefsBtn.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        store.update(s=>{
          const w = s.wavePlans?.[waveKey];
          if (!w) return;
          const defs = Array.isArray(e.defenders) ? e.defenders.slice() : [];
          if (!defs.length) return;
          w.defenders = defs;
          w.defenderStart = defs.slice(0,2);
          ensureWavePlan(data, s, waveKey, slots);
        });
      });

      const metaLines = [];
      if (ppBreakdown) metaLines.push(el('div', {class:'muted small fightlog-meta-line'}, `PP spent: ${ppBreakdown}`));

      const itemOvr = (e && e.itemOverride && typeof e.itemOverride === 'object') ? e.itemOverride : null;
      if (itemOvr && Object.keys(itemOvr).length){
        const parts = [];
        for (const [monId, item] of Object.entries(itemOvr)){
          if (!item) continue;
          const m = byId(state.roster||[], monId);
          const nm = m ? rosterLabel(m) : String(monId);
          parts.push(`${nm}=${item}`);
        }
        if (parts.length) metaLines.push(el('div', {class:'muted small'}, `Items: ${parts.join(' · ')}`));
      }

      const lines = el('div', {class:'muted small fightlog-lines'}, (e.lines||[]).map(t=>el('div', {class:'battle-log-line'}, t)));

      const bodyActions = el('div', {class:'fightlog-body-actions'}, [
        setStartersBtn,
        setDefsBtn,
        undoEntryBtn,
      ]);

      const body = el('div', {class:'fightlog-body'}, [
        bodyActions,
        ...metaLines,
        lines,
      ]);

      details = el('details', {class:'fightlog-entry'}, [summary, body]);
      if (expandAll) details.open = true;
      expBtn.textContent = details.open ? '▾' : '▸';
      details.addEventListener('toggle', ()=>{ expBtn.textContent = details.open ? '▾' : '▸'; });
      list.appendChild(details);
    }
    fightPanel.appendChild(list);
  } else {
    fightPanel.appendChild(el('div', {class:'muted small', style:'margin-top:8px'}, 'No fights yet.'));
  }

// Suggested lead pairs
  const suggWrap = el('div', {class:'panel'}, [
    el('div', {class:'panel-title'}, 'Suggested lead pairs'),
  ]);

  const suggList = el('div', {class:'suggestions'});
  const atkMons = activeRoster.map(r=>r).filter(Boolean);
  const defStarters = (wp.defenderStart||[]).slice(0,2).map(k=>slotByKey2.get(baseDefKey(k))).filter(Boolean);
  const d0 = defStarters[0];
  const d1 = defStarters[1];

  if (atkMons.length >= 2 && d0 && d1){
    const pairs = [];
    for (let i=0;i<atkMons.length;i++){
      for (let j=i+1;j<atkMons.length;j++){
        const a = atkMons[i];
        const b = atkMons[j];

        const forcedA = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[a.id] || null) : null;
        const forcedB = (wp && wp.attackMoveOverride) ? (wp.attackMoveOverride[b.id] || null) : null;
        const poolA = filterMovePoolForCalc({ppMap: state.pp || {}, monId: a.id, movePool: a.movePool || [], forcedMoveName: forcedA});
        const poolB = filterMovePoolForCalc({ppMap: state.pp || {}, monId: b.id, movePool: b.movePool || [], forcedMoveName: forcedB});

        const defLeft = {species:d0.defender, level:d0.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
        const defRight = {species:d1.defender, level:d1.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

        // Targeting assumption: either starter can hit either lead defender.
        const bestA0 = calc.chooseBestMove({
          data,
          attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV},
          defender:defLeft,
          movePool: poolA,
          settings: withWeatherSettings(settingsForWave(state, wp, a.id, d0.rowKey, d0.defender), waveWeather),
          tags: d0.tags||[],
        }).best;
        const bestA1 = calc.chooseBestMove({
          data,
          attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV},
          defender:defRight,
          movePool: poolA,
          settings: withWeatherSettings(settingsForWave(state, wp, a.id, d1.rowKey, d1.defender), waveWeather),
          tags: d1.tags||[],
        }).best;
        const bestB0 = calc.chooseBestMove({
          data,
          attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV},
          defender:defLeft,
          movePool: poolB,
          settings: withWeatherSettings(settingsForWave(state, wp, b.id, d0.rowKey, d0.defender), waveWeather),
          tags: d0.tags||[],
        }).best;
        const bestB1 = calc.chooseBestMove({
          data,
          attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV},
          defender:defRight,
          movePool: poolB,
          settings: withWeatherSettings(settingsForWave(state, wp, b.id, d1.rowKey, d1.defender), waveWeather),
          tags: d1.tags||[],
        }).best;

        const tuple = (m0,m1)=>{
          const bothOhko = (m0?.oneShot && m1?.oneShot) ? 2 : ((m0?.oneShot || m1?.oneShot) ? 1 : 0);
          const worstPrio = Math.max(m0?.prio ?? 9, m1?.prio ?? 9);
          const prioAvg = ((m0?.prio ?? 9) + (m1?.prio ?? 9)) / 2;
          const overkill = Math.abs((m0?.minPct ?? 0) - 100) + Math.abs((m1?.minPct ?? 0) - 100);
          return {bothOhko, worstPrio, prioAvg, overkill};
        };
        const t1 = tuple(bestA0, bestB1);
        const t2 = tuple(bestA1, bestB0);
        const better = (x,y)=>{
          if (x.bothOhko !== y.bothOhko) return x.bothOhko > y.bothOhko;
          if (x.worstPrio !== y.worstPrio) return x.worstPrio < y.worstPrio;
          if (x.prioAvg !== y.prioAvg) return x.prioAvg < y.prioAvg;
          return x.overkill <= y.overkill;
        };
        const lead = better(t1,t2) ? t1 : t2;

        const ohkoPairs = lead.bothOhko;
        const prioAvg = lead.prioAvg;
        const worstPrio = lead.worstPrio;
        const overkill = lead.overkill;
        let clearAll = 0;
        for (const ds of allDef){
          const defObj = {species:ds.defender, level:ds.level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};
          const b0 = calc.chooseBestMove({data, attacker:{species:(a.effectiveSpecies||a.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: a.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool: poolA, settings: withWeatherSettings(settingsForWave(state, wp, a.id, ds.rowKey, ds.defender), waveWeather), tags: ds.tags||[]}).best;
          const b1 = calc.chooseBestMove({data, attacker:{species:(b.effectiveSpecies||b.baseSpecies), level: state.settings.claimedLevel, ivAll: state.settings.claimedIV, evAll: b.strength?state.settings.strengthEV:state.settings.claimedEV}, defender:defObj, movePool: poolB, settings: withWeatherSettings(settingsForWave(state, wp, b.id, ds.rowKey, ds.defender), waveWeather), tags: ds.tags||[]}).best;
          if ((b0 && b0.oneShot) || (b1 && b1.oneShot)) clearAll += 1;
        }

        pairs.push({a,b, ohkoPairs, prioAvg, worstPrio, overkill, clearAll});
      }
    }

    pairs.sort((x,y)=>{
      if (x.clearAll !== y.clearAll) return y.clearAll - x.clearAll;
      if (x.ohkoPairs !== y.ohkoPairs) return y.ohkoPairs - x.ohkoPairs;
      if (x.worstPrio !== y.worstPrio) return x.worstPrio - y.worstPrio;
      if (x.prioAvg !== y.prioAvg) return x.prioAvg - y.prioAvg;
      return (x.overkill ?? 0) - (y.overkill ?? 0);
    });

    for (const p of pairs.slice(0,12)){
      const chipEl = el('div', {class:'chip'}, [
        el('strong', {}, `${rosterLabel(p.a)} + ${rosterLabel(p.b)}`),
        el('span', {class:'muted'}, ` · OHKO ${p.ohkoPairs}/2`),
        el('span', {class:'muted'}, ` · clear ${p.clearAll}/${allDef.length}`),
        el('span', {class:'muted'}, ` · prioØ ${formatPrioAvg(p.prioAvg)}`),
      ]);
      chipEl.addEventListener('click', ()=>{
        store.update(st=>{
          const w = st.wavePlans[waveKey];
          w.attackerStart = [p.a.id, p.b.id];
          w.attackerOrder = [p.a.id, p.b.id];
          w.manualStarters = true;
          w.manualOrder = false;
          ensureWavePlan(data, st, waveKey, slots);
        });
      });
      suggList.appendChild(chipEl);
    }
  } else {
    suggList.appendChild(el('div', {class:'muted small'}, 'Need at least 2 ACTIVE roster mons and 2 selected defenders to see suggestions.'));
  }

  
  suggWrap.appendChild(suggList);

  const enemyListPanel = el('div', {class:'panel'}, [
    el('div', {class:'panel-title'}, `Enemies (Phase ${phase})`),
    enemyList,
  ]);

  // Layout: decouple the right side from the left column height.
  // Left column stacks (Selected enemies + Enemies list). Right side is its own grid:
  // Row 1: Fight plan (mid) + Suggested lead pairs (right)
  // Row 2: Fight log spanning both.
  const leftCol = el('div', {class:'planner-stack planner-left'}, [
    slotControls,
    enemyListPanel,
  ]);

  const midCol = el('div', {class:'planner-stack planner-mid'}, [planEl]);
  const rightCol = el('div', {class:'planner-stack planner-right'}, [suggWrap]);
  const logCol = el('div', {class:'planner-stack planner-log'}, [fightPanel]);

  const rightGrid = el('div', {class:'planner-rightgrid'}, [
    midCol,
    rightCol,
    logCol,
  ]);

  return el('div', {class:'wave-planner'}, [
    el('div', {class:'planner-outer'}, [
      leftCol,
      rightGrid,
    ]),
  ]);
}

  return renderWavePlanner;
}
