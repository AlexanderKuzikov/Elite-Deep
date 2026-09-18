/**
 * HUD: the scanner, the compass, the status readouts and the message log.
 *
 * Rendered with the Canvas 2D API rather than DOM. Three reasons, in order of
 * importance:
 *
 *   1. The original HUD is a vector display. Lines and arcs are the medium, so
 *      drawing them directly is both more faithful and less code than
 *      coaxing CSS into looking like a wireframe.
 *   2. A DOM HUD with forty elements updating every frame is a layout-thrash
 *      machine. Canvas has one layout.
 *   3. The scanner is a projection of 3D positions. That is a maths problem,
 *      not a styling problem.
 *
 * The HUD owns no game state. Everything it draws is passed in as a plain
 * object, which keeps it testable by asserting on a recording context.
 */

/** Palette. Kept in one place so the whole HUD can be re-tinted. */
export const HUD_COLOURS = {
  ink: '#9fe8ff',        // the default line colour, matching the ship edges
  /**
   * Secondary text. Was 0.38, which measured 2.3:1 against black - below the
   * 3:1 readability floor, and it is the colour the *rumour* is drawn in, i.e.
   * the line that tells the commander what this system remembers about them.
   * 0.62 keeps it visibly secondary and makes it readable.
   */
  inkDim: 'rgba(159,232,255,0.62)',
  inkFaint: 'rgba(159,232,255,0.14)',
  warn: '#ffd27a',
  danger: '#ff6a5a',
  ok: '#8affb0',
  hostile: '#ff6a5a',
  neutral: '#ffd27a',
  friendly: '#8affb0',
  cargo: '#c8a0ff',
  planet: '#7ac8ff',
  station: '#ffffff',
  target: '#ff9a5a',
  glass: 'rgba(6,10,16,0.72)',
  /**
   * The outline drawn under text that has to survive a bright background.
   *
   * The HUD is drawn straight onto the scene with no plate of its own, so a
   * message over the station used to be dark-on-bright and unreadable: measured
   * over the arrival station, mean contrast ratio **1.74**, with **97 %** of the
   * log's pixels below the 3:1 readability floor. An outline travels with the
   * glyph, so the contrast holds wherever the line happens to be.
   */
  plate: 'rgba(2,5,10,0.88)',
};

/** Layout constants. Positions are fractions of the viewport. */
export const HUD_LAYOUT = {
  scannerRadius: 0.20,      // of the smaller dimension
  scannerMargin: 0.045,
  barWidth: 0.16,
  barHeight: 8,
  barGap: 7,
  font: 13,
  smallFont: 11,
  lineWidth: 1.4,
  crosshairSize: 14,
  messageLifetime: 5.5,
  messageMax: 5,
  // How long a damage-direction arc stays on screen. Long enough to turn
  // toward the threat, short enough that a stale arc does not lie about where
  // the fire is coming from now.
  damageArcLifetime: 1.4,
  damageArcRadius: 0.42,   // of the smaller dimension
  /** The viewport height these pixel sizes were tuned against. */
  referenceHeight: 900,
};

/**
 * How much to enlarge the fixed pixel sizes for this viewport.
 *
 * The HUD mixes proportional sizes (the scanner radius is a fraction of the
 * screen) with fixed ones (13px text, an 8px bar). On a 1080p display the
 * proportional parts grow and the fixed parts do not, so the text ends up
 * smaller relative to everything around it - comfortable in a 720p window and
 * squinty on the monitor most people actually use.
 *
 * Clamped at both ends: below about 0.9 the text stops being legible at all,
 * and above 1.5 it starts competing with the view it is drawn over.
 */
export function hudScale(height) {
  const k = (height || HUD_LAYOUT.referenceHeight) / HUD_LAYOUT.referenceHeight;
  return Math.max(0.9, Math.min(1.5, k));
}

/** Font stack: a monospace with a technical feel, with sane fallbacks. */
const MONO = '"SF Mono", "Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace';

/**
 * Draw the whole HUD. `state` is everything it needs to know:
 *
 *   { width, height, scannerRange, speed, throttle, fuel, maxFuel, shields,
 *     maxShields, energy, maxEnergy, hull, maxHull, heat, missiles, laser,
 *     cash, rank, cargoUsed, cargoMax, target, contacts, station, planet,
 *     messages, alerts, attitude, radarMode }
 */
