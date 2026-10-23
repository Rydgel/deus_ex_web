/** Scratch: inspect the Training state after the first-map gates (not part of the harness). */
import { runChainInPlay, typeLine } from './chain-play.mjs';
import { loadChain } from './chain-lib.mjs';
const chain = await loadChain('00');
const result = await runChainInPlay(chain, { until: process.argv[2] ?? 'a1b-gates' });
const c = result.session;
console.log('health', c.read(c.player(), 'Health'), 'state', c.state(c.player()), 'pos', c.pos(c.player()).map(Math.round));
const inv = []; for (let i = c.read(c.player(), 'Inventory'); i && inv.length < 20; i = c.read(i, 'Inventory')) inv.push(`${i.name}@${c.read(i, 'beltPos')}`);
console.log('inventory', inv.join(' '), 'inHand', c.read(c.player(), 'inHand')?.name);
console.log('travel pending', JSON.stringify(c.takeTravel()?.url ?? null));
const kp = c.actor('Keypad2');
console.log('keypad2 hackStrength', c.read(kp, 'hackStrength'), 'bHackable?', c.read(kp, 'bHackable'), 'frobTarget', c.game.interaction.frobTarget?.name);
process.exit(0);
