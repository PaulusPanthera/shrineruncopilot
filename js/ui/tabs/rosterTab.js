// js/ui/tabs/rosterTab.js
// alpha v1
// Roster tab UI (party 4x4 + compact details header).

import { $, el, clampInt, sprite } from '../dom.js';
import { spriteStatic } from '../battleUiHelpers.js';
import { fixName } from '../../data/nameFixes.js';
import {
  makeRosterEntryFromClaimedSetWithFallback,
  applyCharmRulesSync,
  normalizeMovePool,
  defaultPrioForMove,
  isStarterSpecies,
} from '../../domain/roster.js';
import { ensureWavePlan } from '../../domain/waves.js';
import {
  computeRosterUsage,
  availableCount,
  enforceBagConstraints,
} from '../../domain/items.js';
import {
  ensurePPForRosterMon,
  setPP,
  DEFAULT_MOVE_PP,
} from '../../domain/battle.js';
import { getItemIcon } from '../icons.js';
import {
  normalizePartyLayout,
  assignToFirstEmptySlot,
  removeFromParty,
  swapPartySlots,
} from '../../domain/party.js';

const MAX_ROSTER_SIZE = 16;

function byId(arr, id){
  return (arr||[]).find(x => x && x.id === id);
}

function groupBy(arr, fn){
  const out = {};
  for (const x of (arr||[])){
    const k = fn(x);
    out[k] = out[k] || [];
    out[k].push(x);
  }
  return out;
}

function rosterLabel(r){
  return (r?.effectiveSpecies || r?.baseSpecies || '').trim();
}

function typeClass(t){
  const name = String(t||'').trim();
  if (!name) return '';
  // keep consistent with unlockedTab
  return 'type-' + name.replace(/\s+/g,'');
}

function renderTypeChips(types){
  const arr = Array.isArray(types) ? types : (types ? String(types).split('/').map(s=>s.trim()).filter(Boolean) : []);
  const wrap = el('div', {class:'typechips'});
  for (const t of arr){
    wrap.appendChild(el('span', {class:'typechip ' + typeClass(t)}, t));
  }
  return wrap;
}

function renderMoveTypeBadge(type){
  const t = String(type||'').trim();
  if (!t) return el('span', {class:'badge'}, '—');
  // Type icon is applied via CSS using the type-* class.
  return el('span', {class:'badge typebadge ' + typeClass(t), title:t}, t);
}