export function drawHud(ctx, state) {
  const w = state.width || 0;
  const h = state.height || 0;
  if (w <= 0 || h <= 0) return;
  // One place computes it, everything downstream reads it.
  state.scale = state.scale || hudScale(h);

  // The chart is a *place*, not an overlay on the cockpit: it replaces the view
  // of space. So the instruments go away, the map is drawn in their place, and
  // the status readout sits on top of it.
  //
  // This used to be the other way round - the chart was drawn last, over
  // everything - which meant its backdrop dimmed the HUD along with the world.
  // At 0.86 that left the status column faint; raising the opacity to kill the
  // world ghosting made it nearly invisible. Both symptoms had one cause: the
  // backdrop was covering the wrong layer.
  const chartUp = state.radarMode === 'chart' || state.showChart;

  ctx.save();
  ctx.lineWidth = HUD_LAYOUT.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Order matters: the crosshair is drawn under the scanner so the two never
  // fight for the same pixels at the edge of the view.
  if (!chartUp) {
    drawTargetBox(ctx, state);
    drawCrosshair(ctx, state);
    drawScanner(ctx, state);
  }
  ctx.restore();

  if (chartUp) drawChartOverlay(ctx, state);

  // Text blocks are drawn without the line-drawing state, so a stray lineWidth
  // cannot fatten a glyph. Drawn after the chart, so they stay readable on it.
  drawStatusBars(ctx, state);
  drawIdent(ctx, state);
  if (!chartUp) drawCompass(ctx, state);
  drawMessages(ctx, state);
  drawAlerts(ctx, state);
  if (!chartUp) drawDamageArcs(ctx, state);
}

/** The centre reticle. Small, thin, and offset so it never hides the target. */
function drawCrosshair(ctx, state) {
  const { width: w, height: h } = state;
  const cx = w / 2, cy = h / 2;
  const s = HUD_LAYOUT.crosshairSize * (state.scale || 1);

  ctx.strokeStyle = HUD_COLOURS.inkDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // A broken cross: four ticks that leave the exact centre clear. Aiming at a
  // distant ship needs to see the pixel you are aiming at.
  ctx.moveTo(cx - s, cy); ctx.lineTo(cx - s * 0.35, cy);
  ctx.moveTo(cx + s * 0.35, cy); ctx.lineTo(cx + s, cy);
  ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy - s * 0.35);
  ctx.moveTo(cx, cy + s * 0.35); ctx.lineTo(cx, cy + s);
  ctx.stroke();

  // A laser cooldown pip, so the player can read heat without the bar.
  if (state.laserHot) {
    ctx.strokeStyle = HUD_COLOURS.danger;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 1.5, -0.6, 0.6);
    ctx.stroke();
  }
}

/**
 * A box around the current target, plus its range and a lead indicator.
 *
 * The lead pip is the single most useful combat aid: it shows where to aim so
 * the shot and the target arrive at the same place. Without it, hitting
 * anything moving is guesswork.
 */
function drawTargetBox(ctx, state) {
  const t = state.target;
  if (!t || !t.screen) return;
  const { x, y, size } = t.screen;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const hostile = t.hostile;
  const colour = hostile ? HUD_COLOURS.hostile
    : t.kind === 'canister' ? HUD_COLOURS.cargo
      : t.kind === 'capsule' ? HUD_COLOURS.friendly
        : HUD_COLOURS.neutral;

  const k = state.scale || 1;
  const r = clamp(size, 14 * k, 90 * k);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  bracketBox(ctx, x, y, r);
  ctx.stroke();

  // Range, under the box.
  if (t.distance !== undefined) {
    ctx.fillStyle = colour;
    ctx.font = (HUD_LAYOUT.smallFont * k) + 'px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(formatDistance(t.distance), x, y + r + 4 * k);
  }

  // Lead pip: where to point to hit it.
  if (t.lead && Number.isFinite(t.lead.x) && Number.isFinite(t.lead.y)) {
    ctx.strokeStyle = HUD_COLOURS.target;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(t.lead.x, t.lead.y, 5 * k, 0, Math.PI * 2);
    ctx.moveTo(t.lead.x - 8 * k, t.lead.y);
    ctx.lineTo(t.lead.x + 8 * k, t.lead.y);
    ctx.moveTo(t.lead.x, t.lead.y - 8 * k);
    ctx.lineTo(t.lead.x, t.lead.y + 8 * k);
    ctx.stroke();
  }
}

/** Four corner brackets, the classic target-designator shape. */
function bracketBox(ctx, x, y, r) {
  const arm = Math.max(4, r * 0.3);
  const corners = [
    [x - r, y - r, 1, 1], [x + r, y - r, -1, 1],
    [x - r, y + r, 1, -1], [x + r, y + r, -1, -1],
  ];
  for (const [px, py, sx, sy] of corners) {
    ctx.moveTo(px, py + arm * sy);
    ctx.lineTo(px, py);
    ctx.lineTo(px + arm * sx, py);
  }
}

/**
 * The scanner: an elliptical projection of nearby contacts, with elevation
 * shown by stub height.
 *
 * This is the hardest thing in the HUD to get right. Elite's scanner is a
 * *plan view* - it shows X and Z, with Y indicated by a vertical stub off each
 * blip. That is what makes it readable in a 3D fight: you always know which
 * contacts are on your plane.
 */
