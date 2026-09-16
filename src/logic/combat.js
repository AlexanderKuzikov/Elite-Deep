/**
 * Combat: lasers, heat, energy, shields, damage, bounties.
 *
 * Pure arithmetic, no THREE and no DOM, so the whole damage model can be
 * reasoned about and tested. The renderer asks this what happened and draws
 * the result.
 *
 * Balance posture: friendlier than the original, but the *shape* of a fight is
 * preserved. The original's fights lasted tens of seconds because the hard part
 * was aiming while manoeuvring, not out-damaging the target. An early version
 * of this module got that backwards: 8 damage on a 0.22s cooldown killed a
 * pirate in 0.72 seconds, which is a reflex test rather than a dogfight.
 *
 * Two mechanisms now enforce the intended shape:
 *
 *   - Heat is a real limiter during an engagement, not after it. Firing
 *     builds heat faster than it dissipates, so a sustained burst has a
 *     budget, and spacing shots to cool is the skill.
 *   - Hit points are high relative to damage per shot, so a kill takes several
 *     passes rather than one held trigger.
 *
 * The result is a fight measured in ten to twenty seconds of manoeuvring.
 */

/**
 * Laser types.
 *
 * The balance here is one equation, so it is worth stating plainly. Between
 * shots the weapon sheds `HEAT_COOL * cooldown` of heat, so each shot costs
 * `heat - HEAT_COOL * cooldown` from the reservoir. A full bar (0 to HEAT_LOCK)
 * therefore buys:
 *
 *   shots-per-pass = HEAT_LOCK / (heat - HEAT_COOL * cooldown) + 1
 *
 * With the figures below that is 7 pulse shots = 49 damage, which is just under
 * a pirate's 54 hit points. That is the intended feel: one sustained pass
 * leaves a pirate limping but alive, so a kill requires breaking off, cooling
 * and re-engaging. Getting this wrong is what makes combat a reflex test - at
 * 9 heat per shot the same bar bought 17 shots and deleted any target.
 *
 * Note what the beam laser does NOT do: it does not raise damage per pass,
 * because any configuration that did would kill a pirate in one burst and break
 * the pacing rule above. Its advantage is concentration - 1.7x damage per shot
 * in two thirds the shots, so less time is spent holding the trigger and more
 * is spent actually flying the ship. That is a real benefit without disturbing
 * the length of a fight.
 */
export const LASERS = {
  pulse: {
    id: 'pulse',
    name: 'Pulse Laser',
    damage: 7,
    heat: 20,
    energy: 1.4,
    cooldown: 0.35,
    colour: 0xffd27a,
    tracerLength: 220,
  },
  beam: {
    id: 'beam',
    name: 'Beam Laser',
    damage: 12,
    heat: 32,
    energy: 2.2,
    cooldown: 0.44,
    colour: 0x9ad8ff,
    tracerLength: 460,
  },
};

/** Missiles: slow, expensive, decisive. */
export const MISSILE_DAMAGE = 78;
export const MISSILE_SPEED = 620;
export const MISSILE_LIFE = 7;
export const MISSILE_TURN = 2.1;

/**
 * The ones fired *at* the player.
 *
 * Deliberately weaker and less agile than the player's, and the asymmetry is
 * the whole design. A missile that turns as hard as yours and hits as hard is
 * not a threat you can answer - it is a coin flip. At 1.3 rad/s against a
 * ship that can out-turn it, evasive flying works; at 34 damage against 40
 * shields and 100 hull, one is a serious hit and two are a problem, which is
 * the right amount of pressure for a build that is meant to be friendlier
 * than 1984.
 *
 * The player's answer is not only to run: the laser hits them (see the
 * raycast in `main.js`), so a cool head can shoot one down.
 */
export const ENEMY_MISSILE_DAMAGE = 34;
export const ENEMY_MISSILE_SPEED = 430;
export const ENEMY_MISSILE_LIFE = 9;
export const ENEMY_MISSILE_TURN = 1.3;
/** How close the player's laser can lock a missile and still hit it. */
export const ENEMY_MISSILE_RADIUS = 7;

