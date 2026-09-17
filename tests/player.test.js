/**
 * The commander's record: purse, ship, cargo, equipment, legal record.
 *
 * This module had no test file of its own. It was covered indirectly through
 * `station.test.js` and `combat.test.js`, but indirect coverage only ever
 * exercises the paths those suites happen to walk - which is why the cost
 * basis (new here) and the standing ladder (now delegated to `reputation.js`)
 * were both untested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../src/logic/player.js';
import * as REP from '../src/logic/reputation.js';

// --- The starting record ---------------------------------------------------

test('a new commander starts with a playable ship and nothing else', () => {
  const p = P.create();
  assert.equal(p.cash, P.STARTING_CASH);
  assert.equal(p.fuel, 7);
  assert.equal(p.fuelMax, 7);
  assert.equal(p.hull, 100);
  assert.equal(p.shields, 40);
  assert.equal(p.missiles, 1);
  // Capacity is derived from the equipment list, not stored. A `hold` field
  // used to sit on the record, get saved and be read by nothing.
  assert.equal(P.holdMaxOf(p), P.BASE_HOLD);
  assert.equal(p.hold, undefined, 'capacity should not be duplicated as a stored field');
  assert.equal(p.laserType, 'pulse');
  assert.deepEqual(p.cargo, {});
  assert.deepEqual(p.costBasis, {}, 'a fresh record should have an empty cost basis');
  assert.equal(p.kills, 0);
});

test('a new commander is neutral with every faction', () => {
  const p = P.create();
  for (const id of ['FEDERATION', 'EMPIRE', 'ALLIANCE', 'INDEPENDENT']) {
    assert.equal(p.standing[id], 0, 'unexpected starting standing with ' + id);
  }
});

test('the starting record has no legal history', () => {
  const p = P.create();
  assert.deepEqual(p.wanted, {});
  assert.equal(P.legalStatusFor(p._offences || 0), 'Clean');
});

// --- Cargo -----------------------------------------------------------------

test('cargo cannot exceed the hold', () => {
  const p = P.create();
  assert.equal(P.addCargo(p, 'food', 100), P.BASE_HOLD, 'the hold should cap the load');
  assert.equal(P.cargoUsed(p), P.BASE_HOLD);
  assert.equal(P.addCargo(p, 'gold', 5), 0, 'a full hold takes nothing more');
});

test('a large cargo bay raises the cap', () => {
  const p = P.create();
  P.applyEquip(p, 'cargoExt');
  assert.equal(P.holdMaxOf(p), P.EXTENDED_HOLD);
  assert.equal(P.addCargo(p, 'food', 100), P.EXTENDED_HOLD);
});

test('removing cargo never takes more than is held', () => {
  const p = P.create();
  P.addCargo(p, 'food', 5);
  assert.equal(P.removeCargo(p, 'food', 99), 5);
  assert.equal(p.cargo.food, undefined, 'an emptied commodity should be removed, not left at zero');
  assert.equal(P.removeCargo(p, 'food', 1), 0, 'removing from an empty hold is a no-op');
});

// --- Cost basis ------------------------------------------------------------

test('the cost basis remembers what was paid', () => {
  const p = P.create();
  P.addCargo(p, 'food', 10);
  P.recordPurchase(p, 'food', 10, 4);
  assert.equal(P.costBasisOf(p, 'food'), 4);
});

test('the cost basis is a weighted average across two purchases', () => {
  // The whole reason to keep a basis: a commodity bought at two prices has to
  // report an honest break-even, or the market screen's green/red highlight
  // lies about whether a sale made money.
  const p = P.create();
  P.addCargo(p, 'food', 10);
  P.recordPurchase(p, 'food', 10, 4);
  P.addCargo(p, 'food', 10);
  P.recordPurchase(p, 'food', 10, 6);
  assert.equal(P.costBasisOf(p, 'food'), 5, 'expected (10*4 + 10*6) / 20');
});

test('the weighted average is correct when the second buy is a different size', () => {
  const p = P.create();
  P.addCargo(p, 'gold', 4);
  P.recordPurchase(p, 'gold', 4, 10);
  P.addCargo(p, 'gold', 12);
  P.recordPurchase(p, 'gold', 12, 15);
  // (4*10 + 12*15) / 16 = (40 + 180) / 16 = 13.75
  assert.equal(P.costBasisOf(p, 'gold'), 13.75);
});

test('selling the last tonne drops the basis with the cargo', () => {
  // A stale basis would be harmless only by accident: the weighted average
  // multiplies the old basis by the old quantity, which is zero. Relying on
  // that arithmetic is fragile, so the basis goes with the cargo.
  const p = P.create();
  P.addCargo(p, 'food', 10);
  P.recordPurchase(p, 'food', 10, 4);
  P.removeCargo(p, 'food', 10);
  assert.equal(P.costBasisOf(p, 'food'), undefined, 'the basis outlived its cargo');
});

test('a partial sale keeps the basis, because the holding still exists', () => {
  const p = P.create();
  P.addCargo(p, 'food', 10);
  P.recordPurchase(p, 'food', 10, 4);
  P.removeCargo(p, 'food', 4);
  assert.equal(P.costBasisOf(p, 'food'), 4, 'the basis should survive a partial sale');
});

test('buying into an empty hold ignores any stale basis', () => {
  // After a full sale and a rebuy at a new price, the basis must be the new
  // price, not a blend with a holding that no longer exists.
  const p = P.create();
  P.addCargo(p, 'food', 10);
  P.recordPurchase(p, 'food', 10, 4);
  P.removeCargo(p, 'food', 10);
  P.addCargo(p, 'food', 5);
  P.recordPurchase(p, 'food', 5, 9);
  assert.equal(P.costBasisOf(p, 'food'), 9);
});

test('recording a purchase of nothing is a no-op', () => {
  const p = P.create();
  assert.equal(P.recordPurchase(p, 'food', 0, 5), undefined);
  assert.equal(P.costBasisOf(p, 'food'), undefined);
});

test('costBasisOf tolerates a record with no basis field at all', () => {
  // Old saves predate the field, and `deserialize` has to keep working.
  assert.equal(P.costBasisOf({}, 'food'), undefined);
  assert.equal(P.costBasisOf(null, 'food'), undefined);
});

// --- Save / load -----------------------------------------------------------

test('the cost basis survives a save and a load', () => {
  // It used to live on the session, which is not saved - so the market
  // screen's "sold above cost" highlight vanished after every reload.
  const p = P.create();
  p.cash = 5000;
  P.addCargo(p, 'food', 10);
  P.recordPurchase(p, 'food', 10, 4.25);

  const restored = P.deserialize(P.serialize(p));

  assert.equal(P.costBasisOf(restored, 'food'), 4.25);
  assert.equal(restored.cargo.food, 10);
});

test('a save round-trips the whole record', () => {
  const p = P.create({ name: 'Krait' });
  p.cash = 1234.5;
  p.day = 7;
  p.kills = 42;
  p.fuel = 3;
  p.hull = 61;
  p.shields = 12;
  p.missiles = 3;
  p.laserType = 'beam';
  P.addCargo(p, 'gold', 6);
  P.applyEquip(p, 'cargoExt');
  P.applyEquip(p, 'beamLaser');
  P.adjustStanding(p, 'EMPIRE', -35);
  REP.markWanted(p, 3, 4);
  P.recordOffence(p, 5);
  p.visited = { 0: 1, 4: 1 };

  const r = P.deserialize(P.serialize(p));

  assert.equal(r.name, 'Krait');
  assert.equal(r.cash, 1234.5);
  assert.equal(r.day, 7);
  assert.equal(r.kills, 42);
  assert.equal(r.fuel, 3);
  assert.equal(r.hull, 61);
  assert.equal(r.shields, 12);
  assert.equal(r.missiles, 3);
  assert.equal(r.laserType, 'beam');
  assert.equal(r.cargo.gold, 6);
  assert.equal(r.equip.cargoExt, true);
  assert.equal(r.equip.beamLaser, true);
  assert.equal(P.holdMaxOf(r), P.EXTENDED_HOLD, 'the equipment effect should be live, not just the flag');
  assert.equal(r.standing.EMPIRE, -35);
  assert.equal(r.wanted[3], 4);
  assert.equal(r._offences, 5);
  assert.deepEqual(r.visited, { 0: 1, 4: 1 });
});

test('an old save without a cost basis still loads', () => {
  const p = P.create();
  const raw = JSON.parse(P.serialize(p));
  delete raw.costBasis;              // as a pre-refactor save would be
  const r = P.deserialize(raw);
  assert.deepEqual(r.costBasis, {}, 'a missing basis should default, not be undefined');
});

test('a corrupt save payload does not throw on the way in', () => {
  // `main.js` catches, but the module should not be the thing that explodes.
  assert.doesNotThrow(() => P.deserialize({ name: 'X' }));
});

// --- Equipment -------------------------------------------------------------

test('each piece of equipment has the effect its description promises', () => {
  // The Docking Computer was the exception that motivated this test: it was
  // in the shop for 2500 CR and read by no code at all. It now widens the
  // docking envelope, which is checked in `world.test.js`; here we pin the
  // ones that act on the record itself.
  const p = P.create();

  P.applyEquip(p, 'shieldBoost');
  assert.equal(p.shieldMax, 60, 'shield boosters should raise capacity by 50%');

  P.applyEquip(p, 'fuelTank');
  assert.equal(p.fuelMax, 14, 'the long-range tank should double the tank');

  P.applyEquip(p, 'beamLaser');
  assert.equal(p.laserType, 'beam', 'the beam laser should replace the pulse laser');

  P.applyEquip(p, 'cargoExt');
  assert.equal(P.holdMaxOf(p), P.EXTENDED_HOLD);
});

test('equipment is bought once and cannot be bought twice', () => {
  const p = P.create();
  p.cash = 100000;
  assert.equal(P.buyEquipment(p, 'cargoExt').ok, true);
  const again = P.buyEquipment(p, 'cargoExt');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'owned');
});

test('equipment is refused without the funds, and takes nothing', () => {
  const p = P.create();
  p.cash = 10;
  const res = P.buyEquipment(p, 'cargoExt');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'funds');
  assert.equal(p.cash, 10);
  assert.equal(P.hasEquipment(p, 'cargoExt'), false);
});

test('buying an unknown item is reported, not thrown', () => {
  const p = P.create();
  p.cash = 100000;
  const res = P.buyEquipment(p, 'teleporter');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown');
});

// --- Repair and refuel -----------------------------------------------------

test('repair costs nothing on a pristine hull and restores a damaged one', () => {
  const p = P.create();
  p.cash = 100000;
  assert.equal(P.repair(p).ok, false, 'there is nothing to repair');

  p.hull = 40;
  const res = P.repair(p);
  assert.equal(res.ok, true);
  assert.equal(p.hull, p.hullMax);
  assert.ok(res.cost > 0);
});

test('refuelling part-way is better than a flat refusal', () => {
  // Being stranded is the worst feeling in the genre, so an unaffordable full
  // tank still buys whatever the purse allows.
  const p = P.create();
  p.fuel = 1;
  p.cash = 4;                        // enough for about two light years
  const res = P.refuel(p);
  assert.equal(res.ok, true);
  assert.equal(res.partial, true);
  assert.ok(p.fuel > 1, 'the ship should have taken on some fuel');
  assert.ok(p.fuel < p.fuelMax, 'it should not have been filled for free');
  assert.ok(p.cash >= 0, 'the purse went negative');
});

test('refuelling with an empty purse is refused', () => {
  const p = P.create();
  p.fuel = 1;
  p.cash = 0;
  const res = P.refuel(p);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'funds');
  assert.equal(p.fuel, 1, 'no fuel should have been given away');
});

// --- Rank ------------------------------------------------------------------

test('the rank ladder is monotonic and starts at Harmless', () => {
  assert.equal(P.rankOf(0), 'Harmless');
  let previous = -1;
  for (const r of P.RANKS) {
    assert.ok(r.kills > previous, 'the ladder is out of order at ' + r.name);
    previous = r.kills;
  }
  assert.equal(P.rankOf(1e9), 'ELITE');
});

test('progress toward the next rank is a fraction that never exceeds one', () => {
  for (const kills of [0, 4, 8, 15, 16, 100, 5000, 25600, 99999]) {
    const prog = P.progressTo(kills);
    assert.ok(prog.fraction >= 0 && prog.fraction <= 1, 'fraction out of range at ' + kills);
    assert.ok(prog.needed >= 0);
  }
  assert.equal(P.progressTo(99999).next, null, 'ELITE is the top of the ladder');
  assert.equal(P.progressTo(99999).fraction, 1);
});

test('progress accepts either a record or a bare kill count', () => {
  // The status screen holds a record; the HUD holds a number.
  assert.deepEqual(P.progressOf({ kills: 10 }), P.progressTo(10));
  assert.deepEqual(P.progressOf(10), P.progressTo(10));
  assert.deepEqual(P.progressOf(null), P.progressTo(0));
});

// --- Standing (delegated) --------------------------------------------------

test('standingLabel delegates to the single ladder in reputation.js', () => {
  // Two ladders used to exist and disagreed at -60, -25 and +8.
  for (const v of [-100, -60, -25, -8, 0, 8, 25, 60, 100]) {
    assert.equal(P.standingLabel(v), REP.tierFor(v).label, 'disagreement at ' + v);
  }
});

test('adjustStanding clamps to the ends of the scale', () => {
  const p = P.create();
  P.adjustStanding(p, 'EMPIRE', 500);
  assert.equal(p.standing.EMPIRE, 100);
  P.adjustStanding(p, 'EMPIRE', -500);
  assert.equal(p.standing.EMPIRE, -100);
});

// --- The default-export mirror ---------------------------------------------

test('the default export mirrors the named ones', () => {
  for (const name of ['create', 'rankOf', 'addCargo', 'removeCargo', 'recordPurchase',
    'costBasisOf', 'holdMaxOf', 'cargoUsed', 'buyEquipment', 'hasEquipment',
    'repair', 'refuel', 'serialize', 'deserialize', 'standingLabel']) {
    assert.equal(typeof P.default[name], 'function', 'missing from default: ' + name);
  }
});

test('a save round-trips every field the player record has', () => {
  // The classic silent bug: a field is added to `create()` and not to
  // `serialize`, so it works all session and is gone after a reload. Nothing
  // fails - the value is simply back to its default.
  //
  // This audit is how `dockedAt` was found. The last station was not saved, so
  // a commander who had crossed the galaxy came back from a reload with the
  // death screen offering to rescue them at Lave: `enterSystem` falls back to
  // system 0 when it is null, and the boot used it to choose between the
  // station screen and the title.
  //
  // Four fields are deliberately not written, and they are *named* here rather
  // than filtered by a pattern, so that adding a fifth is a decision somebody
  // makes rather than a silent omission.
  const TRANSIENT = ['energy', 'energyMax', 'heat', 'missileMax'];

  const fresh = P.create({ name: 'Roundtrip' });
  const probe = P.create({ name: 'Roundtrip' });
  let n = 0;
  for (const key of Object.keys(fresh)) {
    n += 1;
    const current = probe[key];
    if (typeof current === 'number') probe[key] = 1234 + n;
    else if (typeof current === 'string') probe[key] = 'probe-' + n;
    else if (typeof current === 'boolean') probe[key] = !current;
    else if (Array.isArray(current)) probe[key] = [{ probeKey: n }];
    // Objects get an extra key rather than being replaced: `deserialize` merges
    // some of them into the defaults on purpose, and replacing the object would
    // read as a lost field when nothing is wrong.
    else if (current && typeof current === 'object') {
      probe[key] = Object.assign({}, current, { probeKey: n });
    }
  }

  const back = P.deserialize(P.serialize(probe));
  const lost = Object.keys(fresh).filter(
    (key) => !TRANSIENT.includes(key)
      && JSON.stringify(probe[key]) !== JSON.stringify(back[key]));
  assert.deepStrictEqual(lost, [],
    'these fields do not survive a save: ' + lost.join(', '));

  // And the transient list has to stay honest: a name in it that no longer
  // exists in the record means somebody renamed a field and left the exemption
  // behind, which would silently stop covering anything.
  for (const key of TRANSIENT) {
    assert.ok(Object.prototype.hasOwnProperty.call(fresh, key),
      'the transient list exempts "' + key + '", which is not a field any more');
  }
});

// --- The shop must not lie about what it sells -----------------------------

test('the beam laser does not claim what it does not do', async () => {
  // It read "double damage, faster cycle, more heat". The damage is 1.7x (12
  // against 7) and the cycle is *slower* (0.44 s against 0.35) - the design
  // note in `combat.js` says the beam's advantage is "1.7x damage per shot in
  // two thirds the shots". Two of three claims were wrong and one was
  // backwards, on a 4000 CR item.
  const C = await import('../src/logic/combat.js');
  const pulse = C.LASERS.pulse;
  const beam = C.LASERS.beam;
  const desc = P.equipmentFor('beamLaser').desc;

  assert.ok(beam.damage > pulse.damage, 'the beam should hit harder');
  assert.ok(beam.cooldown > pulse.cooldown,
    'the beam cycles slower - if that ever changes, the description has to change with it');
  assert.ok(!/double damage/i.test(desc), 'the description claims double damage again');
  assert.ok(!/faster cycle/i.test(desc), 'the description claims a faster cycle again');
  assert.ok(/slower cycle/i.test(desc),
    'the description no longer warns that the cycle is slower');
});

test('the scoop does not promise fuel skimming', async () => {
  // The second half of its description was "and skim fuel from a star surface".
  // Nothing implements it, and the star sits at 9000 units - which `LAYOUT`
  // itself calls "pure backdrop, not reachable in a session". The name is the
  // original's; the description has to be this hull's.
  const W = await import('../src/sim/world.js');
  const desc = P.equipmentFor('scoop').desc;
  assert.ok(!/skim|fuel from a star/i.test(desc),
    'the scoop promises fuel skimming again, and nothing implements it');
  assert.ok(/cargo/i.test(desc), 'the scoop no longer says what it does collect');
  // And the reason the promise is empty, pinned so it is not "fixed" by moving
  // the star without thinking about the rest of the scene.
  assert.ok(W.LAYOUT.starDistance > W.LAYOUT.beltOuter * 2,
    'the star has moved close enough that skimming would be a different feature');
});

test('every item in the shop says what it does', () => {
  for (const item of P.EQUIPMENT) {
    assert.ok(item.id, 'an item has no id');
    assert.ok(item.name, item.id + ' has no name');
    assert.ok(typeof item.desc === 'string' && item.desc.length > 20,
      item.id + ' has no usable description');
    assert.ok(item.price > 0, item.id + ' is free');
  }
});
