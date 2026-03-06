// js/ui/panels/attackOverview.js
// alpha v1
// Attack overview panel (shown on Waves) extracted from js/app/app.js.

import { el, pill, formatPct, sprite } from '../dom.js';
import { getItemIcon } from '../icons.js';
import { availableCount } from '../../domain/items.js';
import { applyCharmRulesSync, isStarterSpecies } from '../../domain/roster.js';
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
    if (hintEl) hintEl.textContent = 'One-shot info vs your active roster (OHKO = best by prio · otherwise closest-to-kill). Click a row to expand.';

    const roster = (state.roster||[]).filter(r=>r && r.active);
    const defObj = {species:defName, level, ivAll: state.settings.wildIV, evAll: state.settings.wildEV};

    if (bodyEl) bodyEl.innerHTML = '';
    if (collapsed) return;

    if (!roster.length){
      bodyEl?.appendChild(el('div', {class:'muted'}, 'No active roster Pokémon.'));
      return;
    }

    const expandedMap = state.ui.attackOverviewExpanded || {};
    const expandedKey = `${defName}|${level}`;
    const expandedId = expandedMap[expandedKey] || null;

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

    const ownedOffensiveItems = ()=>{
      const bag = state.bag || {};
      const owned = Object.keys(bag).filter(k=> (bag[k]||0) > 0);
      // Keep this conservative for perf (we only need a shortlist for "opens new possibilities").
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
      return cand.slice(0, 10);
    };

    const iconOrPill = (name, kind='item')=>{
      const src = getItemIcon(name);
      if (src){
        return el('img', {class:'item-ico', src, alt:'', title:name});
      }
      const txt = (kind === 'charm') ? (name === 'Strength Charm' ? 'STR' : (name === 'Evo Charm' ? 'EVO' : 'CHARM')) : 'ITEM';
      const p = pill(txt, 'warn');
      p.title = name;
      return p;
    };

    const renderPartsWithPlus = (parts)=>{
      const out = [];
      parts.forEach((p, i)=>{
        if (i) out.push(el('span', {class:'muted small', style:'padding:0 6px'}, '+'));
        out.push(iconOrPill(p, (p.endsWith('Charm') ? 'charm' : 'item')));
      });
      return el('span', {style:'display:inline-flex; align-items:center; gap:0'}, out);
    };

    const buildOhkoOptions = ({atkBase, defObj, baseSettings, tags, mon, moveName, baseSlower})=>{
      // Returns a list of options. Each option is { parts:[...], note } where parts are items/charms.
      // parts length > 1 means the combo is required.
      const opts = [];
      const addOpt = (parts, note)=>{
        const key = parts.join(' + ');
        if (!opts.some(o=>o.key === key)) opts.push({key, parts, note});
      };

      const items = ownedOffensiveItems();
      const tryItem = (it, atkObj, abilityOverride)=>{
        if (it && it === (mon.item||null)) return null;
        try{
          const rr = calc.computeDamageRange({
            data,
            attacker: atkObj,
            defender: defObj,
            moveName,
            settings: {
              ...baseSettings,
              attackerItem: it,
              attackerAbility: (abilityOverride ?? baseSettings.attackerAbility),
            },
            tags,
          });
          return (rr?.ok && rr.oneShot) ? rr : null;
        }catch(e){ return null; }
      };

      // Single-item OHKO.
      for (const it of items){
        const rr = tryItem(it, atkBase);
        if (rr) addOpt([it], `OHKO (min ${formatPct(rr.minPct)})`);
      }

      const baseSpecies = mon.baseSpecies || mon.effectiveSpecies || '';
      const canStr = (!isStarterSpecies(baseSpecies) && !mon.strength);
      const canEvo = (!isStarterSpecies(baseSpecies) && !mon.evo);

      // Strength Charm (no item)
      if (canStr){
        const atkStr = {...atkBase, evAll: state.settings.strengthEV};
        const rr0 = tryItem(mon.item||null, atkStr) || (()=>{
          try{
            const rr = calc.computeDamageRange({data, attacker: atkStr, defender: defObj, moveName, settings: {...baseSettings}, tags});
            return (rr?.ok && rr.oneShot) ? rr : null;
          }catch(e){ return null; }
        })();
        if (rr0) addOpt(['Strength Charm'], `OHKO (min ${formatPct(rr0.minPct)})`);
      }

      // Evo Charm (no item)
      let evoMon = null;
      if (canEvo){
        evoMon = {...mon, evo:true, movePool:(mon.movePool||[]).map(m=>({...m}))};
        try{ applyCharmRulesSync(data, state, evoMon); }catch(e){ evoMon = null; }
        if (evoMon){
          const eff0 = mon.effectiveSpecies || mon.baseSpecies;
          const eff1 = evoMon.effectiveSpecies || evoMon.baseSpecies;
          if (!eff1 || eff1 === eff0) evoMon = null;
        }
      }
      if (evoMon){
        const atkEvo = {...atkBase, species:(evoMon.effectiveSpecies||evoMon.baseSpecies)};
        const rr0 = tryItem(mon.item||null, atkEvo, evoMon.ability||baseSettings.attackerAbility) || (()=>{
          try{
            const rr = calc.computeDamageRange({data, attacker: atkEvo, defender: defObj, moveName, settings: {...baseSettings, attackerAbility:(evoMon.ability||baseSettings.attackerAbility||'')}, tags});
            return (rr?.ok && rr.oneShot) ? rr : null;
          }catch(e){ return null; }
        })();
        if (rr0) addOpt(['Evo Charm'], `OHKO (min ${formatPct(rr0.minPct)})`);
      }

      // Combo: Strength + item
      if (canStr){
        const atkStr = {...atkBase, evAll: state.settings.strengthEV};
        for (const it of items){
          const rr = tryItem(it, atkStr);
          if (rr) addOpt(['Strength Charm', it], `OHKO (min ${formatPct(rr.minPct)})`);
        }
      }

      // Combo: Evo + item
      if (evoMon){
        const atkEvo = {...atkBase, species:(evoMon.effectiveSpecies||evoMon.baseSpecies)};
        for (const it of items){
          const rr = tryItem(it, atkEvo, evoMon.ability||baseSettings.attackerAbility);
          if (rr) addOpt(['Evo Charm', it], `OHKO (min ${formatPct(rr.minPct)})`);
        }
      }

      // Speed flip via scarf for this move (if needed)
      if (baseSlower){
        try{
          const rr = calc.computeDamageRange({data, attacker: atkBase, defender: defObj, moveName, settings: {...baseSettings, attackerItem:'Choice Scarf'}, tags});
          if (rr?.ok && !rr.slower) addOpt(['Choice Scarf'], 'Outspeed');
        }catch(e){}
      }

      return opts;
    };
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

      const tr = el('tr', {style:'cursor:pointer'}, [
        el('td', {}, attackerCell),
        el('td', {}, moveCell),
        el('td', {}, pr),
        el('td', {}, formatPct(row.best.minPct)),
        el('td', {}, el('div', {style:'display:flex; gap:8px; align-items:center'}, [speedPill, scarfPill].filter(Boolean))),
        el('td', {}, el('div', {style:'display:flex; gap:8px; align-items:center'}, [resPill, itemEl].filter(Boolean))),
      ]);

      const isOpen = (expandedId === row.r.id);
      tr.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        store.update(s=>{
          s.ui.attackOverviewExpanded = s.ui.attackOverviewExpanded || {};
          const cur = s.ui.attackOverviewExpanded[expandedKey] || null;
          s.ui.attackOverviewExpanded[expandedKey] = (cur === row.r.id) ? null : row.r.id;
        });
      });

      tbody.appendChild(tr);

      if (isOpen){
        // Expanded details: show other moves + what items/charms can improve them.
        const eff = row.r.effectiveSpecies || row.r.baseSpecies;
        const atkBase = {
          species: eff,
          level: state.settings.claimedLevel,
          ivAll: state.settings.claimedIV,
          evAll: row.r.strength ? state.settings.strengthEV : state.settings.claimedEV,
        };
        const defAb = enemyAbilityForSpecies(data, defName);
        const weather = inferBattleWeatherFromLeads(data, state, [row.r], [{defender:defName, level}]);
        const movePool = filterMovePoolForCalc({ppMap: state.pp || {}, monId: row.r.id, movePool: row.r.movePool || []});
        const baseSettings = {
          ...state.settings,
          attackerItem: row.r.item || null,
          defenderItem: null,
          attackerAbility: (row.r.ability||''),
          defenderAbility: defAb,
          weather,
        };

        let all = [];
        try{
          const resAll = calc.chooseBestMove({data, attacker: atkBase, defender: defObj, movePool, settings: baseSettings, tags});
          all = (resAll?.all || []).slice();
        }catch(e){ all = []; }

        all.sort((a,b)=>{
          const ao = a.oneShot?1:0, bo=b.oneShot?1:0;
          if (ao !== bo) return bo-ao;
          const ap=a.prio??9, bp=b.prio??9;
          if (ap !== bp) return ap-bp;
          return (b.minPct||0)-(a.minPct||0);
        });

        const lines = [];
        for (const mv of all.slice(0, 10)){
          const mvHdr = el('div', {style:'display:flex; justify-content:space-between; gap:12px; align-items:baseline'}, [
            el('div', {style:'font-weight:900'}, mv.move),
            el('div', {class:'muted small'}, `P${mv.prio} · min ${formatPct(mv.minPct)}${mv.oneShot?' · OHKO':''}${mv.slower?' · SLOW':''}`),
          ]);

          const opts = (!mv.oneShot) ? buildOhkoOptions({atkBase, defObj, baseSettings, tags, mon: row.r, moveName: mv.move, baseSlower: !!mv.slower}) : [];
          let optEl = null;
          if (opts.length){
            const optNodes = [];
            opts.slice(0, 6).forEach((o, i)=>{
              if (i) optNodes.push(el('span', {class:'muted small', style:'padding:0 8px'}, 'OR'));
              optNodes.push(el('span', {style:'display:inline-flex; align-items:center; gap:8px'}, [
                renderPartsWithPlus(o.parts),
                el('span', {class:'muted small'}, o.note || ''),
              ]));
            });
            optEl = el('div', {class:'muted small', style:'margin-top:6px'}, [
              el('span', {style:'font-weight:700'}, 'Improves with: '),
              ...optNodes,
            ]);
          }

          lines.push(el('div', {style:'padding:6px 0; border-top:1px solid rgba(255,255,255,0.06)'}, [mvHdr, optEl].filter(Boolean)));
        }

        const wrap = el('div', {style:'padding:10px 0'}, [
          el('div', {class:'muted small'}, 'Other moves (click row again to collapse).'),
          ...lines,
        ]);

        tbody.appendChild(el('tr', {}, [
          el('td', {colspan:'6'}, wrap),
        ]));
      }
    }

    tbl.appendChild(tbody);
    bodyEl?.appendChild(tbl);
  }

  return { attach, render };
}