function drawScanner(ctx, state) {
  const { width: w, height: h } = state;
  const r = Math.min(w, h) * HUD_LAYOUT.scannerRadius;
  const mars = Math.min(w, h) * HUD_LAYOUT.scannerMargin;
  const cx = w / 2;
  const cy = h - mars - r;

  // --- Bowl -------------------------------------------------------------
  ctx.strokeStyle = HUD_COLOURS.inkDim;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Range rings, at halves. Two rings is enough to judge distance without
  // turning the scope into a dartboard.
  ctx.strokeStyle = HUD_COLOURS.inkFaint;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  ctx.stroke();

  // Cross hairs, broken at the centre.
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx - r * 0.08, cy);
  ctx.moveTo(cx + r * 0.08, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - r * 0.08);
  ctx.moveTo(cx, cy + r * 0.08); ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // --- Contacts --------------------------------------------------------
  const range = state.scannerRange || 2000;
  const contacts = state.contacts || [];
  for (const c of contacts) {
    // `forward` is the contact's distance along the ship's own nose; `right`
    // and `up` are the lateral offsets. Passing them in pre-rotated keeps the
    // scanner free of camera maths.
    const nx = c.right / range;
    const nz = c.forward / range;
    if (nx * nx + nz * nz > 1) continue; // outside the scope
    const px = cx + nx * r;
    const py = cy - nz * r;

    const colour = c.station ? HUD_COLOURS.station
      : c.planet ? HUD_COLOURS.planet
        : c.hostile ? HUD_COLOURS.hostile
          : c.kind === 'canister' ? HUD_COLOURS.cargo
            : c.kind === 'capsule' ? HUD_COLOURS.friendly
              : HUD_COLOURS.neutral;

    const size = c.station || c.planet ? 4.5 : c.target ? 3.6 : 2.6;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();

    // Elevation stub. Clamped to a readable range so a contact directly above
    // does not draw a line off the top of the screen.
    const lift = clamp(c.up / range * r, -r * 0.55, r * 0.55);
    if (Math.abs(lift) > 1) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - lift);
      ctx.stroke();
      // A tick at the far end, so the direction of the stub is unambiguous.
      ctx.beginPath();
      ctx.moveTo(px - 2, py - lift);
      ctx.lineTo(px + 2, py - lift);
      ctx.stroke();
    }

    // Highlight the current target with a ring.
    if (c.target) {
      ctx.strokeStyle = HUD_COLOURS.target;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(px, py, size + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- Own ship marker --------------------------------------------------
  // A small triangle at the centre, pointing up the scope.
  ctx.fillStyle = HUD_COLOURS.ink;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 6);
  ctx.lineTo(cx - 4, cy + 4);
  ctx.lineTo(cx + 4, cy + 4);
  ctx.closePath();
  ctx.fill();

  // --- Range legend -----------------------------------------------------
  ctx.fillStyle = HUD_COLOURS.inkDim;
  ctx.font = (HUD_LAYOUT.smallFont * (state.scale || 1)) + 'px ' + MONO;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(formatDistance(range), cx, cy + r + 5);
}

/** The left column: shields, fuel, energy, heat, hull. */
function drawStatusBars(ctx, state) {
  const { width: w, height: h } = state;
  const k = state.scale || 1;
  const bw = Math.max(90 * k, w * HUD_LAYOUT.barWidth);
  const bh = HUD_LAYOUT.barHeight * k;
  const gap = HUD_LAYOUT.barGap * k;
  let x = w * 0.035;
  let y = h * 0.06;

  const rows = [
    { label: 'SHLD', value: state.shields, max: state.maxShields, colour: HUD_COLOURS.ink },
    { label: 'FUEL', value: state.fuel, max: state.maxFuel, colour: HUD_COLOURS.ok },
    { label: 'ENRG', value: state.energy, max: state.maxEnergy, colour: HUD_COLOURS.ink },
    { label: 'HEAT', value: state.heat, max: state.maxHeat || 100, colour: HUD_COLOURS.warn, inverted: true },
    { label: 'HULL', value: state.hull, max: state.maxHull, colour: HUD_COLOURS.ink },
  ];

  ctx.font = (HUD_LAYOUT.smallFont * k) + 'px ' + MONO;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const ry = y + i * (bh + gap + HUD_LAYOUT.smallFont * k);
    const frac = row.max > 0 ? clamp(row.value / row.max, 0, 1) : 0;

    // Label.
    ctx.fillStyle = HUD_COLOURS.inkDim;
    ctx.fillText(row.label, x, ry + bh / 2);

    // Track.
    const tx = x + 38 * k;
    ctx.fillStyle = HUD_COLOURS.inkFaint;
    ctx.fillRect(tx, ry, bw, bh);

    // Fill. Heat is inverted: a full bar is bad, so it turns red as it fills.
    let colour = row.colour;
    if (row.inverted) {
      colour = frac > 0.85 ? HUD_COLOURS.danger : frac > 0.6 ? HUD_COLOURS.warn : HUD_COLOURS.ok;
    } else if (frac < 0.25) {
      colour = HUD_COLOURS.danger;
    } else if (frac < 0.5) {
      colour = HUD_COLOURS.warn;
    }
    ctx.fillStyle = colour;
    ctx.fillRect(tx, ry, bw * frac, bh);

    // Outline, so an empty bar is still legible against a bright planet.
    ctx.strokeStyle = HUD_COLOURS.inkDim;
    ctx.lineWidth = 1;
    ctx.strokeRect(tx + 0.5, ry + 0.5, bw - 1, bh - 1);

    // Tick marks at quarters, for a quick read without numbers.
    ctx.strokeStyle = HUD_COLOURS.inkFaint;
    for (let q = 1; q < 4; q += 1) {
      const qx = tx + (bw * q) / 4;
      ctx.beginPath();
      ctx.moveTo(qx, ry);
      ctx.lineTo(qx, ry + bh);
      ctx.stroke();
    }
  }
}

