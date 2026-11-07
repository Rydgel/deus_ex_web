import {switchReader} from '../runtime/switch-reader.mjs';

/** 'on' (default), 'js' or 'verify': ACTOR_TAIL / DEUS_EX_ACTOR_TAIL / `?actorTail=` (docs/firefox-60fps-plan.md "Actors phase (2026-11-07)").
 * The long tail of the actor layer's host work once the bulk passes had taken the per-binding loops, two bodies that give the same
 * values as the ones they replace:
 *
 *   candidateWords   the root frame's packed candidates are copied into a kept scratch (dynamics-candidates.mjs), not into a
 *                    `.slice()` of 25 to 30 KB made at every occlusion run
 *   permeatingRun    a BSP leaf's permeating static lights as handles are kept across frames while the level's model, its actor
 *                    name map and its Level.Actors epoch are the ones they were made for (mesh-lighting-view.mjs)
 *
 * 'js' keeps the replaced bodies; 'verify' runs both and throws on a difference. */
export const actorTailMode = switchReader('ACTOR_TAIL', 'DEUS_EX_ACTOR_TAIL', 'on');
