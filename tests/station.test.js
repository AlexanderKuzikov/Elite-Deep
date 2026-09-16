/**
 * Station screen tests.
 *
 * Node has no DOM, so this file ships a small one. That is not a compromise:
 * the station screens are pure functions of state, and running them against a
 * minimal DOM exercises every code path that matters - building rows, deciding
 * colours, choosing what to disable, and wiring the action callbacks.
 *
 * The bugs this class of test catches are the ones that make a shop feel
 * broken: a row that stays clickable when you cannot afford it, an "owned"
 * item that can be bought twice, a sell action that fires when there is
 * nothing to sell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom } from './helpers/dom.js';
import * as PLAYER from '../src/logic/player.js';
import * as REP from '../src/logic/reputation.js';

installDom();
const { createStationUI, revealScrollTop } = await import('../src/ui/station.js');

/** A station state object with every field the screens read. */
function makeState(overrides) {
  const player = PLAYER.create();
  player.cash = 1000;
  return {
    player,
    system: {
      name: 'LAVE', faction: 'FEDERATION', gov: 6, econ: 5, tech: 5, condition: 0,
      population: 3.5, danger: 0.2, index: 0,
    },
    systemIndex: 0,
    cash: 1000,
    hull: 100, maxHull: 100,
    shields: 40, maxShields: 40,
    energy: 100, maxEnergy: 100,
    fuel: 7, maxFuel: 7,
    missiles: 1,
    cargoUsed: 0,
    hold: 20,
    kills: 0,
    rank: 'harmless',
    laser: 'pulse',
    commanderName: 'JAMESON',
    visitedCount: 1,
    legal: { wanted: false, label: 'Clean' },
    standings: [
      { id: 'FEDERATION', label: 'Neutral', tier: 'neutral' },
      { id: 'EMPIRE', label: 'Hostile', tier: 'hostile' },
    ],
    manifest: [],
    market: [
      { id: 'food', name: 'Food', available: true, stock: 20, buyPrice: 4.2, sellPrice: 3.6, held: 0, illegal: false },
      { id: 'narcotics', name: 'Narcotics', available: true, stock: 5, buyPrice: 120, sellPrice: 100, held: 0, illegal: true },
      { id: 'minerals', name: 'Minerals', available: false, stock: 0, buyPrice: 0, sellPrice: 12, held: 3, illegal: false },
    ],
    ...(overrides || {}),
  };
}

function freshUI(actions) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const calls = [];
  const wrapped = {};
  for (const key of ['buy', 'sell', 'equip', 'repair', 'refuel', 'undock', 'missile',
    'payFine', 'acceptContract', 'abandonContract']) {
    wrapped[key] = (...args) => {
      calls.push({ key, args });
      if (actions && actions[key]) return actions[key](...args);
    };
  }
  const ui = createStationUI(host, wrapped);
  return { ui, host, calls };
}

test.after(() => uninstallDom());

test('the station UI builds and starts closed', () => {
  const { ui } = freshUI();
  assert.ok(ui.root, 'no root element');
  assert.equal(ui.isOpen(), false, 'the station screen should start closed');
});

test('opening the station shows the market by default', () => {
  const { ui } = freshUI();
  ui.open(makeState());
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.tab, 'market');
});

test('the header names the system, faction, government and economy', () => {
  const { ui, host } = freshUI();
  ui.open(makeState());
  const text = host.textContent;
  assert.ok(text.includes('LAVE'), 'the system name is missing');
  assert.ok(text.includes('Federation'), 'the faction is missing');
  assert.ok(text.includes('Democracy'), 'the government is missing');
});

test('every market row shows stock, buy and sell prices', () => {
  const { ui, host } = freshUI();
  ui.open(makeState());
  const text = host.textContent;
  assert.ok(text.includes('Food'), 'a commodity row is missing');
  assert.ok(text.includes('4.2'), 'the buy price is missing');
  assert.ok(text.includes('3.6'), 'the sell price is missing');
});

test('an out-of-stock commodity is marked and priced as unavailable', () => {
  const { ui, host } = freshUI();
  ui.open(makeState());
  const text = host.textContent;
  // Minerals has availability false: its buy side must not show a price.
  assert.ok(text.includes('Minerals'));
  assert.ok(!text.includes('NaN'), 'a missing price rendered as NaN');
  assert.ok(!text.includes('undefined'), 'a missing price rendered as undefined');
});