/** Cash, rank, cargo, laser and missiles. */
function drawIdent(ctx, state) {
  const { width: w, height: h } = state;
  const k = state.scale || 1;
  const line = HUD_LAYOUT.font * k;
  ctx.font = line + 'px ' + MONO;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = HUD_COLOURS.ink;

  const x = w * 0.035;
  const y = h * 0.06
    + 5 * (HUD_LAYOUT.barHeight * k + HUD_LAYOUT.barGap * k + HUD_LAYOUT.smallFont * k) + 6 * k;

  ctx.fillText((state.cash || 0).toFixed(1) + ' CR', x, y);
  ctx.fillStyle = HUD_COLOURS.inkDim;
  ctx.fillText((state.rank || 'HARMLESS').toUpperCase(), x, y + line * 1.35);

  // Cargo, with a warning colour when full.
  const used = state.cargoUsed || 0;
  const cap = state.cargoMax || 0;
  ctx.fillStyle = cap > 0 && used >= cap ? HUD_COLOURS.warn : HUD_COLOURS.inkDim;
  ctx.fillText('HOLD ' + used + '/' + cap, x, y + line * 2.7);

  // Weapon.
  ctx.fillStyle = HUD_COLOURS.inkDim;
  ctx.fillText((state.laser || 'pulse').toUpperCase() + ' LASER', x, y + line * 4.05);

  // Missiles, as pips.
  const m = state.missiles || 0;
  if (m > 0) {
    const mx = x;
    const my = y + line * 5.4;
    ctx.fillStyle = HUD_COLOURS.inkDim;
    ctx.fillText('MSL', mx, my);
    for (let i = 0; i < Math.min(m, 6); i += 1) {
      ctx.fillStyle = HUD_COLOURS.warn;
      ctx.fillRect(mx + 32 * k + i * 8 * k, my + 2 * k, 5 * k, 9 * k);
    }
    if (m > 6) {
      ctx.fillStyle = HUD_COLOURS.inkDim;
      ctx.fillText('+' + (m - 6), mx + 32 * k + 6 * 8 * k + 4, my);
    }
  }
}

/**
 * The compass: a heading strip showing where the station and the planet are.
 *
 * Elite's compass is a ball with a dot; this is a strip instead because a strip
 * reads better on a widescreen display and can carry more than one marker. The
 * station marker is the important one - it is how you find your way home.
 */
function drawCompass(ctx, state) {
  const { width: w, height: h } = state;
  const k = state.scale || 1;
  const cw = Math.min(320 * k, w * 0.30);
  const ch = 22 * k;
  const x = w / 2 - cw / 2;
  const y = h * 0.045;

  ctx.fillStyle = HUD_COLOURS.glass;
  ctx.fillRect(x, y, cw, ch);
  ctx.strokeStyle = HUD_COLOURS.inkDim;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);

  // The strip spans 180 degrees of yaw, centred on the nose.
  const halfSpan = Math.PI;
  const markers = state.compass || [];
  const cx = x + cw / 2;

  for (const m of markers) {
    const off = normalizeAngle(m.bearing);
    if (Math.abs(off) > halfSpan) continue;
    const px = cx + (off / halfSpan) * (cw / 2);
    const colour = m.station ? HUD_COLOURS.station
      : m.planet ? HUD_COLOURS.planet : HUD_COLOURS.neutral;
    ctx.fillStyle = colour;
    // A tall marker for the station, a short one for everything else.
    const mh = m.station ? ch - 6 * k : 8 * k;
    ctx.fillRect(px - 1, y + 3, 2, mh);
    ctx.font = (HUD_LAYOUT.smallFont * k) + 'px ' + MONO;
    ctx.textAlign = 'center';
    // Above or below, so overlapping markers do not collide.
    if (m.label) ctx.fillText(m.label, px, m.station ? y + ch + 2 : y + ch - 12 * k);
  }

  // Centre index.
  ctx.strokeStyle = HUD_COLOURS.ink;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(cx, y - 4);
  ctx.lineTo(cx, y + 4);
  ctx.stroke();

  // Cardinal ticks, so the strip has a sense of scale.
  ctx.strokeStyle = HUD_COLOURS.inkFaint;
  ctx.lineWidth = 1;
  for (let a = -halfSpan; a <= halfSpan; a += halfSpan / 4) {
    const px = cx + (a / halfSpan) * (cw / 2);
    ctx.beginPath();
    ctx.moveTo(px, y + ch - 4);
    ctx.lineTo(px, y + ch);
    ctx.stroke();
  }
}