export function createRosterTab(ctx){
  const { data, calc, store, pokeApi, tabRoster } = ctx;

  // UI-only swap state (not persisted)
  let armedSlot = null;
  let swapMode = false;

  const rosterSpriteSrc = (species, isActive)=>{
    const sp = String(species||'');
    if (!sp) return '';
    return isActive ? sprite(calc, sp) : spriteStatic(calc, sp);
  };

  function partyIndexForRosterId(state, rid){
    const slots = state?.party?.slots;
    if (!rid || !Array.isArray(slots)) return null;
    const idx = slots.findIndex(x => x === rid);
    if (idx < 0) return null;
    return Math.floor(idx / 4);
  }

  function openAddRosterModal(state){
    const unlockedSpecies = Object.keys(state.unlocked).filter(k=>state.unlocked[k]).sort((a,b)=>a.localeCompare(b));
    const pendingBases = new Set();

    const overlay = el('div', {style:`position:fixed; inset:0; background: rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:1000;`});
    const modal = el('div', {class:'panel', style:'width:820px; max-width:95vw; max-height:85vh; overflow:hidden'}, [
      el('div', {style:'display:flex; align-items:center; justify-content:space-between; gap:10px'}, [
        el('div', {class:'panel-title'}, 'Add to roster (from unlocked)'),
        el('button', {class:'btn-mini'}, 'Close'),
      ]),
      el('div', {class:'field'}, [
        el('label', {for:'addSearch'}, 'Search'),
        el('input', {type:'text', id:'addSearch', placeholder:'Search species…'}),
      ]),
      el('div', {class:'list', style:'max-height:60vh'}, [
        el('div', {class:'list-body', id:'addList', style:'max-height:60vh'}),
      ]),
      el('div', {class:'muted small'}, 'Tip: Evolutions inherit the base form\'s set automatically unless you explicitly override them.'),
    ]);

    modal.querySelector('button').addEventListener('click', ()=> overlay.remove());
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const listBody = $('#addList', modal);
    const search = $('#addSearch', modal);

    function render(){
      listBody.innerHTML = '';
      const q = search.value.toLowerCase().trim();
      const st = store.getState();
      const existing = new Set((st.roster||[]).map(r=>r?.baseSpecies).filter(Boolean));
      const candidates = unlockedSpecies.filter(s=>!existing.has(s));
      const rows = candidates.filter(s => !q || s.toLowerCase().includes(q));
      const full = (st.roster||[]).length >= MAX_ROSTER_SIZE;
      for (const sp of rows){
        const img = el('img', {class:'sprite', src:sprite(calc, sp), alt:sp});
        img.onerror = ()=> img.style.opacity='0.25';

        const base = pokeApi.baseOfSync(sp, st.baseCache||{});
        const cs = data.claimedSets?.[sp] || data.claimedSets?.[base] || null;
        const inheritedFrom = (!data.claimedSets?.[sp] && cs && base && base !== sp) ? base : null;

        // If we don't have a base mapping yet, resolve it in the background for better inheritance.
        if (!data.claimedSets?.[sp] && (!base || base === sp) && !pendingBases.has(sp)){
          pendingBases.add(sp);
          pokeApi.resolveBaseNonBaby(sp, st.baseCache||{})
            .then(({updates})=>{
              store.update(st=>{
                st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
              });
              try{ render(); }catch{}
            })
            .catch(()=>{ pendingBases.delete(sp); });
        }

        const btn = el('button', {class:'btn-mini'}, 'Add');
        if (!cs || full) btn.disabled = true;

        btn.addEventListener('click', ()=>{
          const st2 = store.getState();
          if ((st2.roster||[]).length >= MAX_ROSTER_SIZE){
            alert(`Roster limit reached (${MAX_ROSTER_SIZE}/${MAX_ROSTER_SIZE}). Remove a Pokémon first.`);
            return;
          }
          if ((st2.roster||[]).some(x => (x?.baseSpecies || '') === sp)){
            alert(`${sp} is already in the roster. Each Pokémon can only be added once.`);
            render();
            return;
          }
          if (!cs) return;
          store.update(s=>{
            if ((s.roster||[]).length >= MAX_ROSTER_SIZE) return;
            if ((s.roster||[]).some(x => (x?.baseSpecies || '') === sp)) return;
            const base2 = pokeApi.baseOfSync(sp, s.baseCache||{});
            const entry = makeRosterEntryFromClaimedSetWithFallback(data, sp, base2);
            normalizeMovePool(entry);
            s.roster.push(entry);
            s.unlocked[sp] = true;
            // Place in party slots
            assignToFirstEmptySlot(s, entry.id);
            normalizePartyLayout(s);

            s.ui.selectedRosterId = entry.id;
            const res = applyCharmRulesSync(data, s, entry);
            if (res.needsEvoResolve && res.evoBase){
              pokeApi.resolveEvoTarget(res.evoBase, s.evoCache||{})
                .then(({target, updates})=>{
                  store.update(st=>{
                    st.evoCache = {...(st.evoCache||{}), ...(updates||{})};
                    const cur = byId(st.roster, entry.id);
                    if (!cur) return;
                    applyCharmRulesSync(data, st, cur);
                  });
                })
                .catch(()=>{});
            }
          });
          try{ render(); }catch{}
        });

        listBody.appendChild(el('div', {class:'row'}, [
          el('div', {class:'row-left'}, [
            img,
            el('div', {}, [
              el('div', {class:'row-title'}, sp),
              el('div', {class:'row-sub'}, cs ? (inheritedFrom ? `Set inherited from ${inheritedFrom}` : 'Set available') : 'No claimed set (cannot add)'),
            ]),
          ]),
          el('div', {class:'row-right'}, [btn]),
        ]));
      }

      if (full){
        listBody.prepend(el('div', {class:'muted small', style:'padding:8px 4px'}, `Roster is full (${MAX_ROSTER_SIZE}/${MAX_ROSTER_SIZE}). Remove a Pokémon to add another.`));
      }
    }

    render();
    search.addEventListener('input', ()=> render());
    search.focus();
  }

  function renderRosterDetails(state, r, container){
    container.innerHTML = '';
    // The placeholder uses .muted, but the real details should not.
    container.classList.remove('muted');
    const removeRosterId = (removedId)=>{
      if (!removedId) return;
      const mon = byId(store.getState().roster, removedId);
      const label = mon ? rosterLabel(mon) : 'this Pokémon';
      if (!confirm(`Remove ${label} from roster?`)) return;
      store.update(s=>{
        s.roster = (s.roster||[]).filter(x=>x.id !== removedId);
        if (s.ui.selectedRosterId === removedId) s.ui.selectedRosterId = s.roster[0]?.id || null;
        removeFromParty(s, removedId);
        normalizePartyLayout(s);

        // Clean up wave plans that referenced this roster mon
        const waves = groupBy(data.calcSlots, x => x.waveKey);
        for (const [wk, wp] of Object.entries(s.wavePlans||{})){
          if (!wp) continue;
          wp.attackers = (wp.attackers||[]).filter(id=>id!==removedId);
          wp.attackerStart = (wp.attackerStart||[]).filter(id=>id!==removedId);
          // Also clear explicit moves/items that referenced this mon
          if (wp.attackerMoves && typeof wp.attackerMoves === 'object'){
            for (const k of Object.keys(wp.attackerMoves)) if (k === removedId) delete wp.attackerMoves[k];
          }
          if (wp.itemOverride && typeof wp.itemOverride === 'object'){
            for (const k of Object.keys(wp.itemOverride)) if (k === removedId) delete wp.itemOverride[k];
          }
          if (wp.moveOverride && typeof wp.moveOverride === 'object'){
            for (const k of Object.keys(wp.moveOverride)) if (k === removedId) delete wp.moveOverride[k];
          }
          // Ensure wave plan still has valid attackers
          if (waves[wk]) ensureWavePlan(data, s, wk, waves[wk]);
        }
      });
    };


    const eff = r.effectiveSpecies || r.baseSpecies;
    const starter = isStarterSpecies(r.baseSpecies);

    const spImg = el('img', {class:'sprite sprite-lg', src:rosterSpriteSrc(eff, !!r.active), alt:eff});
    spImg.onerror = ()=> spImg.style.opacity = '0.25';

    const openDex = ()=>{
      const base = r.baseSpecies || r.effectiveSpecies || eff;
      store.update(s=>{
        s.ui.tab = 'unlocked';
        s.ui.dexOrigin = 'roster';
        s.ui.dexOriginRosterId = r.id || null;
        s.ui.dexOriginRosterBase = base || null;
        s.ui.dexReturnTab = 'roster';
        s.ui.lastNonDexTab = 'roster';
        s.ui.dexReturnRosterId = r.id || null;
        s.ui.dexReturnRosterBase = base || null;
        s.ui.dexDetailBase = base;
        s.ui.dexSelectedForm = base;
      });
      pokeApi.resolveEvoLine(base, store.getState().baseCache||{})
        .then(({base:resolved, line, updates})=>{
          store.update(st=>{
            st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
            st.evoLineCache = st.evoLineCache || {};
            st.evoLineCache[resolved] = Array.isArray(line) && line.length ? line : [resolved];
            if (st.ui.dexDetailBase === base) st.ui.dexDetailBase = resolved;
            if (!st.ui.dexSelectedForm || st.ui.dexSelectedForm === base) st.ui.dexSelectedForm = resolved;
          });
        })
        .catch(()=>{});
    };
    let openDexDid = false;
    const onOpenDex = (ev)=>{
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      if (openDexDid) return;
      openDexDid = true;
      openDex();
    };
    spImg.addEventListener('pointerdown', onOpenDex, {passive:false});
    spImg.addEventListener('mousedown', onOpenDex);
    spImg.addEventListener('click', onOpenDex);

    // Compact tools
    const activeChk = el('input', {type:'checkbox', checked: !!r.active});
    activeChk.addEventListener('change', ()=>{
      const nextActive = !!activeChk.checked;
      // UI: swap animated GIF ↔ static sprite when toggling active state.
      spImg.src = rosterSpriteSrc(eff, nextActive);
      store.update(s=>{
        const cur = byId(s.roster, r.id);
        if (cur) cur.active = nextActive;
      });
    });

    const evoAvail = availableCount(state, 'Evo Charm') + (r.evo ? 1 : 0);
    const strAvail = starter ? 9999 : (availableCount(state, 'Strength Charm') + (r.strength ? 1 : 0));

    const evoChk = el('input', {type:'checkbox', checked: !!r.evo, disabled: (starter || (!r.evo && evoAvail <= 0))});
    const strChk = el('input', {type:'checkbox', checked: !!(r.strength || starter), disabled: (starter || (!r.strength && strAvail <= 0))});

    evoChk.addEventListener('change', ()=>{
      const want = !!evoChk.checked;
      if (want){
        const st = store.getState();
        const cur = byId(st.roster, r.id);
        if (cur && !cur.evo && availableCount(st, 'Evo Charm') <= 0){
          alert('No Evo Charms available in the shared Bag.');
          evoChk.checked = false;
          return;
        }
      }
      store.update(s=>{
        const cur = byId(s.roster, r.id);
        if (!cur) return;
        cur.evo = want;
        const res = applyCharmRulesSync(data, s, cur);
        if (res.needsEvoResolve && res.evoBase){
          pokeApi.resolveEvoTarget(res.evoBase, s.evoCache||{})
            .then(({updates})=>{
              store.update(st=>{
                st.evoCache = {...(st.evoCache||{}), ...(updates||{})};
                const cur2 = byId(st.roster, r.id);
                if (!cur2) return;
                applyCharmRulesSync(data, st, cur2);
              });
            })
            .catch(()=>{});
        }
      });
    });

    if (!starter){
      strChk.addEventListener('change', ()=>{
        const want = !!strChk.checked;
        if (want){
          const st = store.getState();
          const cur = byId(st.roster, r.id);
          if (cur && !cur.strength && availableCount(st, 'Strength Charm') <= 0){
            alert('No Strength Charms available in the shared Bag.');
            strChk.checked = false;
            return;
          }
        }
        store.update(s=>{
          const cur = byId(s.roster, r.id);
          if (!cur) return;
          cur.strength = want;
          applyCharmRulesSync(data, s, cur);
        });
      });
    }

    // Held item (compact)
    const used = computeRosterUsage(state);
    const bagNames = Object.keys(state.bag||{}).sort((a,b)=>a.localeCompare(b));
    const candidates = bagNames.filter(n=>n!=='Evo Charm' && n!=='Strength Charm');
    if (r.item && !candidates.includes(r.item)) candidates.unshift(r.item);

    const itemIcon = el('img', {class:'item-ico', alt:''});
    const sel = el('select', {class:'sel-mini'}, [
      el('option', {value:''}, '—'),
      ...candidates.map(n=>{
        const total = Number(state.bag[n]||0);
        const u = Number(used[n]||0);
        const avail = total - u + (r.item === n ? 1 : 0);
        const label = `${n} (${Math.max(0, avail)}/${total})`;
        return el('option', {value:n, selected:r.item===n, disabled: (!r.item || r.item!==n) && avail<=0}, label);
      }),
    ]);

    const syncItemIcon = ()=>{
      const v = sel.value || '';
      const src = v ? getItemIcon(v) : '';
      itemIcon.src = src || '';
      itemIcon.style.display = src ? '' : 'none';
    };
    syncItemIcon();

    sel.addEventListener('change', ()=>{
      const v = sel.value || null;
      if (v){
        const st = store.getState();
        const cur = byId(st.roster, r.id);
        if (cur && cur.item !== v && availableCount(st, v) <= 0){
          alert('That item is not available in the shared Bag.');
          sel.value = cur.item || '';
          syncItemIcon();
          return;
        }
      }
      store.update(s=>{
        const cur = byId(s.roster, r.id);
        if (cur) cur.item = v;
      });
      syncItemIcon();
    });

    // Modifiers collapse
    const modsBtn = el('button', {class:'btn-mini', type:'button'}, state.ui?.rosterModsOpen ? 'Mods ▲' : 'Mods ▼');
    modsBtn.addEventListener('click', ()=>{
      store.update(s=>{ s.ui.rosterModsOpen = !s.ui.rosterModsOpen; });
    });

    const dexBtn = el('button', {class:'btn-mini', type:'button'}, 'Dex');
    dexBtn.addEventListener('pointerdown', onOpenDex, {passive:false});
    dexBtn.addEventListener('mousedown', onOpenDex);
    dexBtn.addEventListener('click', onOpenDex);

    const removeBtn = el('button', {class:'btn-mini btn-danger', type:'button'}, 'Remove');
    removeBtn.addEventListener('click', ()=>{
      if (!confirm(`Remove ${rosterLabel(r)} from roster?`)) return;
      store.update(s=>{
        const removedId = r.id;
        s.roster = (s.roster||[]).filter(x=>x.id !== removedId);
        if (s.ui.selectedRosterId === removedId) s.ui.selectedRosterId = s.roster[0]?.id || null;
        removeFromParty(s, removedId);
        normalizePartyLayout(s);

        // Clean up wave plans that referenced this roster mon
        const waves = groupBy(data.calcSlots, x => x.waveKey);
        for (const [wk, wp] of Object.entries(s.wavePlans||{})){
          if (!wp) continue;
          wp.attackers = (wp.attackers||[]).filter(id=>id!==removedId);
          wp.attackerStart = (wp.attackerStart||[]).filter(id=>id!==removedId);
          wp.attackerOrder = (wp.attackerOrder||[]).filter(id=>id!==removedId);
          if (wp.monMods?.atk) delete wp.monMods.atk[removedId];
          const slots = waves[wk];
          if (slots) ensureWavePlan(data, s, wk, slots);
        }
      });
    });

    // --- Details body layout ---
    // Show the selected player's full 4-slot loadout, with move editors for all 4 slots.
    const body = el('div', {class:'roster-details-body'});

    // Player loadout context (4 slots)
    const p = state.party || {names:['Player 1','Player 2','Player 3','Player 4'], slots:Array.from({length:16}).map(()=>null)};
    const names = Array.isArray(p.names) ? p.names : ['Player 1','Player 2','Player 3','Player 4'];
    const slots = Array.isArray(p.slots) ? p.slots : Array.from({length:16}).map(()=>null);

    let partyIdx = Number.isFinite(state.ui?.partyIdx) ? Number(state.ui.partyIdx) : null;
    if (partyIdx == null){
      partyIdx = partyIndexForRosterId(state, r.id);
    }
    if (partyIdx == null) partyIdx = 0;
    partyIdx = Math.max(0, Math.min(3, partyIdx));

    const loadoutTitle = `${names[partyIdx] || `Player ${partyIdx+1}`} — loadout`;
    // Keep the loadout header compact so the right pane aligns visually with the Party pane.
    // Keep the right pane compact: long player names should not wrap and shift the layout.
    body.appendChild(el('div', {class:'panel-subtitle roster-loadout-title', title: loadoutTitle}, loadoutTitle));

    // Loadout details grid (all 4 mons at once)
    // NOTE: reuse `used` computed above (roster-wide bag usage) to avoid duplicate const decl.
    const bagNamesAll = Object.keys(state.bag||{}).sort((a,b)=>a.localeCompare(b));
    const itemCandidatesBase = bagNamesAll.filter(n=>n!=='Evo Charm' && n!=='Strength Charm');
    const allowPPEdit = !!state.settings.allowManualPPEdit;
    const allowLevelEdit = !!state.settings.allowManualLevelEdit;
    const expanded = state.ui?.rosterMoveExpanded || {};

    // Debug: reflect move base power overrides in UI (so displayed BP matches calc).
    function uiMovePower(mv, moveName){
      try{
        if (!mv) return null;
        const enabled = !!state?.settings?.enableMovePowerOverrides;
        if (!enabled) return mv.power;
        const ovr = state?.settings?.movePowerOverrides?.[moveName];
        const p = (ovr !== undefined && ovr !== null && ovr !== '') ? Number(ovr) : null;
        if (Number.isFinite(p) && p > 0) return p;
        return mv.power;
      }catch(e){
        return mv?.power;
      }
    }

    const openDexFor = (mon)=>{
      if (!mon) return;
      const effSp = mon.effectiveSpecies || mon.baseSpecies || '';
      const base = mon.baseSpecies || effSp;
      store.update(s=>{
        s.ui.tab = 'unlocked';
        s.ui.dexOrigin = 'roster';
        s.ui.dexOriginRosterId = mon.id || null;
        s.ui.dexOriginRosterBase = base || null;
        s.ui.dexReturnTab = 'roster';
        s.ui.lastNonDexTab = 'roster';
        s.ui.dexReturnRosterId = mon.id || null;
        s.ui.dexReturnRosterBase = base || null;
        s.ui.dexDetailBase = base;
        s.ui.dexSelectedForm = base;
      });
      pokeApi.resolveEvoLine(base, store.getState().baseCache||{})
        .then(({base:resolved, line, updates})=>{
          store.update(st=>{
            st.baseCache = {...(st.baseCache||{}), ...(updates||{})};
            st.evoLineCache = st.evoLineCache || {};
            st.evoLineCache[resolved] = Array.isArray(line) && line.length ? line : [resolved];
            if (st.ui.dexDetailBase === base) st.ui.dexDetailBase = resolved;
            if (!st.ui.dexSelectedForm || st.ui.dexSelectedForm === base) st.ui.dexSelectedForm = resolved;
          });
        })
        .catch(()=>{});
    };

    const makeItemPicker = (mon)=>{
      const itemIcon = el('img', {class:'item-ico', alt:''});
      const candidates = itemCandidatesBase.slice();
      if (mon.item && !candidates.includes(mon.item)) candidates.unshift(mon.item);

      const sel = el('select', {class:'sel-mini'}, [
        el('option', {value:''}, '—'),
        ...candidates.map(n=>{
          const total = Number(state.bag?.[n]||0);
          const u = Number(used[n]||0);
          const avail = total - u + (mon.item === n ? 1 : 0);
          const label = `${n} (${Math.max(0, avail)}/${total})`;
          return el('option', {value:n, selected:mon.item===n, disabled: (!mon.item || mon.item!==n) && avail<=0}, label);
        }),
      ]);

      const sync = ()=>{
        const v = sel.value || '';
        const src = v ? getItemIcon(v) : '';
        itemIcon.src = src || '';
        itemIcon.style.display = src ? '' : 'none';
      };
      sync();

      sel.addEventListener('change', ()=>{
        const v = sel.value || null;
        if (v){
          const st = store.getState();
          const cur = byId(st.roster, mon.id);
          if (cur && cur.item !== v && availableCount(st, v) <= 0){
            alert('That item is not available in the shared Bag.');
            sel.value = cur.item || '';
            sync();
            return;
          }
        }
        store.update(s=>{
          const cur = byId(s.roster, mon.id);
          if (cur) cur.item = v;
        });
        sync();
      });

      sel.title = 'Held item';
      sel.setAttribute('aria-label','Held item');
      return el('span', {class:'itempick'}, [el('span', {class:'itempick-label'}, 'Item'), itemIcon, sel]);
    };

    const buildMonPanel = (mon, rid, slotIndex)=>{
      const panel = el('div', {class:'loadout-mon-panel' + (rid && state.ui.selectedRosterId === rid ? ' selected' : '')});
      if (!mon){
        panel.appendChild(el('div', {class:'muted small', style:'padding:10px'}, `Empty slot ${slotIndex+1}.`));
        return panel;
      }

      const effSp = mon.effectiveSpecies || mon.baseSpecies || '';
      const label = rosterLabel(mon);
      const starter = isStarterSpecies(mon.baseSpecies);

      const spImg = el('img', {class:'sprite', src:rosterSpriteSrc(effSp, !!mon.active), alt:label});
      spImg.onerror = ()=> spImg.style.opacity = '0.25';

      const activeChk = el('input', {type:'checkbox', checked: !!mon.active});
      activeChk.addEventListener('change', ()=>{
        const nextActive = !!activeChk.checked;
        spImg.src = rosterSpriteSrc(effSp, nextActive);
        store.update(s=>{
          const cur = byId(s.roster, mon.id);
          if (cur) cur.active = nextActive;
        });
      });

      const evoAvail = availableCount(state, 'Evo Charm') + (mon.evo ? 1 : 0);
      const strAvail = starter ? 9999 : (availableCount(state, 'Strength Charm') + (mon.strength ? 1 : 0));

      const evoChk = el('input', {type:'checkbox', checked: !!mon.evo, disabled: (starter || (!mon.evo && evoAvail <= 0))});
      const strChk = el('input', {type:'checkbox', checked: !!(mon.strength || starter), disabled: (starter || (!mon.strength && strAvail <= 0))});

      evoChk.addEventListener('change', ()=>{
        const want = !!evoChk.checked;
        if (want){
          const st = store.getState();
          const cur = byId(st.roster, mon.id);
          if (cur && !cur.evo && availableCount(st, 'Evo Charm') <= 0){
            alert('No Evo Charms available in the shared Bag.');
            evoChk.checked = false;
            return;
          }
        }
        store.update(s=>{
          const cur = byId(s.roster, mon.id);
          if (!cur) return;
          cur.evo = want;
          const res = applyCharmRulesSync(data, s, cur);
          if (res.needsEvoResolve && res.evoBase){
            pokeApi.resolveEvoTarget(res.evoBase, s.evoCache||{})
              .then(({updates})=>{
                store.update(st=>{
                  st.evoCache = {...(st.evoCache||{}), ...(updates||{})};
                  const cur2 = byId(st.roster, mon.id);
                  if (!cur2) return;
                  applyCharmRulesSync(data, st, cur2);
                });
              })
              .catch(()=>{});
          }
        });
      });

      if (!starter){
        strChk.addEventListener('change', ()=>{
          const want = !!strChk.checked;
          if (want){
            const st = store.getState();
            const cur = byId(st.roster, mon.id);
            if (cur && !cur.strength && availableCount(st, 'Strength Charm') <= 0){
              alert('No Strength Charms available in the shared Bag.');
              strChk.checked = false;
              return;
            }
          }
          store.update(s=>{
            const cur = byId(s.roster, mon.id);
            if (!cur) return;
            cur.strength = want;
            applyCharmRulesSync(data, s, cur);
          });
        });
      }

      const dexBtn = el('button', {class:'btn-mini', type:'button'}, 'Dex');
      dexBtn.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        openDexFor(mon);
      });

      const head = el('div', {class:'loadout-mon-head'}, [
        el('button', {class:'loadout-mon-sel', type:'button', title:'Select'}, [
          spImg,
          el('div', {class:'loadout-mon-meta'}, [
            el('div', {class:'loadout-mon-name'}, label),
            el('div', {class:'muted small'}, `Ability: ${mon.ability || '—'} · Moves: ${(mon.movePool||[]).length}`),
          ]),
        ]),
        el('div', {class:'loadout-mon-tools'}, [
          el('label', {class:'check mini', title:'Active roster mons are considered by the wave planner'}, [activeChk, el('span', {}, 'Active')]),
          el('label', {class:'check mini', title: starter ? 'Evo unavailable for starters' : `Evo Charm (avail ${Math.max(0,evoAvail)})`}, [evoChk, el('span', {}, 'Evo')]),
          el('label', {class:'check mini', title: starter ? 'Strength forced for starters' : `Strength Charm (avail ${Math.max(0,strAvail)})`}, [strChk, el('span', {}, 'Str')]),
          makeItemPicker(mon),
          (allowLevelEdit ? (function(){
            const isOpen = (state.ui?.rosterEditOpenId === mon.id);
            const b = el('button', {class:'btn-mini', type:'button'}, isOpen ? 'Edit ▲' : 'Edit ▼');
            b.title = 'Roster editor (debug)';
            b.addEventListener('click', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); store.update(s=>{ s.ui.rosterEditOpenId = (s.ui.rosterEditOpenId === mon.id ? null : mon.id); }); });
            return b;
          })() : null),
          (function(){
            const isOpen = (state.ui?.rosterModsOpenId === mon.id);
            const b = el('button', {class:'btn-mini', type:'button'}, isOpen ? 'Mods ▲' : 'Mods ▼');
            b.title = 'Battle modifiers for this Pokémon';
            b.addEventListener('click', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); store.update(s=>{ s.ui.rosterModsOpenId = (s.ui.rosterModsOpenId === mon.id ? null : mon.id); }); });
            return b;
          })(),
          dexBtn,
          (function(){
            const b = el('button', {class:'btn-icon btn-danger', type:'button', title:'Remove from roster'}, '✕');
            b.addEventListener('click', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); removeRosterId(mon.id); });
            return b;
          })(),
        ]),
      ]);

      head.querySelector('.loadout-mon-sel').addEventListener('click', ()=>{
        store.update(s=>{
          s.ui.partyIdx = partyIdx;
          s.ui.selectedRosterId = mon.id;
        });
      });

      panel.appendChild(head);

      // Collapsible roster editor (debug) — currently: manual level editing.
      const editOpen = allowLevelEdit && (state.ui?.rosterEditOpenId === mon.id);
      if (editOpen){
        const curLvl = Number(mon.level ?? state.settings.claimedLevel ?? 50);
        const inpLvl = el('input', {type:'number', min:'1', max:'100', step:'1', value:String(curLvl), class:'inp-mini'});
        inpLvl.addEventListener('change', ()=>{
          const v = clampInt(inpLvl.value, 1, 100);
          store.update(s=>{ const cur = byId(s.roster, mon.id); if (cur) cur.level = v; });
        });
        panel.appendChild(el('div', {class:'mon-mods'}, [
          el('div', {class:'muted small', style:'margin:4px 0 8px 0'}, 'Roster editor (debug).'),
          el('div', {class:'modrow compact'}, [
            el('div', {class:'modchip'}, [
              el('span', {class:'lbl'}, 'Level'),
              inpLvl,
            ]),
          ]),
        ]));
      }

      // Collapsible battle modifiers (per mon)
      const modsOpen = (state.ui?.rosterModsOpenId === mon.id);
      if (modsOpen){
        const mods = mon.mods || {};
        const stageSelect = (cur, onChange)=>{
          const sel = el('select', {class:'sel-mini'}, Array.from({length:13}).map((_,i)=>{
            const v = i-6;
            return el('option', {value:String(v), selected:Number(cur||0)===v}, (v>=0?`+${v}`:`${v}`));
          }));
          sel.addEventListener('change', ()=> onChange(Number(sel.value)||0));
          return sel;
        };
        const hpInput = (cur, onChange)=>{
          const inp = el('input', {type:'number', min:'1', max:'100', step:'1', value:String(cur ?? 100), class:'inp-mini'});
          inp.addEventListener('change', ()=> onChange(clampInt(inp.value,1,100)));
          return inp;
        };
        const modChip = (label, node)=> el('div', {class:'modchip'}, [el('span', {class:'lbl'}, label), node]);
        const rowMods = el('div', {class:'modrow compact'}, [
          modChip('HP%', hpInput(mods.hpPct, v=>store.update(s=>{ const cur=byId(s.roster, mon.id); if(cur){ cur.mods={...(cur.mods||{}), hpPct:v}; }}))),
          modChip('Atk', stageSelect(mods.atkStage, v=>store.update(s=>{ const cur=byId(s.roster, mon.id); if(cur){ cur.mods={...(cur.mods||{}), atkStage:v}; }}))),
          modChip('SpA', stageSelect(mods.spaStage, v=>store.update(s=>{ const cur=byId(s.roster, mon.id); if(cur){ cur.mods={...(cur.mods||{}), spaStage:v}; }}))),
          modChip('Def', stageSelect(mods.defStage, v=>store.update(s=>{ const cur=byId(s.roster, mon.id); if(cur){ cur.mods={...(cur.mods||{}), defStage:v}; }}))),
          modChip('SpD', stageSelect(mods.spdStage, v=>store.update(s=>{ const cur=byId(s.roster, mon.id); if(cur){ cur.mods={...(cur.mods||{}), spdStage:v}; }}))),
          modChip('Spe', stageSelect(mods.speStage, v=>store.update(s=>{ const cur=byId(s.roster, mon.id); if(cur){ cur.mods={...(cur.mods||{}), speStage:v}; }}))),
        ]);
        panel.appendChild(el('div', {class:'mon-mods'}, [
          el('div', {class:'muted small', style:'margin:4px 0 8px 0'}, 'Battle modifiers (applies in every wave).'),
          rowMods,
        ]));
      }

      // Move pool editor
      const mpWrap = el('div', {class:'loadout-mon-moves'});
      const mpList = el('div', {class:'move-grid'});

      const list = (mon.movePool||[]).slice().sort((a,b)=>(Number(a.prio)-Number(b.prio))||a.name.localeCompare(b.name));
      for (const m of list){
        const mv = data.moves[m.name];
        const bp = uiMovePower(mv, m.name);
        const meta = mv ? `${mv.type} · ${mv.category} · ${bp}` : '—';
        const ppObj = state.pp?.[mon.id]?.[m.name];
        const ppCur = Number(ppObj?.cur ?? DEFAULT_MOVE_PP);
        const ppMax = Number(ppObj?.max ?? DEFAULT_MOVE_PP);
        const ppMeta = `${ppCur}/${ppMax}`;
        const key = `${mon.id}|${m.name}`;
        const isOpen = allowPPEdit && !!expanded[key];

        const chk = el('input', {type:'checkbox', checked: m.use !== false});
        chk.addEventListener('change', ()=>{
          store.update(s=>{
            const cur = byId(s.roster, mon.id);
            if (!cur) return;
            const mv2 = (cur.movePool||[]).find(x=>x.name===m.name);
            if (mv2) mv2.use = chk.checked;
          });
        });

        const prioSel = el('select', {class:'sel-mini'}, [1,2,3,4,5].map(v=> el('option', {value:String(v), selected:Number(m.prio||1)===v}, 'P'+v)));
        prioSel.addEventListener('change', ()=>{
          const v = Number(prioSel.value)||1;
          store.update(s=>{
            const cur = byId(s.roster, mon.id);
            if (!cur) return;
            const mv2 = (cur.movePool||[]).find(x=>x.name===m.name);
            if (!mv2) return;
            mv2.prio = v;
            mv2.prioAuto = false;
            normalizeMovePool(cur);
          });
        });

        const isAuto = (m.prioAuto !== false);
        prioSel.disabled = isAuto;
        prioSel.title = isAuto
          ? 'AUTO prio (derived). Click AUTO to switch to MANUAL and edit prio.'
          : 'Manual prio override.';

        const modeBtn = el('button', {class:'badge prio-mode ' + (isAuto ? 'auto' : 'manual'), type:'button'}, isAuto ? 'AUTO' : 'MANUAL');
        modeBtn.title = isAuto
          ? 'AUTO (derived). Click to switch to MANUAL (unlock prio).'
          : 'MANUAL override. Click to reset to default prio and return to AUTO.';
        modeBtn.addEventListener('click', (ev)=>{
          ev.preventDefault();
          ev.stopPropagation();
          store.update(s=>{
            const cur = byId(s.roster, mon.id);
            if (!cur) return;
            const mv2 = (cur.movePool||[]).find(x=>x.name===m.name);
            if (!mv2) return;
            if (mv2.prioAuto !== false){
              // AUTO -> MANUAL (keep current prio)
              mv2.prioAuto = false;
            } else {
              // MANUAL -> AUTO (reset to derived default)
              const effLocal = cur.effectiveSpecies || cur.baseSpecies || effSp;
              mv2.prio = defaultPrioForMove(data, effLocal, m.name, cur.ability || '', {state:s, entry:cur});
              mv2.prioAuto = true;
              normalizeMovePool(cur);
            }
          });
        });

        const editBtn = allowPPEdit ? el('button', {class:'btn-mini', type:'button'}, isOpen ? 'Edit ▲' : 'Edit ▼') : null;
        if (editBtn){
          editBtn.addEventListener('click', ()=>{
            store.update(s=>{
              s.ui.rosterMoveExpanded = s.ui.rosterMoveExpanded || {};
              const k = `${mon.id}|${m.name}`;
              s.ui.rosterMoveExpanded[k] = !s.ui.rosterMoveExpanded[k];
            });
          });
        }

        const ppRow = el('div', {class:'move-row-pp' + (isOpen ? '' : ' hidden')});
        if (allowPPEdit){
          const inpCur = el('input', {type:'number', min:'0', max:String(ppMax), step:'1', value:String(ppCur), class:'inp-mini'});
          const inpMax = el('input', {type:'number', min:'1', max:'99', step:'1', value:String(ppMax), class:'inp-mini'});
          inpCur.addEventListener('change', ()=>{
            const v = clampInt(inpCur.value, 0, Number(inpMax.value)||ppMax);
            store.update(s=>{ setPP(s, mon.id, m.name, v); });
          });
          inpMax.addEventListener('change', ()=>{
            const vMax = clampInt(inpMax.value, 1, 99);
            store.update(s=>{
              const curR = byId(s.roster, mon.id);
              if (!curR) return;
              ensurePPForRosterMon(s, curR);
              const rec = s.pp?.[mon.id]?.[m.name];
              if (!rec) return;
              rec.max = vMax;
              if (rec.cur > rec.max) rec.cur = rec.max;
            });
          });
          ppRow.appendChild(el('span', {class:'muted small'}, 'PP'));
          ppRow.appendChild(inpCur);
          ppRow.appendChild(el('span', {class:'muted small'}, '/'));
          ppRow.appendChild(inpMax);
        } else {
          ppRow.appendChild(el('span', {class:'muted small'}, `PP ${ppMeta}`));
        }

        const rightTools = [
          modeBtn,
          prioSel,
          el('span', {class:'pp-badge', title:'PP'}, ppMeta),
        ];
        if (editBtn) rightTools.push(editBtn);

        mpList.appendChild(el('div', {class:'move-row'}, [
          el('div', {class:'move-row-main'}, [
            el('div', {class:'move-row-left'}, [
              el('label', {class:'check', style:'margin:0'}, [chk, el('span', {}, '')]),
              el('div', {class:'move-row-title', title:m.name}, m.name),
              mv ? renderMoveTypeBadge(mv.type) : el('span', {class:'badge'}, '—'),
              el('span', {class:'muted small'}, meta),
            ]),
            el('div', {class:'move-row-right'}, [
              ...rightTools,
            ]),
          ]),
          ppRow,
        ]));
      }

      mpWrap.appendChild(mpList);

      // Add TM move (per mon)
      const addSelId = `tmAdd_${String(mon.id||'').replace(/[^a-zA-Z0-9_\-]/g,'_')}`;
      const addSel = el('select', {id:addSelId}, [
        el('option', {value:''}, '— select —'),
        ...Object.keys(data.moves||{}).sort((a,b)=>a.localeCompare(b)).map(n=>el('option', {value:n}, n)),
      ]);
      const addBtn = el('button', {class:'btn-mini', type:'button'}, 'Add');
      addBtn.addEventListener('click', ()=>{
        const name = addSel.value;
        if (!name) return;
        store.update(s=>{
          const cur = byId(s.roster, mon.id);
          if (!cur) return;
          if ((cur.movePool||[]).some(mm=>mm.name===name)) return;
          const effLocal = cur.effectiveSpecies || cur.baseSpecies || effSp;
          const prio = defaultPrioForMove(data, effLocal, name, cur.ability || '', {state:s, entry:cur});
          cur.movePool = [...(cur.movePool||[]), {name, prio, use:true, prioAuto:true}];
          normalizeMovePool(cur);
          ensurePPForRosterMon(s, cur);
        });
        addSel.value = '';
      });

      mpWrap.appendChild(el('div', {class:'field', style:'margin-top:10px'}, [
        el('label', {for:addSelId}, 'Add TM move'),
        el('div', {style:'display:flex; align-items:center; gap:8px; flex-wrap:wrap'}, [addSel, addBtn]),
      ]));

      panel.appendChild(mpWrap);
      return panel;
    };

    const detailsGrid = el('div', {class:'loadout-details-grid'});
    for (let si=0; si<4; si++){
      const idx = partyIdx*4 + si;
      const rid = slots[idx];
      const mon = rid ? byId(state.roster, rid) : null;
      detailsGrid.appendChild(buildMonPanel(mon, rid, si));
    }
    body.appendChild(detailsGrid);

    container.appendChild(body);
  }

  function renderRoster(state){
    tabRoster.innerHTML = '';

    // Duplicate species warning (we disallow adding duplicates going forward).
    const counts = {};
    for (const r of (state.roster||[])){
      const k = (r?.baseSpecies || '').trim();
      if (!k) continue;
      counts[k] = (counts[k]||0) + 1;
    }
    const dups = Object.entries(counts).filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]);

    const left = el('div', {class:'panel roster-left'}, [
      el('div', {class:'panel-title-row', style:'display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:nowrap'}, [
        el('div', {class:'panel-title', title:'Drag & drop to move/swap. Or enable Swap mode.'}, 'Party'),
        el('div', {style:'display:flex; gap:8px; align-items:center; flex:0 0 auto'}, [
          el('button', {class: swapMode ? 'btn-mini btn-on' : 'btn-mini', id:'btnSwapMode', type:'button', title:'When enabled, click two slots to swap.'}, 'Swap'),
          el('button', {class:'btn-mini', id:'btnAddRoster', disabled: (state.roster||[]).length >= MAX_ROSTER_SIZE}, 'Add'),
        ]),
      ]),
    ]);

    if (dups.length){
      const msg = dups.slice(0,4).map(([k,n])=>`${k}×${n}`).join(', ') + (dups.length>4?'…':'');
      left.appendChild(el('div', {class:'warn small', style:'margin-top:6px'}, `Duplicate species detected: ${msg}. Remove extras — duplicates cannot be added anymore.`));
    }

    const right = el('div', {class:'panel'}, [
      // Match Party header density so the two columns start at the same visual baseline.
      el('div', {class:'panel-title-row'}, [
        el('div', {class:'panel-title'}, 'Roster details'),
      ]),
      el('div', {id:'rosterDetails'}, el('div', {class:'muted'}, 'Select a Pokémon.')),
    ]);

    tabRoster.appendChild(el('div', {class:'roster-layout party-layout'}, [left, right]));

    // Party cards
    const p = state.party || {names:['Player 1','Player 2','Player 3','Player 4'], slots:Array.from({length:16}).map(()=>null)};
    const names = Array.isArray(p.names) ? p.names : ['Player 1','Player 2','Player 3','Player 4'];
    const slots = Array.isArray(p.slots) ? p.slots : Array.from({length:16}).map(()=>null);

    const selectedPartyIdx = Number.isFinite(state.ui?.partyIdx) ? Number(state.ui.partyIdx) : null;

    const cards = el('div', {class:'party-grid'});
    for (let ci=0; ci<4; ci++){
      const filledCount = [0,1,2,3].reduce((n,si)=> n + (slots[ci*4+si] ? 1 : 0), 0);

      const nameSel = el('button', {class:'party-name', type:'button'}, names[ci] || `Player ${ci+1}`);
      // Keep the full name accessible even when the UI ellipsizes it.
      nameSel.title = `${names[ci] || `Player ${ci+1}`} — Select this player`;
      if (selectedPartyIdx === ci) nameSel.classList.add('selected');
      nameSel.addEventListener('click', ()=>{
        store.update(s=>{
          s.ui.partyIdx = ci;
          const sl = s.party?.slots || [];
          const first = sl[ci*4] || sl[ci*4+1] || sl[ci*4+2] || sl[ci*4+3] || null;
          if (first) s.ui.selectedRosterId = first;
        });
      });

      const editBtn = el('button', {class:'btn-mini', type:'button', title:'Rename player'}, '✎');
      editBtn.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        const curName = (store.getState().party?.names||[])[ci] || `Player ${ci+1}`;
        const next = prompt('Player name:', curName);
        if (next == null) return;
        store.update(s=>{
          s.party = s.party || {names:['Player 1','Player 2','Player 3','Player 4'], slots:Array.from({length:16}).map(()=>null)};
          s.party.names = Array.isArray(s.party.names) ? s.party.names : ['Player 1','Player 2','Player 3','Player 4'];
          s.party.names[ci] = String(next).trim() || `Player ${ci+1}`;
        });
      });

      const slotGrid = el('div', {class:'party-slots grid4'});

      for (let si=0; si<4; si++){
        const idx = ci*4 + si;
        const rid = slots[idx];
        const mon = rid ? byId(state.roster, rid) : null;
        const eff = mon ? (mon.effectiveSpecies || mon.baseSpecies) : '';
        const label = mon ? rosterLabel(mon) : '';

        const btn = el('button', {class:'party-slot tile', type:'button'}, []);
        if (!mon) btn.classList.add('empty');
        if (mon && !mon.active) btn.classList.add('inactive');
        if (rid && state.ui.selectedRosterId === rid) btn.classList.add('selected');
        if (armedSlot === idx) btn.classList.add('armed');

        if (mon){
          const img = el('img', {class:'sprite', src:rosterSpriteSrc(eff, !!mon.active), alt:label});
          img.onerror = ()=> img.style.opacity='0.25';
          btn.appendChild(img);
          btn.appendChild(el('div', {class:'party-slot-label'}, label));
          btn.title = label;
        } else {
          btn.appendChild(el('div', {class:'party-slot-plus', 'aria-hidden':'true'}, '+'));
          btn.appendChild(el('div', {class:'party-slot-label muted'}, 'Empty'));
          btn.title = 'Empty slot';
        }

        // Drag & drop swapping (no modifiers needed)
        if (rid) btn.draggable = true;
        btn.addEventListener('dragstart', (ev)=>{
          if (!rid) return;
          ev.dataTransfer?.setData('text/plain', String(idx));
          try{ ev.dataTransfer.effectAllowed = 'move'; }catch{}
        });
        btn.addEventListener('dragover', (ev)=>{ ev.preventDefault(); btn.classList.add('drop'); });
        btn.addEventListener('dragleave', ()=> btn.classList.remove('drop'));
        btn.addEventListener('drop', (ev)=>{
          ev.preventDefault();
          btn.classList.remove('drop');
          const raw = ev.dataTransfer?.getData('text/plain');
          const a = Number(raw);
          const b = idx;
          if (!Number.isFinite(a)) return;
          store.update(s=>{
            swapPartySlots(s, a, b);
            normalizePartyLayout(s);
            s.ui.partyIdx = ci;
            const idNow = s.party?.slots?.[b] || s.party?.slots?.[a];
            if (idNow) s.ui.selectedRosterId = idNow;
          });
        });

        btn.addEventListener('click', ()=>{
          if (swapMode){
            if (armedSlot == null){
              armedSlot = idx;
              renderRoster(store.getState());
              return;
            }
            if (armedSlot === idx){
              armedSlot = null;
              renderRoster(store.getState());
              return;
            }
            const a = armedSlot;
            const b = idx;
            armedSlot = null;
            store.update(s=>{
              swapPartySlots(s, a, b);
              normalizePartyLayout(s);
              s.ui.partyIdx = ci;
              const idNow = s.party?.slots?.[b] || s.party?.slots?.[a];
              if (idNow) s.ui.selectedRosterId = idNow;
            });
            return;
          }

          if (rid) store.update(s=>{ s.ui.selectedRosterId = rid; s.ui.partyIdx = ci; });
        });

        slotGrid.appendChild(btn);
      }

      const sub = el('div', {class:'party-sub'}, `${filledCount}/4`);

      cards.appendChild(el('div', {class:'party-card'}, [
        el('div', {class:'party-card-head'}, [
          // Left side of the header must be allowed to shrink so long names ellipsize
          // instead of pushing the layout wider.
          el('div', {class:'party-head-left', style:'display:flex; align-items:center; gap:8px; min-width:0; flex:1 1 auto'}, [nameSel, editBtn]),
          sub,
        ]),
        slotGrid,
      ]));
    }
    left.appendChild(cards);

    const selected = byId(state.roster, state.ui.selectedRosterId);
    if (selected){
      renderRosterDetails(state, selected, $('#rosterDetails', tabRoster));
    }

    $('#btnAddRoster', tabRoster).addEventListener('click', ()=> openAddRosterModal(store.getState()));
    $('#btnSwapMode', tabRoster).addEventListener('click', ()=>{
      swapMode = !swapMode;
      armedSlot = null;
      renderRoster(store.getState());
    });
  }

  return { render: renderRoster };
}
