// js/ui/panels/attackOverview.js
// alpha v1
// Attack overview panel (shown on Waves) extracted from js/app/app.js.

import { el, pill, formatPct, sprite } from '../dom.js';
import { getItemIcon } from '../icons.js';
import { availableCount } from '../../domain/items.js';
import {
  spriteStatic,
  rosterLabel,
  filterMovePoolForCalc,
  enemyAbilityForSpecies,
  inferBattleWeatherFromLeads,
} from '../battleUiHelpers.js';

export function createAttackOverview({ data, calc, store, els }){
  const {
    panel,
    spriteEl,
    titleEl,
    metaEl,
    hintEl,
    bodyEl,
    toggleEl,
  } = els;

  function attach(){
    if (toggleEl){
      toggleEl.addEventListener('click', ()=>{
        store.update(s=>{ s.ui.overviewCollapsed = !s.ui.overviewCollapsed; });
      });
    }

    // Right click anywhere on the overview panel to fully dismiss it.
    if (panel){
      panel.addEventListener('contextmenu', (ev)=>{
        ev.preventDefault();
        store.update(s=>{ s.ui.attackOverview = null; });
      });
    }
  }

  function render(state){
    const ov = state.ui.attackOverview;
    const tab = state.ui.tab;
    const tabAllows = (tab === 'waves');
    if (!ov || !tabAllows){
      panel?.classList.add('hidden');
      return;
    }
    panel?.classList.remove('hidden');

    const collapsed = !!state.ui.overviewCollapsed;
    panel?.classList.toggle('collapsed', collapsed);
    if (toggleEl) toggleEl.textContent = collapsed ? 'Show' : 'Hide';

    const defName = ov.defender;
    const level = Number(ov.level || 50);
    const tags = ov.tags || [];

    if (spriteEl){
      spriteEl.src = spriteStatic(calc, defName);
      spriteEl.onerror = ()=> spriteEl.style.opacity = '0.25';
    }
    if (titleEl) titleEl.textContent = defName;
    if (metaEl) metaEl.textContent = `Lv ${level}` + (tags.length ? ` · ${tags.join(', ')}` : '');
    if (hintEl) hintEl.textContent = 'One-shot info vs your active roster (OHKO = best by prio · otherwise closest-to-kill).';

    const roster = (state.roster||[]).filter(r=>r && r.active);
    const defObj = {species:defName, level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    if (bodyEl) bodyEl.innerHTML = '';
    if (collapsed) return;

    if (!roster.length){
      bodyEl?.appendChild(el('div', {class:'muted'}, 'No active roster Pokémon.'));
      return;
    }

    const rows = [];
    for (const r of roster){
      const atk = {
        species:(r.effectiveSpecies||r.baseSpecies),
        level: state.settings.claimedLevel,
        ivAll: state.settings.claimedIV,
        evAll: r.strength ? state.settings.strengthEV : state.settings.claimedEV,
      };
      const defAb = enemyAbilityForSpecies(data, defName);
      const weather = inferBattleWeatherFromLeads(data, state, [r], [{defender:defName, level}]);
      const movePool = filterMovePoolForCalc({ppMap: state.pp || {}, monId: r.id, movePool: r.movePool || []});
      const settingsBase = {
        ...state.settings,
        attackerItem: r.item || null,
        defenderItem: null,
        attackerAbility: (r.ability||''),
        defenderAbility: defAb,
        weather,
      };

      const res = calc.chooseBestMove({
        data,
        attacker: atk,
        defender: defObj,
        movePool,
        settings: settingsBase,
        tags,
      });
      if (!res?.best) continue;

      // UI policy: if no OHKO exists, show the attack that comes closest to killing (highest min%).
      let best = res.best;
      const anyOhko = (res.all||[]).some(x=>x && x.oneShot);
      if (!anyOhko && (res.all||[]).length){
        const pool = (res.all||[]).slice().sort((a,b)=>{
          const am = Number(a.minPct||0);
          const bm = Number(b.minPct||0);
          if (am !== bm) return bm-am;
          const ap = a.prio ?? 9;
          const bp = b.prio ?? 9;
          if (ap !== bp) return ap-bp;
          return String(a.move||'').localeCompare(String(b.move||''));
        });
        best = pool[0];
      }

      // Optional hints:
      // - SCARF: if currently SLOW, Choice Scarf would flip to OK.
      // - ITEM: if currently not OHKO, an owned item would make this move an OHKO.
      let scarfFlip = false;
      if (best?.slower){
        try{
          const rr = calc.computeDamageRange({
            data,
            attacker: atk,
            defender: defObj,
            moveName: best.move,
            settings: {...settingsBase, attackerItem: 'Choice Scarf'},
            tags,
          });
          scarfFlip = !!(rr?.ok && !rr.slower);
        }catch(e){ scarfFlip = false; }
      }

      let itemHint = null;
      if (best && !best.oneShot){
        // Only consider *owned* offensive items for the hint.
        const bag = state.bag || {};
        const owned = Object.keys(bag).filter(k=> (bag[k]||0) > 0);
        const cand = owned.filter(k=> (
          k === 'Life Orb' ||
          k === 'Expert Belt' ||
          k === 'Choice Band' ||
          k === 'Choice Specs' ||
          k === 'Wise Glasses' ||
          k === 'Muscle Band' ||
          String(k).endsWith(' Plate') ||
          String(k).endsWith(' Gem')
        ));

        let bestItem = null;
        let bestMin = null;
        for (const it of cand){
          if (it === 'Choice Scarf') continue;
          try{
            const rr = calc.computeDamageRange({
              data,
              attacker: atk,
              defender: defObj,
              moveName: best.move,
              settings: {...settingsBase, attackerItem: it},
              tags,
            });
            if (!rr?.ok || !rr.oneShot) continue;
            const m = Number(rr.minPct||0);
            if (bestItem == null || Math.abs(m-100) < Math.abs((bestMin||0)-100)){
              bestItem = it;
              bestMin = m;
            }
          }catch(e){ /* ignore */ }
        }
        if (bestItem){
          itemHint = {item: bestItem, minPct: bestMin};
        }
      }

      rows.push({r, best, scarfFlip, itemHint});
    }

    rows.sort((a,b)=>{
      const ao = a.best.oneShot?1:0;
      const bo = b.best.oneShot?1:0;
      if (ao !== bo) return bo-ao;
      const ap = a.best.prio ?? 9;
      const bp = b.best.prio ?? 9;
      if (ap !== bp) return ap-bp;
      return (b.best.minPct||0) - (a.best.minPct||0);
    });

    const tbl = el('table', {class:'table'});
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Attacker'),
      el('th', {}, 'Best move'),
      el('th', {}, 'Prio'),
      el('th', {}, 'Min%'),
      el('th', {}, 'Speed'),
      el('th', {}, 'Result'),
    ])));

    const tbody = el('tbody');
    for (const row of rows.slice(0, 16)){
      const eff = row.r.effectiveSpecies || row.r.baseSpecies;
      const img = el('img', {class:'sprite sprite-sm', src:sprite(calc, eff), alt:eff});
      img.onerror = ()=> img.style.opacity='0.25';

      const attackerCell = el('div', {style:'display:flex; align-items:center; gap:10px'}, [
        img,
        el('div', {}, [
          el('div', {style:'font-weight:900'}, rosterLabel(row.r)),
          el('div', {class:'muted small'}, row.r.item ? `Item: ${row.r.item}` : ' '),
        ]),
      ]);

      const moveCell = el('div', {}, [
        el('div', {style:'font-weight:900'}, row.best.move),
        el('div', {class:'muted small'}, `${row.best.moveType} · ${row.best.category}` + (row.best.stab ? ' · STAB' : '') + (row.best.hh ? ' · HH' : '')),
      ]);

      const pr = `P${row.best.prio}`;
      const speedPill = row.best.slower ? pill('SLOW','warn danger') : pill('OK','good');

      const scarfPill = row.scarfFlip ? pill('SCARF', availableCount(state, 'Choice Scarf') > 0 ? 'good' : 'warn') : null;
      if (scarfPill){
        const have = availableCount(state, 'Choice Scarf') > 0;
        scarfPill.title = have ? 'Choice Scarf would outspeed.' : 'Choice Scarf would outspeed (not owned).';
      }

      const resPill = row.best.oneShot ? pill('OHKO','good') : pill('NO','bad');
      let itemEl = null;
      if (row.itemHint){
        const src = getItemIcon(row.itemHint.item);
        if (src){
          itemEl = el('img', {class:'item-ico', src, alt:'', title:`OHKO possible with owned item: ${row.itemHint.item}`});
        }else{
          itemEl = pill('ITEM','warn');
          itemEl.title = `OHKO possible with owned item: ${row.itemHint.item}`;
        }
      }

      tbody.appendChild(el('tr', {}, [
        el('td', {}, attackerCell),
        el('td', {}, moveCell),
        el('td', {}, pr),
        el('td', {}, formatPct(row.best.minPct)),
        el('td', {}, el('div', {style:'display:flex; gap:8px; align-items:center'}, [speedPill, scarfPill].filter(Boolean))),
        el('td', {}, el('div', {style:'display:flex; gap:8px; align-items:center'}, [resPill, itemEl].filter(Boolean))),
      ]));
    }

    tbl.appendChild(tbody);
    bodyEl?.appendChild(tbl);
  }

  return { attach, render };
}