/** Scrolling message log, bottom left. */
function drawMessages(ctx, state) {
  const msgs = state.messages || [];
  if (!msgs.length) return;
  const { width: w, height: h } = state;

  const k = state.scale || 1;
  ctx.font = (HUD_LAYOUT.font * k) + 'px ' + MONO;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';

  const baseY = h - h * 0.045;
  const lineH = 18 * k;
  const x = w * 0.035;

  // Newest at the bottom, fading upward.
  const shown = msgs.slice(-HUD_LAYOUT.messageMax);

  // A soft plate behind the log, dark at the left edge and gone by the right.
  //
  // Over empty space it is invisible, so it costs nothing; over the station it
  // is the difference between reading a line and guessing at it. Measured over
  // the arrival station: mean contrast ratio **1.74**, with **97 %** of the
  // log's pixels below the 3:1 readability floor.
  let widest = 0;
  for (const m of shown) widest = Math.max(widest, ctx.measureText(m.text).width);
  const padX = 10 * k;
  const top = baseY - shown.length * lineH - lineH * 0.5;
  const plate = ctx.createLinearGradient(x - padX, 0, x + widest + padX * 2, 0);
  plate.addColorStop(0, 'rgba(2,5,10,0.68)');
  plate.addColorStop(1, 'rgba(2,5,10,0)');
  ctx.fillStyle = plate;
  ctx.fillRect(x - padX, top, widest + padX * 3, (baseY + lineH * 0.5) - top);

  for (let i = 0; i < shown.length; i += 1) {
    const m = shown[i];
    const age = m.age || 0;
    const life = m.lifetime || HUD_LAYOUT.messageLifetime;
    const fade = 1 - Math.max(0, (age - life * 0.6) / (life * 0.4));
    const y = baseY - (shown.length - 1 - i) * lineH;
    // The floor is 0.62 rather than 0.35 because this ramp *multiplies the
    // colour's own alpha*, and half the log's colours already carry one:
    // `inkDim` is rgba(...,0.38), so the oldest line was landing at 0.13
    // effective. At 0.78 the oldest line still reads as the dimmer one, which
    // is all the ramp is for.
    const alpha = clamp(fade, 0, 1) * (0.78 + 0.22 * (i / Math.max(1, shown.length - 1)));

    // A dark outline under every glyph, which is what actually makes the log
    // readable: the plate above only darkens the *left* end of each line, and a
    // long line runs off the end of it. An outline travels with the glyph, so
    // the contrast holds over the station, over a planet and over the star
    // alike - and it costs one extra stroke, not a second draw pass.
    //
    // Drawn at full strength whatever the line's own alpha, so a fading line
    // keeps its contrast and only its *glyph* fades. The alpha has to be set
    // *before* the stroke, not after: otherwise the outline inherits whatever
    // the previous line left behind, and the second line of a fading log is
    // outlined at the first line's alpha.
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = HUD_COLOURS.plate;
    ctx.strokeText(m.text, x, y);

    ctx.globalAlpha = alpha;
    ctx.fillStyle = m.colour || HUD_COLOURS.ink;
    ctx.fillText(m.text, x, y);
  }
  ctx.globalAlpha = 1;
}

/** Blinking warnings: low fuel, incoming missile, hull critical, off-axis. */
function drawAlerts(ctx, state) {
  const alerts = state.alerts || [];
  if (!alerts.length) return;
  const { width: w, height: h } = state;

  const k = state.scale || 1;
  ctx.font = ((HUD_LAYOUT.font + 3) * k) + 'px ' + MONO;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const blinkOn = Math.sin((state.time || 0) * 7) > -0.2;
  let y = h * 0.16;
  // The same outline the message log uses. These are the lines that matter most
  // - "MISSILE", "HULL CRITICAL" - and they sit dead centre, which is exactly
  // where a station or a star fills the frame.
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 * k;
  ctx.strokeStyle = HUD_COLOURS.plate;
  for (const a of alerts) {
    if (a.urgent && !blinkOn) { y += 22 * k; continue; }
    ctx.strokeText(a.text, w / 2, y);
    ctx.fillStyle = a.urgent ? HUD_COLOURS.danger : HUD_COLOURS.warn;
    ctx.fillText(a.text, w / 2, y);
    y += 22 * k;
  }
}

/**
 * Which way the hits are coming from.
 *
 * The game already worked out whether a shot arrived from behind - but only as
 * a sentence, and only for the rear quadrant. Under fire from two directions
 * at once, the player had no way to tell which way to turn. This draws a short
 * arc at the screen edge in the bearing of each recent hit, fading out over
 * `damageArcLifetime`.
 *
 * Bearings are in the ship's own frame: 0 is dead ahead, positive to
 * starboard. The screen maps ahead to up, so the canvas angle is the bearing
 * rotated a quarter turn anticlockwise.
 */
