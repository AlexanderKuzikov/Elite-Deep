/**
 * Combat tests.
 *
 * The important assertions here are about the *shape* of a fight, not just
 * arithmetic. Combat balance fails quietly: nothing crashes when a pirate dies
 * in half a second, the game simply stops being interesting. So the tests
 * encode the intended pacing explicitly, and the reasoning behind each bound is
 * in the comment above it.
 */
import test from 'node:test';
import assert from 'node:assert';
import * as C from '../src/logic/combat.js';
import * as P from '../src/logic/player.js';

/** Run a full engagement: fire whenever the rules allow, cool between shots. */
function simulateEngagement(laserType, hp, maxSeconds) {
  const p = { heat: 0, energy: 100, energyMax: 100, laserType };
  let cd = 0, t = 0, shots = 0, dmg = 0;
  const limit = maxSeconds === undefined ? 180 : maxSeconds;
  while (dmg < hp && t < limit) {
    const dt = 1 / 60;
    t += dt;
    C.tickHeat(p, dt);
    C.regenEnergy(p, dt);
    cd -= dt;
    if (C.laserCanFire(p, cd).ok) {
      const s = C.fireLaser(p);
      cd = s.cooldown;
      dmg += s.damage;
      shots++;
    }
  }
  return { time: t, shots, damage: dmg, heat: p.heat };
}

/** Time until continuous fire first reaches the heat lock. */
function timeToHeatLock(laserType) {
  const p = { heat: 0, energy: 100, energyMax: 100, laserType };
  let cd = 0, t = 0;
  for (let i = 0; i < 60 * 120; i++) {
    const dt = 1 / 60;
    t += dt;
    C.tickHeat(p, dt);
    C.regenEnergy(p, dt);
    cd -= dt;
    if (C.laserCanFire(p, cd).ok) {
      C.fireLaser(p);
      cd = C.laserFor(laserType).cooldown;
    }
    if (p.heat >= C.HEAT_LOCK) return t;
  }
  return null;
}

test('laser table is well formed', () => {
  for (const id of Object.keys(C.LASERS)) {
    const l = C.LASERS[id];
    assert.strictEqual(l.id, id);
    assert.ok(l.damage > 0 && l.heat > 0 && l.cooldown > 0);
    assert.ok(l.energy > 0);
    assert.ok(Number.isFinite(l.colour));
  }
  assert.strictEqual(C.laserFor('pulse').id, 'pulse');
  assert.strictEqual(C.laserFor('nonsense').id, 'pulse', 'unknown laser should fall back to pulse');
});

test('the beam laser is a real upgrade but does not shortcut a fight', () => {
  // The beam's selling point is concentration: harder hits in fewer shots, so
  // less time with the trigger down. It deliberately does NOT raise damage per
  // attack pass, because that would let it kill a pirate in one burst and the
  // pacing rule below would be false.
  const pulseSpec = C.laserFor('pulse');
  const beamSpec = C.laserFor('beam');
  const perShot = beamSpec.damage / pulseSpec.damage;
  assert.ok(perShot > 1.4 && perShot < 2.2,
    'beam damage per shot should be a clear but modest upgrade: ' + perShot.toFixed(2) + 'x');

  const pulsePass = C.passBudget('pulse');
  const beamPass = C.passBudget('beam');
  assert.ok(beamPass.shots < pulsePass.shots,
    'the beam should reach its heat limit in fewer shots than the pulse');
  const passRatio = beamPass.damage / pulsePass.damage;
  assert.ok(passRatio > 0.8 && passRatio < 1.15,
    'beam and pulse should be comparable per attack pass, got ' + passRatio.toFixed(2) + 'x');
});

test('heat, not cooldown, is what limits sustained fire', () => {
  // If cooldown were the limit, a player could hold the trigger forever. The
  // whole point of the heat system is that they cannot.
  for (const laserType of ['pulse', 'beam']) {
    const lock = timeToHeatLock(laserType);
    assert.ok(lock !== null, laserType + ': continuous fire never overheats');
    assert.ok(lock > 1.0, laserType + ': overheat arrives in under a second: ' + lock.toFixed(2) + 's');
    assert.ok(lock < 10, laserType + ': heat is not a real limit: ' + lock.toFixed(2) + 's');
  }
});

