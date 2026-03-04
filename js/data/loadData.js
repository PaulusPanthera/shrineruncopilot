// js/data/loadData.js
// alpha v1
// Load JSON data and derive dynamic tags/caches.

import { fixName } from './nameFixes.js';
import { fixMoveName } from './moveFixes.js';
import { applyMovesetOverrides } from '../domain/shrineRules.js';

// Tags that are computed dynamically from claimedSets (and MUST never be trusted from calcSlots).
// If a tag isn't provably true from the pinned set, it should not appear.
const SYSTEM_TAGS = new Set([
  'FO','HH','INT','STU','SR','MS','SUN','STA','RS','PRIO',
  // Legacy/noise tokens to strip if they exist in older wave sheets:
  'Rough','Skin','Rough Skin','Kel'
]);

// PRIO tag means: the pinned set has at least one *attacking* move with explicit positive priority.
// (We intentionally do NOT tag pure utility/status moves like Protect.)
function isPriorityAttack(moveName, moveDb){
  const mv = moveDb ? moveDb[moveName] : null;
  if (!mv) return false;
  const cat = String(mv.category || '').trim();
  if (cat !== 'Physical' && cat !== 'Special') return false;
  const p = Number(mv.priority || 0);
  return p > 0;
}

function uniq(arr){
  return Array.from(new Set((arr||[]).filter(Boolean)));
}

function deriveTagsForSpecies(species, claimedSet, moveDb){
  const out = [];
  const ability = String(claimedSet?.ability || '').trim();
  const rawMoves = Array.isArray(claimedSet?.moves) ? claimedSet.moves : [];
  const fixedMoves = applyMovesetOverrides(species, rawMoves).map(fixMoveName);

  // Ability-based tags
  if (ability === 'Intimidate') out.push('INT');
  if (ability === 'Sturdy') out.push('STU');
  if (ability === 'Drought') out.push('SUN');
  if (ability === 'Static') out.push('STA');
  if (ability === 'Solid Rock') out.push('SR');
  if (ability === 'Multiscale') out.push('MS');
  if (ability === 'Rough Skin') out.push('RS');

  // Move-based tags
  if (fixedMoves.includes('Fake Out')) out.push('FO');
  if (fixedMoves.includes('Helping Hand')) out.push('HH');

  // Priority-move tag
  if (fixedMoves.some(m => isPriorityAttack(m, moveDb))) out.push('PRIO');

  return uniq(out);
}
// NOTE: GitHub Pages can aggressively cache JSON assets across deployments.
// Use `cache: 'no-store'` so a normal reload reliably picks up updated data.
async function fetchJson(path){
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch ${path}: ${r.status}`);
  return await r.json();
}

async function fetchJsonOptional(path, fallback){
  try{
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  }catch{
    return fallback;
  }
}

export async function loadData(){
  const [dex, moves, typing, rules, stages, calcSlots, claimedSets, waveLoot] = await Promise.all([
    fetchJson('data/dex.json'),
    fetchJson('data/moves.json'),
    fetchJson('data/typing.json'),
    fetchJson('data/rules.json'),
    fetchJson('data/stages.json'),
    fetchJson('data/calcSlots.json'),
    fetchJson('data/claimedSets.json'),
    fetchJsonOptional('data/waveLoot.json', {}),
  ]);


  // Normalize move names inside claimedSets so the app uses canonical names everywhere.
  for (const [sp, obj] of Object.entries(claimedSets||{})){
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj.moves)) obj.moves = obj.moves.map(fixMoveName);
    if (typeof obj.ability === 'string') obj.ability = String(obj.ability).trim();
  }

  // Apply name fixes to calc slots + dynamically derive calc-relevant tags
  // from the locked claimedSets (so tags stay correct if movesets change).
  const fixedSlots = (calcSlots || []).map(x => {
    const defender = fixName(x.defender);
    const baseTags = Array.isArray(x.tags) ? x.tags.filter(Boolean).map(t => String(t).trim()) : [];
    const kept = baseTags.filter(t => !SYSTEM_TAGS.has(t));
    const derived = deriveTagsForSpecies(defender, claimedSets?.[defender], moves);
    const tags = Array.from(new Set([...kept, ...derived]));

    return {
      ...x,
      defender,
      tags,
      animal: x.animal ? String(x.animal) : x.animal,
      rowKey: x.rowKey,
    };
  });

  return { dex, moves, typing, rules, stages, calcSlots: fixedSlots, claimedSets, waveLoot: waveLoot || {} };
}