export const HEAT_MAX = 100;
/** Heat shed per second while not firing. Deliberately below the firing cost. */
export const HEAT_COOL = 16;
/** Firing is blocked above this heat, so bursts must be spaced. */
export const HEAT_LOCK = 96;

export const ENERGY_REGEN = 5.0;
export const SHIELD_REGEN = 3.2;
export const SHIELD_REGEN_DELAY = 4.5;

/**
 * Hit points per hull class.
 *
 * Raised well above the original's values because damage per shot came down.
 * The ratio is what matters: a pirate at 54 hp against a 7 damage pulse laser
 * is eight connected hits, which cannot be delivered in one pass, so the fight
 * forces you to break off, cool, and come around again.
 */
export const SHIP_HP = {
  pirate: 54,
  raider: 78,
  viper: 82,
  trader: 64,
  asteroid: 40,
  canister: 2,
};

/** Bounty paid per hull class, scaled by the system's danger. */
export const SHIP_BOUNTY = {
  pirate: 70,
  raider: 130,
  viper: 180,   // shooting police pays, and costs you everything else
  trader: 0,    // attacking traders is profitless; it only ruins your record
};

export function laserFor(type) {
  return LASERS[type] || LASERS.pulse;
}

/** Can the laser fire right now? Returns a reason when it cannot. */
export function laserCanFire(p, cooldownLeft) {
  if (cooldownLeft > 0) return { ok: false, reason: 'cooldown' };
  if (p.heat >= HEAT_LOCK) return { ok: false, reason: 'overheat' };
  const spec = laserFor(p.laserType);
  if (p.energy < spec.energy) return { ok: false, reason: 'energy' };
  return { ok: true, spec };
}

/**
 * Apply the cost of a shot. Called once the shot is confirmed, so the caller
 * cannot accidentally fire for free by checking and forgetting.
 */
export function fireLaser(p) {
  const spec = laserFor(p.laserType);
  p.heat = Math.min(HEAT_MAX, p.heat + spec.heat);
  p.energy = Math.max(0, p.energy - spec.energy);
  return {
    damage: spec.damage,
    heat: spec.heat,
    cooldown: spec.cooldown,
    colour: spec.colour,
    tracerLength: spec.tracerLength,
  };
}

/** Cool down, regenerate energy. `dt` in seconds. */
export function tickHeat(p, dt) {
  if (p.heat > 0) p.heat = Math.max(0, p.heat - HEAT_COOL * dt);
}

export function regenEnergy(p, dt) {
  if (p.energy < p.energyMax) {
    p.energy = Math.min(p.energyMax, p.energy + ENERGY_REGEN * dt);
  }
}

/**
 * Shield regeneration, held back for a moment after taking a hit so that a
 * sustained attack cannot be out-healed by simply flying straight.
 */
export function regenShields(p, dt, sinceDamage) {
  if (sinceDamage < SHIELD_REGEN_DELAY) return;
  if (p.shields >= p.shieldMax) return;
  p.shields = Math.min(p.shieldMax, p.shields + SHIELD_REGEN * dt);
}

/**
 * Damage the player. Shields absorb first, then hull. Returns a summary so the
 * caller can decide about sound, screen shake and death.
 *
 * `pierce` ignores shields - used for collisions, where a shield should not
 * save you from your own bad flying.
 */
export function damagePlayer(p, amount, opts) {
  opts = opts || {};
  const before = { shields: p.shields, hull: p.hull };
  let remaining = amount;

  if (!opts.pierce && p.shields > 0) {
    const absorbed = Math.min(p.shields, remaining);
    p.shields -= absorbed;
    remaining -= absorbed;
  }
  if (remaining > 0) {
    p.hull = Math.max(0, p.hull - remaining);
  }

  return {
    shieldsLost: before.shields - p.shields,
    hullLost: before.hull - p.hull,
    destroyed: p.hull <= 0,
    before: before,
  };
}

/** Damage an entity. Returns whether it died. */
export function damageEntity(entity, amount) {
  entity.hp -= amount;
  return entity.hp <= 0;
}