test('a single attack pass cannot kill a fresh target', () => {
  // The pacing invariant, and the reason this test exists at all.
  //
  // One full heat budget must not be enough to destroy an enemy. If it were,
  // combat would be decided by who fires first rather than by flying, and the
  // fight would last under two seconds. The budget is measured from the heat
  // reservoir (0 to HEAT_LOCK), which is what a player actually spends.
  for (const laserType of ['pulse', 'beam']) {
    const budget = C.passBudget(laserType);
    assert.ok(Number.isFinite(budget.shots),
      laserType + ': weapon out-cools itself, so there is no attack pass at all');
    for (const kind of ['pirate', 'raider', 'viper', 'trader']) {
      assert.ok(budget.damage < C.SHIP_HP[kind],
        laserType + ': one heat budget (' + budget.shots + ' shots = ' + budget.damage +
        ' dmg) destroys a ' + kind + ' (' + C.SHIP_HP[kind] + ' hp) outright');
    }
  }
});

test('a full heat budget is close to a kill, so a pass feels worthwhile', () => {
  // The converse failure: if one pass barely scratches a target, the fight
  // becomes a war of attrition and heat stops being a satisfying resource.
  const budget = C.passBudget('pulse');
  const fraction = budget.damage / C.SHIP_HP.pirate;
  assert.ok(fraction > 0.6,
    'one pass only does ' + (fraction * 100).toFixed(0) + '% of a pirate - too little');
});

test('a fresh target dies in a useful number of connected hits', () => {
  const spec = C.laserFor('pulse');
  for (const [kind, expected] of [['pirate', 8], ['raider', 11], ['viper', 12], ['trader', 10]]) {
    const hits = Math.ceil(C.SHIP_HP[kind] / spec.damage);
    assert.ok(hits >= 6 && hits <= 16,
      kind + ' needs ' + hits + ' hits (expected roughly ' + expected + ')');
  }
});

test('firing is refused when overheated', () => {
  const p = P.create();
  p.heat = C.HEAT_LOCK;
  const verdict = C.laserCanFire(p, 0);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.reason, 'overheat');
});

test('firing is refused while the weapon is on cooldown', () => {
  const p = P.create();
  const verdict = C.laserCanFire(p, 0.5);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.reason, 'cooldown');
});

test('firing is refused without energy', () => {
  const p = P.create();
  p.energy = 0;
  const verdict = C.laserCanFire(p, 0);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.reason, 'energy');
});

test('a shot costs heat and energy, and cannot exceed the ceiling', () => {
  const p = P.create();
  const before = p.energy;
  C.fireLaser(p);
  assert.ok(p.heat > 0);
  assert.ok(p.energy < before);
  p.heat = C.HEAT_MAX;
  C.fireLaser(p);
  assert.strictEqual(p.heat, C.HEAT_MAX, 'heat should clamp at the maximum');
  p.energy = 0.1;
  C.fireLaser(p);
  assert.strictEqual(p.energy, 0, 'energy should clamp at zero');
});

test('heat dissipates and energy regenerates over time', () => {
  const p = P.create();
  p.heat = 50;
  p.energy = 10;
  C.tickHeat(p, 1);
  C.regenEnergy(p, 1);
  assert.ok(p.heat < 50, 'heat did not dissipate');
  assert.ok(p.energy > 10, 'energy did not regenerate');
  C.tickHeat(p, 100);
  assert.strictEqual(p.heat, 0, 'heat should stop at zero');
  C.regenEnergy(p, 1000);
  assert.strictEqual(p.energy, p.energyMax, 'energy should stop at maximum');
});

test('shields absorb damage before the hull does', () => {
  const p = P.create();
  const shields = p.shields;
  C.damagePlayer(p, shields * 0.5);
  assert.ok(p.shields < shields, 'shields took no damage');
  assert.strictEqual(p.hull, p.hullMax, 'hull damaged while shields held');

  C.damagePlayer(p, shields);
  assert.strictEqual(p.shields, 0, 'shields should be exhausted');
  assert.ok(p.hull < p.hullMax, 'hull should have taken the overflow');
});