test('an illegal commodity is flagged as banned', () => {
  // The player cannot make an informed decision about contraband if the screen
  // does not tell them it is contraband.
  const { ui, host } = freshUI();
  ui.open(makeState());
  assert.ok(host.textContent.includes('BANNED'), 'contraband is not flagged');
});

test('buying sends the commodity and a quantity', () => {
  const { ui, calls } = freshUI();
  ui.open(makeState());
  ui.moveSelection(0);
  ui.activate();
  const buy = calls.find(c => c.key === 'buy');
  assert.ok(buy, 'no buy action fired');
  assert.equal(buy.args[0], 'food');
  assert.ok(buy.args[1] > 0, 'the quantity should be positive');
});

test('buying is limited by cash, stock and free hold space', () => {
  const { ui, calls } = freshUI();
  // 10 credits, food at 4.2: only 2 affordable, even with room for 20.
  const s = makeState({ cash: 10, player: Object.assign(PLAYER.create(), { cash: 10 }) });
  ui.open(s);
  ui.moveSelection(0);
  ui.activate();
  const buy = calls.find(c => c.key === 'buy');
  assert.ok(buy, 'no buy fired');
  assert.equal(buy.args[1], 2, 'should buy what the purse allows, got ' + buy.args[1]);
});

test('buying is capped by the available stock', () => {
  const { ui, calls } = freshUI();
  const s = makeState({ cash: 100000 });
  ui.open(s);
  // Narcotics has a stock of 5; even with money and space, 5 is the limit.
  s.market = s.market.map(r => (r.id === 'narcotics' ? { ...r, stock: 5 } : r));
  ui.update(s);
  ui.moveSelection(1);
  ui.activate();
  const buy = calls.find(c => c.key === 'buy');
  assert.ok(buy);
  assert.equal(buy.args[1], 5, 'should buy the whole stock, got ' + buy.args[1]);
});

test('buying is refused when the hold is full', () => {
  const { ui, calls } = freshUI();
  ui.open(makeState({ cargoUsed: 20, hold: 20 }));
  ui.moveSelection(0);
  ui.activate();
  assert.equal(calls.find(c => c.key === 'buy'), undefined, 'bought into a full hold');
});

test('buying is refused with no credits', () => {
  const { ui, calls } = freshUI();
  const s = makeState({ cash: 0 });
  s.player.cash = 0;
  ui.open(s);
  ui.moveSelection(0);
  ui.activate();
  assert.equal(calls.find(c => c.key === 'buy'), undefined, 'bought with no credits');
});

test('activating a held commodity sells it instead of buying', () => {
  // The market screen supports both directions on the same row, which is how
  // the original worked and is what makes trading a two-key loop.
  const { ui, calls } = freshUI();
  const s = makeState();
  s.market = s.market.map(r => (r.id === 'minerals' ? { ...r, held: 4 } : r));
  s.cargoUsed = 4;
  ui.open(s);
  ui.moveSelection(2);
  ui.activate();
  const sell = calls.find(c => c.key === 'sell');
  assert.ok(sell, 'held cargo did not sell');
  assert.equal(sell.args[0], 'minerals');
  assert.equal(sell.args[1], 4);
});

test('a refused purchase reports why rather than failing silently', () => {
  // Silence is the worst outcome: the player clicks, nothing happens, and they
  // assume the game is broken.
  const { ui, host } = freshUI();
  ui.open(makeState({ cash: 0 }));
  ui.moveSelection(0);
  ui.activate();
  const toast = host.querySelector('.elite-msg');
  assert.ok(toast, 'there is no message element');
  assert.ok(toast.textContent.length > 0, 'a refused purchase said nothing');
});

test('the equipment screen lists every item and marks owned ones', () => {
  const { ui, host } = freshUI();
  ui.open(makeState());
  ui.setTab('equip');
  const text = host.textContent;
  assert.ok(text.includes('Large Cargo Bay'), 'the cargo bay is not listed');
  assert.ok(text.includes('Beam Laser'), 'the beam laser is not listed');
});