function drawDamageArcs(ctx, state) {
  const hits = state.damage;
  if (!hits || !hits.length) return;
  const { width: w, height: h } = state;
  const cx = w / 2;
  const cy = h / 2;
  const k = state.scale || 1;
  const radius = Math.min(w, h) * HUD_LAYOUT.damageArcRadius;
  const span = 0.42;

  ctx.save();
  ctx.lineCap = 'butt';
  for (const hit of hits) {
    const age = hit.age || 0;
    const life = hit.life || HUD_LAYOUT.damageArcLifetime;
    const fade = 1 - Math.max(0, Math.min(1, age / life));
    if (fade <= 0) continue;
    const angle = (hit.bearing || 0) - Math.PI / 2;
    // Recent hits are bright and thick; older ones thin out, so two arcs from
    // the same direction read as one arc fading rather than as a stack.
    ctx.strokeStyle = HUD_COLOURS.danger;
    ctx.globalAlpha = 0.25 + 0.75 * fade;
    ctx.lineWidth = (3 + 9 * fade) * k;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle - span / 2, angle + span / 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * The galaxy chart: a plan view of the whole galaxy with the player's position,
 * named star systems, and the route graph.
 *
 * Drawn as an overlay rather than a separate screen so the game keeps running
 * behind it - being able to read the chart while flying is a genuine quality of
 * life feature, and it is also how the original worked.
 */
export function drawChartOverlay(ctx, state) {
  const { width: w, height: h } = state;
  const chart = state.chart;
  if (!chart) return;

  // Dim the world behind the chart so the lines read.
  //
  // Measured with the scene hidden and shown: at 0.86 the world behind still
  // changed **27 % of the chart's data area**, 3.7 % of it strongly - the worst
  // offender being the station, whose edge lines are the brightest thing in the
  // frame and cut straight across the route graph. 0.96 brings that to 6 % and
  // 0.9 %, which is the point of a backdrop.
  //
  // The opacity alone was not the whole fix, though. The chart used to be drawn
  // *last*, over everything, so this backdrop dimmed the HUD along with the
  // world - and raising the opacity to kill the ghosting made the status column
  // nearly invisible. `drawHud` now draws the chart before the status readout,
  // so this covers the world and the instruments, and nothing else.
  ctx.fillStyle = 'rgba(4,8,14,0.96)';
  ctx.fillRect(0, 0, w, h);

  const pad = Math.min(w, h) * 0.10;
  const size = Math.min(w - pad * 2, h - pad * 2);
  const cx = w / 2;
  const cy = h / 2;
  const scale = (size / 2) / (chart.discRadius || 1);

  ctx.save();
  ctx.translate(cx, cy);

  // --- Galaxy disc ------------------------------------------------------
  ctx.strokeStyle = HUD_COLOURS.inkDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
  ctx.stroke();

  // --- Routes -----------------------------------------------------------
  // Long jumps fade out, so the eye reads the short hops as the real network.
  ctx.lineWidth = 0.8;
  for (const r of chart.routes || []) {
    const a = chart.systems[r.a];
    const b = chart.systems[r.b];
    if (!a || !b) continue;
    const t = clamp(1 - r.distance / (chart.jumpRange || 1), 0, 1);
    ctx.strokeStyle = 'rgba(159,232,255,' + (0.06 + t * 0.24).toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(a.x * scale, a.y * scale);
    ctx.lineTo(b.x * scale, b.y * scale);
    ctx.stroke();
  }

  // --- Systems ----------------------------------------------------------
  const player = chart.player;
  for (const s of chart.systems) {
    const px = s.x * scale;
    const py = s.y * scale;
    const isCurrent = player && s.index === player.index;
    const isSelected = chart.selected === s.index;

    // Hostile or unsafe systems get a warning tint, so the chart doubles as a
    // danger map. This is the whole reason to give systems a danger value.
    const colour = isCurrent ? HUD_COLOURS.ok
      : isSelected ? HUD_COLOURS.warn
        : s.danger > 0.66 ? HUD_COLOURS.danger
          : s.danger > 0.33 ? HUD_COLOURS.warn
            : HUD_COLOURS.ink;

    ctx.fillStyle = colour;
    const r = isCurrent ? 5.5 : isSelected ? 5 : 3;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    // Ring the current system so it is findable at a glance.
    if (isCurrent) {
      ctx.strokeStyle = HUD_COLOURS.ok;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Names for the neighbours and the selection; everything else is dots.
    // Labelling 64 systems at once is unreadable.
    const isNeighbour = s.neighbour;
    if (isCurrent || isSelected || isNeighbour) {
      ctx.fillStyle = isCurrent ? HUD_COLOURS.ok : HUD_COLOURS.inkDim;
      ctx.font = HUD_LAYOUT.smallFont + 'px ' + MONO;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name, px + 8, py);
    }

    // Jump range ring on the current system.
    if (isCurrent && chart.jumpRange) {
      ctx.strokeStyle = 'rgba(138,255,176,0.20)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(px, py, chart.jumpRange * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.restore();

  // --- Legend -----------------------------------------------------------
  // Centred along the bottom, not tucked into the left corner: the message log
  // lives there, and it is drawn *after* the chart now, so a left-aligned
  // legend would be covered by it. The scanner that used to occupy the bottom
  // centre is not drawn while the chart is up, so the space is free.
  const ly = h - pad * 0.7;
  ctx.font = HUD_LAYOUT.smallFont + 'px ' + MONO;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = HUD_COLOURS.inkDim;
  ctx.fillText(CHART_LEGEND, w / 2, ly);

  // Selected-system detail card.
  if (chart.selectedInfo) {
    drawSystemCard(ctx, chart.selectedInfo, w - pad, pad * 1.2);
  }
}

/**
 * A count with its noun in the right number.
 *
 * One function rather than a ternary at each call site: these strings are the
 * first thing a new commander reads. The title screen said "1 systems visited"
 * and the death screen "1 kills", which is the kind of detail that makes a whole
 * build feel unattended.
 */
export function countOf(n, singular) {
  return n + ' ' + (n === 1 ? singular : singular + 's');
}

/**
 * Which overlay the HUD canvas should carry in a given mode.
 *
 * Extracted from the draw switch so the decision can be tested. The flight HUD
 * used to be drawn in *every* mode that was not title, death or hyperspace -
 * which quietly included `docked`, so a crosshair floated over the market table
 * and a scanner ring showed through the price list. Measured, the flight HUD
 * painted 2.9 % of the frame while docked. A list of the modes that draw
 * something is easier to keep honest than a fall-through.
 *
 * `chart` is deliberately *not* on the silent list: the galaxy chart is drawn
 * by the HUD itself, so that mode needs the canvas.
 */
export function hudOverlayFor(mode) {
  if (mode === 'title') return 'title';
  if (mode === 'dead') return 'death';
  if (mode === 'hyperspace') return 'hyperspace';
  if (mode === 'docked') return 'none';
  return 'flight';
}

/**
 * The key legend drawn along the bottom of the galaxy chart.
 *
 * A module constant rather than a string literal inside the draw call, so a
 * test can hold it against `BINDINGS`. It read "ENTER = select" for as long as
 * the chart has existed, and **nothing has ever been bound to Enter** - the
 * chart is driven by the arrows, `T`/`G` to step and `H` to jump. Promising a
 * key that does nothing is worse than saying nothing: it is the one the player
 * tries first.
 */
export const CHART_LEGEND =
  'O = close   H = hyperspace   arrows/WASD = move cursor   T/G = step';

/**
 * What the HUD says when the pointer is not captured.
 *
 * Deliberately a separate string from `TITLE_CONTROLS`, and deliberately not
 * passed through `hud.test.js`'s key scan: "click" and "Esc" are not keys the
 * game binds, and a scanner that reads every capital letter as a key promise
 * would flag them. The promise made here is a *mouse* promise - a click - and
 * the one key it names is checked by hand in the test.
 */
export const MOUSE_HINT = {
  /** Nothing captured yet: the click is the gesture that captures it. */
  capture: 'CLICK TO FLY WITH THE MOUSE',
  /** Flight, pointer free. Same promise as above, said from the cockpit. */
  manual: 'KEYBOARD STEERING   CLICK TO FLY WITH THE MOUSE',
  /** The browser said no. Saying "click" again would be a lie. */
  refused: 'MOUSE CAPTURE REFUSED BY THE BROWSER   KEYBOARD STEERING',
  /** Not drawn today: kept as the place the release key is documented. */
  flying: 'MOUSE STEERS   ESC RELEASES THE POINTER',
};

/**
 * The key legend on the title screen. Same reasoning as `CHART_LEGEND`.
 */
export const TITLE_CONTROLS = [
  'W A S D / arrows steer      R F throttle      Space brake      Z boost',
  'M fire      N missile      T target      C dock      H jump      O chart',
];
/** A detail card for the selected system, top right of the chart. */
function drawSystemCard(ctx, info, right, top) {
  const lines = [
    info.name,
    info.factionName + ' / ' + info.govName,
    'Tech ' + info.tech + '   Pop ' + info.population.toFixed(1) + 'B',
    'Economy: ' + info.econName,
    'Condition: ' + info.conditionName,
    'Danger: ' + dangerLabel(info.danger),
    info.distance !== undefined ? 'Distance: ' + info.distance.toFixed(1) + ' ly' : null,
    info.fuelNeeded !== undefined ? 'Fuel: ' + info.fuelNeeded.toFixed(1) + ' ly' : null,
  ].filter(Boolean);

  ctx.font = HUD_LAYOUT.font + 'px ' + MONO;
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
  const cardW = maxW + 24;
  const cardH = lines.length * 18 + 18;
  const x = right - cardW;

  ctx.fillStyle = HUD_COLOURS.glass;
  ctx.fillRect(x, top, cardW, cardH);
  ctx.strokeStyle = HUD_COLOURS.inkDim;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, top + 0.5, cardW - 1, cardH - 1);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillStyle = i === 0 ? HUD_COLOURS.warn
      : lines[i].startsWith('Danger') ? dangerColour(info.danger)
        : HUD_COLOURS.ink;
    ctx.fillText(lines[i], x + 12, top + 10 + i * 18);
  }
}

/** A word for a danger value. Numbers are hard to judge at a glance. */
function dangerLabel(d) {
  if (d >= 0.85) return 'ANARCHY';
  if (d >= 0.66) return 'DANGEROUS';
  if (d >= 0.45) return 'LAWLESS';
  if (d >= 0.22) return 'PATROLLED';
  return 'SAFE';
}

function dangerColour(d) {
  if (d >= 0.66) return HUD_COLOURS.danger;
  if (d >= 0.33) return HUD_COLOURS.warn;
  return HUD_COLOURS.ok;
}

/**
 * The docking approach aid: shows the slot, the axis, and whether the ship is
 * inside the acceptance cone.
 *
 * Without this, docking in a modern vector game is a guessing game and the
 * "friendlier" brief is violated. With it, it is a skill you can learn in two
 * attempts.
 */
export function drawDockingGuide(ctx, state) {
  const guide = state.docking;
  if (!guide) return;
  const { width: w, height: h } = state;

  const cx = w / 2;
  const cy = h * 0.72;

  if (guide.ok) {
    const k = state.scale || 1;
    ctx.strokeStyle = HUD_COLOURS.ok;
    ctx.lineWidth = 2;
    ctx.font = ((HUD_LAYOUT.font + 4) * k) + 'px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DOCKING', cx, cy);
    ctx.strokeRect(cx - 90 * k, cy - 16 * k, 180 * k, 32 * k);
    return;
  }

  // The reasons, in the order a pilot should fix them, with the offending
  // value so the message is actionable rather than just "no".
  //
  // The speed ceiling comes from the verdict rather than a constant, because
  // the envelope is wider when a Docking Computer is fitted - coaching against
  // the stock 90 would tell a computer-assisted pilot to slow down when the
  // station would already have taken them.
  const limitSpeed = (guide.limits && guide.limits.maxSpeed) || 90;
  const hints = {
    'too-fast': ['SLOW DOWN', 'reduce speed below ' + limitSpeed],
    'off-axis': ['LINE UP WITH SLOT', 'steer toward the slot centre'],
    'bad-attitude': ['TURN TO FACE THE SLOT', 'fly into the station, not away'],
    'out-of-range': ['APPROACH THE STATION', 'the slot is not in range yet'],
  };
  const [head, sub] = hints[guide.reason] || ['NOT ALIGNED', 'align with the docking slot'];

  const k = state.scale || 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = ((HUD_LAYOUT.font + 2) * k) + 'px ' + MONO;
  ctx.fillStyle = guide.reason === 'too-fast' ? HUD_COLOURS.danger : HUD_COLOURS.warn;
  ctx.fillText(head, cx, cy);
  ctx.font = (HUD_LAYOUT.smallFont * k) + 'px ' + MONO;
  ctx.fillStyle = HUD_COLOURS.inkDim;
  ctx.fillText(sub, cx, cy + 20 * k);

  // A live speed readout while too fast, because that is the fixable one.
  if (guide.reason === 'too-fast' && guide.speed !== undefined) {
    ctx.fillStyle = HUD_COLOURS.danger;
    ctx.font = (HUD_LAYOUT.font * k) + 'px ' + MONO;
    ctx.fillText(guide.speed.toFixed(0) + ' / ' + limitSpeed, cx, cy + 42 * k);
  }
}

/** Small helper shared with the canvases: format a distance for display. */
export function formatDistance(d) {
  if (d === undefined || d === null) return '';
  if (d >= 1000000) return (d / 1000000).toFixed(1) + 'M';
  if (d >= 1000) return (d / 1000).toFixed(1) + 'k';
  return d.toFixed(0);
}

/** Wrap an angle into -pi..pi, for the compass strip. */
function normalizeAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Project a world position to screen space, given the camera basis.
 *
 * Kept here rather than in the renderer because the HUD needs it for target
 * boxes and the lead pip, and duplicating the projection is how target boxes
 * end up drawn a few pixels off.
 */
export function projectToScreen(world, cameraPos, basis, width, height, fov) {
  const dx = world.x - cameraPos.x;
  const dy = world.y - cameraPos.y;
  const dz = world.z - cameraPos.z;

  // Into camera space: forward is the nose, right and up complete the frame.
  const f = dx * basis.forward.x + dy * basis.forward.y + dz * basis.forward.z;
  const r = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z;
  const u = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z;

  if (f <= 0.001) return null; // behind the camera

  const focal = (height / 2) / Math.tan(fov / 2);
  return {
    x: width / 2 + (r / f) * focal,
    y: height / 2 - (u / f) * focal,
    distance: f,
    // On-screen size, so the target box scales with range.
    size: Math.min(90, Math.max(12, (focal * 12) / f)),
  };
}

/**
 * Where to aim to hit a moving target, in screen space.
 *
 * The offset is clamped, not just the time to impact. A fast crossing target
 * has a large screen-space velocity, and an unclamped pip flies off the edge of
 * the display exactly when the shot matters most.
 */
export function leadPip(screen, targetScreenVelocity, timeToImpact, maxOffset) {
  if (!screen || !targetScreenVelocity) return null;
  const t = clamp(timeToImpact || 0, 0, 2);
  const limit = maxOffset === undefined ? 140 : maxOffset;
  let dx = targetScreenVelocity.x * t;
  let dy = targetScreenVelocity.y * t;
  const mag = Math.hypot(dx, dy);
  if (mag > limit) {
    const k = limit / mag;
    dx *= k;
    dy *= k;
  }
  return { x: screen.x + dx, y: screen.y + dy };
}

export default {
  HUD_COLOURS, HUD_LAYOUT, CHART_LEGEND, TITLE_CONTROLS, MOUSE_HINT,
  drawHud, drawChartOverlay, drawDockingGuide,
  formatDistance, projectToScreen, leadPip, hudScale, countOf, hudOverlayFor,
};