/**
 * Bounty for destroying an entity.
 *
 * Scaled by the system's danger: a pirate in a lawless system is worth less,
 * because nobody there is paying for law and order. This keeps bounty hunting
 * from being strictly better in the safest place to do it.
 */
export function bountyFor(entity, danger) {
  const base = SHIP_BOUNTY[entity.kind] || 0;
  if (base === 0) return 0;
  const scale = 0.7 + danger * 0.7;
  return Math.round(base * scale);
}

/** Legal consequence of destroying an entity. Police are the expensive ones. */
export function offenceFor(entity) {
  if (entity.kind === 'viper') return 6;
  if (entity.kind === 'trader') return 3;
  if (entity.kind === 'canister' || entity.kind === 'asteroid') return 0;
  return 0;
}

/** Standing shift with the owning faction for an action. */
export function standingShiftFor(entity, action) {
  const table = {
    pirate: { kill: 4, damage: 0.5 },
    raider: { kill: 7, damage: 1 },
    viper: { kill: -22, damage: -4 },
    trader: { kill: -12, damage: -2.5 },
    asteroid: { kill: 0, damage: 0 },
    canister: { kill: 0, damage: 0 },
  };
  const row = table[entity.kind] || { kill: 0, damage: 0 };
  return row[action] || 0;
}

/**
 * How far an NPC will bother pulling the trigger.
 *
 * Was a bare literal 620 inside the traffic AI's firing condition. Named here
 * because it is the boundary between "in the fight" and "still closing", which
 * is a combat number and belongs with the rest of them - the pacing note on
 * `timeToKill` is written entirely in terms of what happens inside this range.
 * Anything that wants to reason about the fight rather than the approach should
 * read it from here.
 */
export const FIRE_RANGE = 620;

/**
 * Shots available from a full heat reservoir, and the damage they represent.
 *
 * This is the load-bearing number for combat pacing. See the note on LASERS:
 * between shots the weapon sheds HEAT_COOL * cooldown, so each shot costs the
 * difference from the reservoir. One pass should leave a pirate alive.
 */
export function passBudget(laserType) {
  const spec = laserFor(laserType);
  const netPerShot = spec.heat - HEAT_COOL * spec.cooldown;
  if (netPerShot <= 0) {
    // Out-cooling your own weapon means unlimited sustained fire; the lock is
    // the only limit, so fall back to the lock as the budget.
    return { shots: Infinity, damage: Infinity, netPerShot: netPerShot };
  }
  const shots = Math.floor(HEAT_LOCK / netPerShot) + 1;
  return { shots: shots, damage: shots * spec.damage, netPerShot: netPerShot };
}

/**
 * Effective seconds to destroy a target, assuming every shot connects.
 *
 * This is NOT the length of a fight, and it is a mistake to balance against it
 * as though it were. The geometry does the rest of the work: at typical combat
 * range a ship subtends under two degrees and a crossing target spends about
 * half a second inside the crosshair, so a realistic hit rate is nearer one in
 * three. Eight connected hits at one in three means twenty-odd seconds of
 * manoeuvring per kill, which is the original's feel.
 */
export function timeToKill(laserType, hp) {
  const spec = laserFor(laserType);
  return (hp / spec.damage) * spec.cooldown;
}

export default {
  LASERS, MISSILE_DAMAGE, MISSILE_SPEED, MISSILE_LIFE, MISSILE_TURN,
  ENEMY_MISSILE_DAMAGE, ENEMY_MISSILE_SPEED, ENEMY_MISSILE_LIFE,
  ENEMY_MISSILE_TURN, ENEMY_MISSILE_RADIUS,
  HEAT_MAX, HEAT_COOL, HEAT_LOCK, ENERGY_REGEN, SHIELD_REGEN,
  SHIELD_REGEN_DELAY, SHIP_HP, SHIP_BOUNTY,
  laserFor, laserCanFire, fireLaser, tickHeat, regenEnergy, regenShields,
  damagePlayer, damageEntity, bountyFor, offenceFor, standingShiftFor,
  passBudget, timeToKill,
};