test('piercing damage ignores shields entirely', () => {
  const p = P.create();
  const r = C.damagePlayer(p, 30, { pierce: true });
  assert.strictEqual(p.shields, p.shieldMax, 'shields absorbed piercing damage');
  assert.strictEqual(r.shieldsLost, 0);
  assert.strictEqual(r.hullLost, 30);
});

test('destruction is reported exactly once, at zero hull', () => {
  const p = P.create();
  const r = C.damagePlayer(p, p.hullMax + 500, { pierce: true });
  assert.strictEqual(r.destroyed, true);
  assert.strictEqual(p.hull, 0, 'hull should clamp at zero, not go negative');
});

test('shields regenerate only after a lull', () => {
  const p = P.create();
  p.shields = 10;
  C.regenShields(p, 1, 0);
  assert.strictEqual(p.shields, 10, 'shields regenerated immediately after a hit');
  C.regenShields(p, 1, C.SHIELD_REGEN_DELAY + 1);
  assert.ok(p.shields > 10, 'shields did not regenerate after the delay');
  C.regenShields(p, 1000, C.SHIELD_REGEN_DELAY + 1);
  assert.strictEqual(p.shields, p.shieldMax, 'shields should stop at maximum');
});

test('bounty scales with danger, so hunting is not best done in safe space', () => {
  const pirate = { kind: 'pirate' };
  const low = C.bountyFor(pirate, 0.1);
  const high = C.bountyFor(pirate, 0.9);
  assert.ok(high > low, 'dangerous systems should pay more for the same kill');
  assert.ok(low > 0, 'killing pirates should always pay something');
});

test('traders are worth nothing to shoot', () => {
  // Attacking traders must be purely a moral and legal cost, never a profit.
  assert.strictEqual(C.bountyFor({ kind: 'trader' }, 0.9), 0);
  assert.ok(C.offenceFor({ kind: 'trader' }) > 0, 'attacking traders must be an offence');
});

test('killing police is the most expensive act available', () => {
  const viper = C.offenceFor({ kind: 'viper' });
  const trader = C.offenceFor({ kind: 'trader' });
  const pirate = C.offenceFor({ kind: 'pirate' });
  assert.ok(viper > trader, 'police should cost more than traders');
  assert.ok(trader > pirate, 'traders should cost more than pirates');
  assert.strictEqual(pirate, 0, 'killing pirates must be legal');
});

test('standing shifts reward pirates and punish police', () => {
  assert.ok(C.standingShiftFor({ kind: 'pirate' }, 'kill') > 0);
  assert.ok(C.standingShiftFor({ kind: 'raider' }, 'kill') > C.standingShiftFor({ kind: 'pirate' }, 'kill'));
  assert.ok(C.standingShiftFor({ kind: 'viper' }, 'kill') < -10);
  assert.ok(C.standingShiftFor({ kind: 'trader' }, 'kill') < 0);
  assert.strictEqual(C.standingShiftFor({ kind: 'asteroid' }, 'kill'), 0);
});

test('an engagement resolves in a bounded time', () => {
  const r = simulateEngagement('pulse', C.SHIP_HP.viper);
  assert.ok(r.damage >= C.SHIP_HP.viper, 'target survived the simulation');
  assert.ok(r.time < 60, 'engagement took implausibly long: ' + r.time.toFixed(1) + 's');
});

test('missiles are decisive enough to be worth their price', () => {
  assert.ok(C.MISSILE_DAMAGE > C.SHIP_HP.pirate,
    'a missile should destroy a pirate outright');
  assert.ok(C.MISSILE_DAMAGE < C.SHIP_HP.viper + 20,
    'a missile should not be a universal answer to everything');
  assert.ok(C.MISSILE_LIFE > 0 && C.MISSILE_SPEED > 0 && C.MISSILE_TURN > 0);
});

export { simulateEngagement, timeToHeatLock };