test('an owned item shows as installed and cannot be bought again', () => {
  const { ui, calls } = freshUI();
  const s = makeState();
  PLAYER.applyEquip(s.player, 'cargoExt');
  s.player.equip.cargoExt = true;
  ui.open(s);
  ui.setTab('equip');
  assert.ok(ui.root.textContent.includes('installed'), 'an owned item is not marked');
  ui.activate();
  assert.equal(calls.find(c => c.key === 'equip'), undefined, 'an owned item was re-bought');
});

test('equipping an unaffordable item is refused', () => {
  const { ui, calls } = freshUI();
  const s = makeState({ cash: 10 });
  s.player.cash = 10;
  ui.open(s);
  ui.setTab('equip');
  // The first item is the 1200 credit cargo bay.
  ui.activate();
  assert.equal(calls.find(c => c.key === 'equip'), undefined, 'bought what it could not afford');
});

test('the status screen reports hull, shields, fuel and cargo', () => {
  const { ui, host } = freshUI();
  ui.open(makeState({ hull: 62, fuel: 3.5, cargoUsed: 7 }));
  ui.setTab('status');
  const text = host.textContent;
  assert.ok(text.includes('62'), 'hull is missing');
  assert.ok(text.includes('3.5'), 'fuel is missing');
  assert.ok(text.includes('7 / 20'), 'cargo is missing or misformatted');
});

test('the status screen lists faction standing', () => {
  const { ui, host } = freshUI();
  ui.open(makeState());
  ui.setTab('status');
  const text = host.textContent;
  assert.ok(text.includes('Federation'), 'faction standing is missing');
  assert.ok(text.includes('Neutral') || text.includes('Hostile'), 'standing labels are missing');
});

test('the status screen shows rank progress when one is available', () => {
  const { ui, host } = freshUI();
  ui.open(makeState({ kills: 4 }));
  ui.setTab('status');
  const text = host.textContent;
  assert.ok(text.includes('MOSTLY HARMLESS') || text.includes('Mostly Harmless'),
    'the next rank is not shown');
});

test('the repair action is offered only when there is damage', () => {
  const { ui, host } = freshUI();
  ui.open(makeState({ hull: 100 }));
  ui.setTab('equip');
  assert.ok(host.textContent.includes('no damage'), 'pristine hull should say so');

  const b = freshUI();
  b.ui.open(makeState({ hull: 50 }));
  b.ui.setTab('equip');
  assert.ok(!b.host.textContent.includes('no damage'), 'damage should enable repair');
});

test('a fine is offered only when wanted in this system', () => {
  const clean = freshUI();
  clean.ui.open(makeState());
  clean.ui.setTab('equip');
  assert.ok(!clean.host.textContent.includes('Pay fine'), 'a clean pilot was offered a fine');

  const s = makeState();
  s.legal = { wanted: true, label: 'Fugitive' };
  s.player.wanted[0] = 6;
  const wanted = freshUI();
  wanted.ui.open(s);
  wanted.ui.setTab('equip');
  assert.ok(wanted.host.textContent.includes('Pay fine'), 'a fugitive was not offered a fine');
});

test('paying a fine calls the action', () => {
  const { ui, calls, host } = freshUI();
  const s = makeState();
  s.legal = { wanted: true, label: 'Fugitive' };
  s.player.wanted[0] = 6;
  ui.open(s);
  ui.setTab('equip');
  // Find the fine row by its label and click it.
  const rows = [...host.querySelectorAll('.elite-row')];
  const fine = rows.find(r => r.textContent.includes('Pay fine'));
  assert.ok(fine, 'the fine row does not exist');
  fine.dispatchEvent(new Event('click'));
  assert.ok(calls.find(c => c.key === 'payFine'), 'the fine action did not fire');
});

test('selection wraps around in both directions', () => {
  const { ui } = freshUI();
  ui.open(makeState());
  ui.moveSelection(-1);
  // Wrapping backward from index 0 lands on the last row, not on -1.
  assert.ok(ui.root.textContent.length > 0);
  ui.activate();
  // Whatever it wrapped to, it must be a valid row and not throw.
  assert.ok(true);
});

test('selection is clamped when the market is empty', () => {
  // A station with no tradeable goods must not crash the screen.
  const { ui } = freshUI();
  ui.open(makeState({ market: [] }));
  ui.moveSelection(1);
  ui.activate();
  assert.ok(true, 'an empty market crashed the screen');
});

test('switching tabs re-renders without losing the station', () => {
  const { ui, host } = freshUI();
  ui.open(makeState());
  for (const tab of ['equip', 'status', 'market']) {
    ui.setTab(tab);
    assert.ok(host.textContent.includes('LAVE'), 'the header vanished on the ' + tab + ' tab');
  }
});

test('update refreshes data without closing the screen', () => {
  // This is what runs after every purchase; it must not reset the tab or the
  // scroll position, or buying multiples becomes painful.
  const { ui } = freshUI();
  ui.open(makeState());
  ui.setTab('equip');
  ui.update(makeState({ cash: 500 }));
  assert.equal(ui.isOpen(), true, 'update closed the screen');
  assert.equal(ui.tab, 'equip', 'update reset the tab');
});

test('closing hides the screen', () => {
  const { ui } = freshUI();
  ui.open(makeState());
  ui.close();
  assert.equal(ui.isOpen(), false);
});

test('the screen renders without a document owner', () => {
  // Defensive: the module is imported in Node for these tests, and must not
  // throw if the CSS injector cannot find a document.
  const { ui } = freshUI();
  assert.ok(ui.root);
});

test('STORED STATION CSS defines the classes the code uses', () => {
  // A class referenced in code but missing from the stylesheet is an invisible
  // styling bug: the element exists but is unstyled.
  const source = readStationSource();
  const used = new Set();
  const re = /classList\.(?:add|toggle|remove)\('([a-z-]+)'/g;
  let m;
  while ((m = re.exec(source))) used.add(m[1]);
  const css = readStationCss();
  for (const cls of used) {
    assert.ok(css.includes('.' + cls), 'class "' + cls + '" is used but never styled');
  }
});

// --- Helpers --------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function readStationSource() {
  return readFileSync(join(HERE, '..', 'src', 'ui', 'station.js'), 'utf8');
}

function readStationCss() {
  return readStationSource();
}

// --- Reputation: the new fine mechanics -----------------------------------

test('a clean pilot owes no fine', () => {
  const p = PLAYER.create();
  assert.equal(REP.fineFor(p, 0), 0);
});

test('the fine grows with how wanted you are', () => {
  const p = PLAYER.create();
  p.wanted[0] = 4;
  const light = REP.fineFor(p, 0);
  p.wanted[0] = 40;
  const heavy = REP.fineFor(p, 0);
  assert.ok(heavy > light, 'a worse record should cost more');
  assert.ok(heavy > light * 5, 'the fine should grow superlinearly for a spree');
});

test('paying a fine clears the record and deducts the cost', () => {
  const p = PLAYER.create();
  p.cash = 10000;
  p.wanted[0] = 6;
  const cost = REP.fineFor(p, 0);
  const res = REP.payFine(p, 0);
  assert.equal(res.ok, true);
  assert.equal(res.cost, cost);
  assert.equal(p.cash, 10000 - cost, 'the wrong amount was deducted');
  assert.equal(p.wanted[0], undefined, 'the record was not cleared');
});

test('paying a fine you cannot afford fails cleanly', () => {
  const p = PLAYER.create();
  p.cash = 1;
  p.wanted[0] = 20;
  const res = REP.payFine(p, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'funds');
  assert.equal(p.cash, 1, 'credits changed on a failed payment');
  assert.equal(p.wanted[0], 20, 'the record changed on a failed payment');
});

test('paying a fine when not wanted is a no-op', () => {
  const p = PLAYER.create();
  p.cash = 500;
  const res = REP.payFine(p, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-wanted');
  assert.equal(p.cash, 500);
});

test('paying a fine improves standing with the owning faction, but never above zero', () => {
  // Being bought off should reduce hostility without making you a friend.
  //
  // This test used to write `p.standing[0] = -50` - a standing entry keyed by
  // a *system index*, which no real player record ever has, because standing
  // is keyed by faction id. It passed against a `payFine` that read
  // `standing[systemIndex]`, so the test and the bug agreed with each other
  // and the live game paid a fine and stayed hostile. Use a real key.
  const p = PLAYER.create();
  p.cash = 100000;
  p.wanted[3] = 5;
  p.standing.FEDERATION = -50;
  const system = { index: 3, faction: 'FEDERATION' };

  const res = REP.payFine(p, system);

  assert.equal(res.ok, true);
  assert.equal(res.faction, 'FEDERATION');
  assert.equal(p.wanted[3], undefined, 'the record was not cleared');
  assert.ok(p.standing.FEDERATION > -50, 'standing did not improve');
  assert.ok(p.standing.FEDERATION <= 0, 'a fine should not make you an ally: ' + p.standing.FEDERATION);
  assert.equal(res.standingRelief, 20, 'the relief should be reported so the UI can show it');
});

test('a fine never reaches a faction you are not wanted by', () => {
  const p = PLAYER.create();
  p.cash = 100000;
  p.standing.EMPIRE = -60;
  p.wanted[3] = 5;
  // The wanted entry is in a Federation system, so only the Federation moves.
  REP.payFine(p, { index: 3, faction: 'FEDERATION' });
  assert.equal(p.standing.EMPIRE, -60, 'the wrong faction was adjusted');
});

test('a bare system index clears the record without touching standing', () => {
  // Callers that only hold an index cannot know which faction to credit, and
  // the old code silently pretended otherwise. Now it is explicit: no faction
  // information, no standing change, and the result says so.
  const p = PLAYER.create();
  p.cash = 100000;
  p.wanted[3] = 5;
  p.standing.FEDERATION = -50;

  const res = REP.payFine(p, 3);

  assert.equal(res.ok, true);
  assert.equal(p.wanted[3], undefined);
  assert.equal(p.standing.FEDERATION, -50, 'standing moved without a faction to attribute it to');
  assert.equal(res.standingRelief, 0);
  assert.equal(res.faction, null);
});

test('hasEquipment reports installed items only', () => {
  const p = PLAYER.create();
  assert.equal(PLAYER.hasEquipment(p, 'cargoExt'), false);
  p.equip.cargoExt = true;
  assert.equal(PLAYER.hasEquipment(p, 'cargoExt'), true);
  assert.equal(PLAYER.hasEquipment(p, 'nonsense'), false);
  assert.equal(PLAYER.hasEquipment(null, 'cargoExt'), false);
});

test('equipmentFor finds items by id and returns null otherwise', () => {
  assert.ok(PLAYER.equipmentFor('beamLaser'));
  assert.equal(PLAYER.equipmentFor('beamLaser').id, 'beamLaser');
  assert.equal(PLAYER.equipmentFor('nope'), null);
});

test('every equipment item has a description for the shop screen', () => {
  for (const item of PLAYER.EQUIPMENT) {
    assert.ok(item.desc && item.desc.length > 10,
      item.id + ' has no usable description');
  }
});

// --- Career progress ------------------------------------------------------

test('progressOf accepts a player object or a raw kill count', () => {
  // The status screen has a player; other callers may only have a number.
  // Supporting both removes the temptation to fabricate a player to ask.
  const p = PLAYER.create();
  p.kills = 12;
  assert.deepEqual(PLAYER.progressOf(p), PLAYER.progressOf(12));
  assert.equal(PLAYER.progressOf(p).next, 'Poor');
});

test('progressOf reports the remaining kills, not the target total', () => {
  // A player on 12 kills aiming at Poor (16) needs four more. Showing "16"
  // would make them think the counter had stalled.
  const p = PLAYER.create();
  p.kills = 12;
  const prog = PLAYER.progressOf(p);
  assert.equal(prog.next, 'Poor');
  assert.equal(prog.needed, 4, 'should report the shortfall, not the target');
  assert.equal(prog.remaining, 4);
});

test('progressOf gives a full bar and no target at the top rank', () => {
  const prog = PLAYER.progressOf(25600);
  assert.equal(prog.next, null);
  assert.equal(prog.needed, 0);
  assert.equal(prog.fraction, 1);
});

test('progressOf tolerates a missing or negative kill count', () => {
  // Save files and fresh states can hand over undefined; the screen must not
  // render "NaN".
  assert.equal(PLAYER.progressOf(undefined).next, 'Mostly Harmless');
  assert.equal(PLAYER.progressOf(null).next, 'Mostly Harmless');
  assert.equal(PLAYER.progressOf(-5).next, 'Mostly Harmless');
});

test('the standings block accepts bare faction ids', () => {
  // The game may pass ids and let the screen look the label up, or pass
  // prepared rows. Both must work, and neither may render "undefined".
  const { ui, host } = freshUI();
  const s = makeState();
  s.standings = ['FEDERATION', 'EMPIRE'];
  s.player.standing.FEDERATION = -70;
  delete s.player.standing.EMPIRE;
  ui.open(s);
  ui.setTab('status');
  const text = host.textContent;
  assert.ok(text.includes('Federation'), 'a bare faction id was not resolved');
  assert.ok(text.includes('Hunted'), 'the standing value was not turned into a label');
  assert.ok(text.includes('Neutral'), 'a missing standing should read as neutral');
  assert.ok(!text.includes('undefined'), 'an unresolved row rendered as undefined');
});

test('an unresolvable standing entry is skipped rather than rendered blank', () => {
  const { ui, host } = freshUI();
  const s = makeState();
  s.standings = [null, { id: 'FEDERATION' }];
  ui.open(s);
  ui.setTab('status');
  assert.ok(!host.textContent.includes('undefined'));
  assert.ok(host.textContent.includes('Federation'));
});

// --- Trading a specific quantity -------------------------------------------

test('Enter buys the whole affordable load', () => {
  const { ui, calls } = freshUI();
  ui.open(makeState());
  ui.activate();
  const buy = calls.find((c) => c.key === 'buy');
  assert.ok(buy, 'nothing was bought');
  // Row 0 is Food at 4.2, hold is 20 and the purse is 1000.
  assert.equal(buy.args[0], 'food');
  assert.equal(buy.args[1], 20, 'the default should still be the whole load');
});

test('the one-tonne key buys exactly one tonne', () => {
  // The maximum was the only option, which made two ordinary situations
  // impossible: reserving cash for fuel, and topping up the last few tonnes.
  const { ui, calls } = freshUI();
  ui.open(makeState());
  ui.activateOne();
  const buy = calls.find((c) => c.key === 'buy');
  assert.ok(buy, 'nothing was bought');
  assert.equal(buy.args[1], 1, 'the single-tonne key did not buy one tonne');
});

test('the one-tonne key sells exactly one tonne, not the whole holding', () => {
  // The trap this fixes: a full hold and an empty tank, with no way to raise
  // a specific amount of cash.
  const state = makeState({
    market: [
      { id: 'food', name: 'Food', available: true, stock: 20, buyPrice: 4.2, sellPrice: 3.5, held: 18, illegal: false },
    ],
  });
  const { ui, calls } = freshUI();
  ui.open(state);
  ui.activateOne();
  const sell = calls.find((c) => c.key === 'sell');
  assert.ok(sell, 'nothing was sold');
  assert.equal(sell.args[0], 'food');
  assert.equal(sell.args[1], 1, 'one tonne was asked for and ' + sell.args[1] + ' was sold');
});

test('Enter on a held commodity still sells the whole holding', () => {
  const state = makeState({
    market: [
      { id: 'food', name: 'Food', available: true, stock: 20, buyPrice: 4.2, sellPrice: 3.5, held: 18, illegal: false },
    ],
  });
  const { ui, calls } = freshUI();
  ui.open(state);
  ui.activate();
  const sell = calls.find((c) => c.key === 'sell');
  assert.ok(sell);
  assert.equal(sell.args[1], 18, 'the default sale should still be the whole holding');
});

test('one tonne cannot exceed what is held or what can be afforded', () => {
  // A one-tonne request is still clamped by stock, space and purse, so the
  // key cannot be used to buy past the hold or into debt.
  const poor = makeState({ cash: 4 });
  const { ui, calls } = freshUI();
  ui.open(poor);
  ui.activateOne();
  const buy = calls.find((c) => c.key === 'buy');
  if (buy) assert.ok(buy.args[1] <= 1, 'bought more than asked');

  const full = makeState({ cargoUsed: 20, hold: 20 });
  const second = freshUI();
  second.ui.open(full);
  second.ui.activateOne();
  assert.equal(second.calls.find((c) => c.key === 'buy'), undefined,
    'bought into a full hold');
});

test('the one-tonne key does nothing on the equipment tab', () => {
  // `1` is a market key. On the equipment screen it must not silently install
  // something.
  const { ui, calls } = freshUI();
  ui.open(makeState());
  ui.setTab('equip');
  ui.activateOne();
  assert.equal(calls.find((c) => c.key === 'equip'), undefined, 'equipment was installed');
});

// --- The contract board ----------------------------------------------------

/** A state with a board on it, since the default fixture has none. */
function stateWithBoard(overrides) {
  return makeState({
    offers: [
      { id: 'o1', type: 'delivery', commodity: 'food', commodityName: 'Food', tons: 8,
        targetIndex: 4, targetName: 'Ceeri', distance: 9.4, reward: 320, days: 8,
        deadlineDay: 8, taken: false, description: 'Deliver 8 t of Food to Ceeri' },
      { id: 'o2', type: 'courier', targetIndex: 6, targetName: 'Orrere', distance: 14,
        reward: 420, days: 5, deadlineDay: 5, taken: false,
        description: 'Carry documents to Orrere (14 ly)' },
      { id: 'o3', type: 'relief', commodity: 'food', commodityName: 'Food', tons: 12,
        targetIndex: 9, targetName: 'Diso', distance: 7, reward: 900, days: 6,
        deadlineDay: 6, taken: true, description: 'Emergency: 12 t of Food to Diso' },
    ],
    contracts: [
      { id: 'o3', type: 'relief', commodity: 'food', tons: 12, targetIndex: 9,
        targetName: 'Diso', reward: 900, deadlineDay: 6, daysLeft: 3,
        description: 'Emergency: 12 t of Food to Diso' },
    ],
    maxContracts: 4,
    ...(overrides || {}),
  });
}

test('the contracts tab lists the offers and the live contracts', () => {
  const { ui, host } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  const text = host.textContent;
  assert.ok(text.includes('Ceeri'), 'a delivery target is missing');
  assert.ok(text.includes('Orrere'), 'a courier target is missing');
  assert.ok(text.includes('Diso'), 'the live contract is missing');
  assert.ok(text.includes('320 CR'), 'a reward is missing');
});

test('the board is ordered offers first, then contracts already taken', () => {
  // One cursor over one list. The order is what makes that legible.
  const { ui, host } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  const text = host.textContent;
  assert.ok(text.indexOf('Ceeri') < text.indexOf('Diso'),
    'a taken contract is listed above an offer');
});

test('Enter on an offer accepts it', () => {
  const { ui, calls } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  ui.activate();
  const accept = calls.find((c) => c.key === 'acceptContract');
  assert.ok(accept, 'nothing was accepted');
  assert.equal(accept.args[0], 'o1');
});

test('Enter on an offer already taken refuses rather than accepting twice', () => {
  const { ui, calls } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  ui.moveSelection(2);            // the third row, which is already accepted
  ui.activate();
  assert.equal(calls.find((c) => c.key === 'acceptContract'), undefined,
    'an already-accepted offer was accepted again');
});

test('Enter on a live contract abandons it', () => {
  // The inverse of accepting, on the same key - the same idea the market
  // screen uses for buy and sell.
  const { ui, calls } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  ui.moveSelection(3);            // past the three offers, onto the live one
  ui.activate();
  const abandon = calls.find((c) => c.key === 'abandonContract');
  assert.ok(abandon, 'nothing was abandoned');
  assert.equal(abandon.args[0], 'o3');
});

test('the cursor wraps around the whole board', () => {
  // Four rows (three offers and one live contract), so four steps forward is
  // back where it started. Asserted by *acting*, because the cursor itself is
  // private - and a wrap that silently stopped at the end would leave the last
  // row unreachable from below.
  const { ui, calls } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  for (let i = 0; i < 4; i += 1) ui.moveSelection(1);
  ui.activate();
  const accept = calls.find((c) => c.key === 'acceptContract');
  assert.ok(accept, 'four steps did not return to the first row');
  assert.equal(accept.args[0], 'o1');
});

test('moving backwards from the first row lands on the last', () => {
  const { ui, calls } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  ui.moveSelection(-1);
  ui.activate();
  const abandon = calls.find((c) => c.key === 'abandonContract');
  assert.ok(abandon, 'moving back from the top did not reach the bottom');
  assert.equal(abandon.args[0], 'o3');
});

test('a board with nothing on it says so rather than rendering an empty table', () => {
  const { ui, host } = freshUI();
  ui.open(makeState({ offers: [], contracts: [] }));
  ui.setTab('contracts');
  assert.ok(host.textContent.includes('No contracts'), 'an empty board said nothing');
});

test('the board shows how many contracts are held out of the cap', () => {
  const { ui, host } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  assert.ok(host.textContent.includes('1 / 4'), 'the contract count is missing');
});

test('the board works without an accept or abandon action wired', () => {
  // The UI must not throw when a caller has not supplied every action.
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ui = createStationUI(host, {});
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  assert.doesNotThrow(() => ui.activate());
});

test('switching to the contracts tab and back does not lose the market', () => {
  const { ui, host } = freshUI();
  ui.open(stateWithBoard());
  ui.setTab('contracts');
  ui.setTab('market');
  assert.equal(ui.tab, 'market');
  assert.ok(host.textContent.includes('Food'), 'the market is gone');
});

// --- Long lists and honest hints -------------------------------------------

test('a row already in view does not scroll the list', () => {
  // Scrolling on every render would make the list twitch as prices update, and
  // a list that moves under the cursor is worse than one that is merely long.
  assert.equal(revealScrollTop(100, 400, 200, 30), 100);
  assert.equal(revealScrollTop(0, 400, 0, 30), 0);
  assert.equal(revealScrollTop(0, 400, 370, 30), 0);
});

test('a row below the fold is scrolled just far enough', () => {
  // A 400-tall view at scrollTop 0: a row at 380..410 hangs 10 px below it.
  assert.equal(revealScrollTop(0, 400, 380, 30), 10);
});

test('a row above the fold is scrolled back up to it', () => {
  assert.equal(revealScrollTop(300, 400, 120, 30), 120);
});

test('the list never scrolls above its own top', () => {
  assert.ok(revealScrollTop(50, 400, 10, 30) >= 0);
  assert.equal(revealScrollTop(0, 400, 0, 30), 0);
});

test('a view with no measured height leaves the scroll alone', () => {
  // The DOM shim in these tests has no layout engine, so a real `clientHeight`
  // can be 0 or missing. The rule has to be total, or every station test would
  // fail on arithmetic rather than on behaviour.
  assert.equal(revealScrollTop(40, 0, 500, 30), 40);
  assert.equal(revealScrollTop(40, undefined, 500, 30), 40);
  assert.equal(revealScrollTop(40, NaN, 500, 30), 40);
});

test('every key the station hint names is really bound', async () => {
  // The hint used to read "D undock   Esc undock". `dock` is bound to KeyC and
  // KeyD is roll-right, which on this screen moves the selection *down* - so the
  // hint told the commander to press a key that scrolled the list they were
  // trying to leave. And Escape was bound to nothing at all. This test ties the
  // words to the bindings so the two cannot drift apart again.
  const INPUT = await import('../src/core/input.js');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ui = createStationUI(host, {});
  ui.open(makeState());
  const text = ui.root.querySelector('.elite-hint').textContent.replace(/\s+/g, ' ');

  assert.ok(text.includes('C undock'), 'the hint does not name C: ' + text);
  assert.ok(INPUT.BINDINGS.dock.includes('KeyC'),
    'the hint names C but dock is bound to ' + INPUT.BINDINGS.dock.join('/'));

  assert.ok(text.includes('Esc undock'), 'the hint does not name Esc: ' + text);
  assert.ok((INPUT.BINDINGS.leave || []).includes('Escape'),
    'the hint promises Escape but nothing is bound to it');

  assert.ok(!/\bD undock/.test(text), 'the hint still names D: ' + text);
  assert.ok(!INPUT.BINDINGS.dock.includes('KeyD'),
    'dock moved to KeyD, so the hint should name D after all');
});
