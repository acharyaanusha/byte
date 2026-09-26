// Generates a whole pet type ("species") in Byte's 16-bit pixel style with an OpenRouter
// image model: a hatchling drawn from a text description using Byte as the style
// reference, sprout and companion stages as edits of it, 7 poses per stage as edits of
// each stage, and a 4-frame walk cycle per stage drawn as ONE sprite sheet (frames
// generated separately collapse into near-identical images). Frames are keyed off
// magenta and placed on a shared 384x256 canvas in public/pet/<species>/.
// Usage: OPENROUTER_API_KEY=... node scripts/gen-species.mjs <species> [--finish-only | --walk <stage,stage>]
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.SPRITE_MODEL ?? 'google/gemini-3-pro-image';
const [species, flag] = process.argv.slice(2);
const RAW = path.resolve('.byte/species-raw', species);
const OUT = path.resolve('public/pet', species);
const STYLE_REF = path.resolve('public/pet/dragon/hatchling-idle.png');
const CANVAS_W = 384, CANVAS_H = 256, GROUND = 244, IDLE_H = 200;

const BG = 'Flat solid pure magenta (#FF00FF) background everywhere, whole body visible with margin, no text, no props, no shadow.';
const KEEP = `Keep the exact same character design, face, eyes, colors, 16-bit pixel art style, pixel size and outline. ${BG}`;

export const SPECIES = {
  cat: {
    hatchling: 'a round baby kitten: orange tabby fur with darker stripes, cream belly, big shiny dark eyes, small pink nose, pointed ears, a curly tail',
    sprout: 'give it a small blue wizard hat; body very slightly larger',
    companion: 'make the wizard hat taller with little gold stars, add a flowing purple cape, and a tiny glowing wand in one paw',
  },
  robot: {
    hatchling: 'a small round boxy robot pet: light gray-blue metal body, a teal glowing screen face with two big shiny dark oval eyes, little arms, stubby legs',
    sprout: 'add a small antenna on its head with a glowing teal tip; body very slightly larger',
    companion: 'add a small jetpack on its back and a glowing teal core on its chest; make the antenna a bit taller',
  },
};

const POSES = {
  blink: 'Edit this exact character: same pose, but with both eyes closed in a gentle happy blink. ',
  jump: 'Edit this exact character: joyful celebration jump, both arms raised up, mouth open in a big smile, happy eyes, feet off the ground. ',
  puzzled: 'Edit this exact character: confused and puzzled, head tilted to one side, one paw scratching its head, small frown. ',
  sleep: 'Edit this exact character: fast asleep, curled up lying down, eyes closed, peaceful. IMPORTANT: the entire background must stay flat pure magenta #FF00FF, no bed, no blanket, no colored box. ',
  wave: 'Edit this exact character: happily waving hello with one paw raised high, big smile. ',
  sit: 'Edit this exact character: sitting down on its bottom, legs stretched out in front, relaxed and content, small smile. ',
};
const WALK_SHEET = `Using this exact character (same design, colors, 16-bit pixel art style and outline), draw a 4-frame WALK CYCLE sprite sheet: four frames side by side in ONE single horizontal row (never two rows), evenly spaced with very wide empty gaps so no wings, tails or flames touch or overlap between frames, every frame in strict side profile facing LEFT, same size, same ground line. Frame 1: contact, front leg stepping far forward, back leg stretched behind. Frame 2: passing, legs together under the body, body slightly higher. Frame 3: contact, the OPPOSITE leg forward. Frame 4: passing again. The legs must clearly alternate between frames 1 and 3. No text, no numbers, no grid lines, no shadows, no ground line. ${BG}`;

async function generate(prompt, refs) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const content = [{ type: 'text', text: prompt }, ...refs.map((r) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${r.toString('base64')}` } }))];
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content }] }),
      });
      const json = await res.json();
      const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) throw new Error(JSON.stringify(json).slice(0, 200));
      return Buffer.from(url.split(',')[1], 'base64');
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
}

const tint = (d, i) => Math.min(d[i], d[i + 2]) - d[i + 1];

/** Keys out magenta with hard alpha, peels the anti-aliased pink fringe, despills, trims. */
async function keyed(raw) {
  const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  for (let i = 0; i < data.length; i += 4) if (tint(data, i) > 60) data[i + 3] = 0;
  for (let pass = 0; pass < 2; pass++) {
    const clear = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] === 0 || tint(data, i) <= 15) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx < 0 || ny < 0 || nx >= W || ny >= H || data[(ny * W + nx) * 4 + 3] === 0;
      })) clear.push(i);
    }
    for (const i of clear) data[i + 3] = 0;
  }
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i + 3] = 255;
    if (tint(data, i) > 15) { const g = data[i + 1]; data[i] = Math.min(data[i], g + 15); data[i + 2] = Math.min(data[i + 2], g + 15); }
  }
  return sharp(await sharp(data, { raw: info }).png().toBuffer()).trim({ threshold: 1 }).toBuffer();
}

async function place(trimmed, scale, file) {
  const m = await sharp(trimmed).metadata();
  const s = Math.min(scale, (CANVAS_W - 6) / m.width, (GROUND - 4) / m.height);
  const w = Math.round(m.width * s), h = Math.round(m.height * s);
  const body = await sharp(trimmed).resize(w, h, { kernel: 'nearest' }).toBuffer();
  await sharp({ create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, left: Math.round((CANVAS_W - w) / 2), top: GROUND - h }]).png().toFile(file);
}

/** Splits a walk sheet into 4 frames: on empty columns, or at the emptiest column near each quarter. */
async function sliceSheet(sheet) {
  const { data, info } = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = (i) => tint(data, i) > 60;
  const dark = (i) => data[i] < 70 && data[i + 1] < 70 && data[i + 2] < 70;
  for (let y = 0; y < info.height; y++) { // paint over a drawn ground line
    let n = 0;
    for (let x = 0; x < info.width; x++) if (dark((y * info.width + x) * 4)) n++;
    if (n > info.width * 0.4) for (let x = 0; x < info.width; x++) { const i = (y * info.width + x) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 255; }
  }
  // Some sheets come back as several rows (e.g. a left-facing and a right-facing cycle):
  // keep only the first row of characters.
  let top = 0, bottom = info.height - 1;
  const rowFilled = [];
  for (let y = 0; y < info.height; y++) {
    let n = 0;
    for (let x = 0; x < info.width; x++) if (!bg((y * info.width + x) * 4)) n++;
    rowFilled.push(n > 2);
  }
  const bands = [];
  for (let y = 0; y < info.height; y++) {
    if (rowFilled[y] && (y === 0 || !rowFilled[y - 1])) bands.push({ a: y, b: y });
    if (rowFilled[y]) bands[bands.length - 1].b = y;
  }
  const rows = bands.filter((r) => r.b - r.a > info.height * 0.15);
  if (rows.length > 1) { top = Math.max(0, rows[0].a - 4); bottom = Math.min(info.height - 1, rows[0].b + 4); }
  const fill = [];
  for (let x = 0; x < info.width; x++) {
    let n = 0;
    for (let y = top; y <= bottom; y++) if (!bg((y * info.width + x) * 4)) n++;
    fill.push(n);
  }
  let runs = [];
  for (let x = 0; x < info.width; x++) {
    if (fill[x] > 2 && (x === 0 || fill[x - 1] <= 2)) runs.push({ a: x, b: x });
    if (fill[x] > 2) runs[runs.length - 1].b = x;
  }
  runs = runs.filter((r) => r.b - r.a > info.width / 20);
  if (runs.length !== 4) {
    const cuts = [0];
    for (let q = 1; q < 4; q++) {
      const c = Math.round((info.width * q) / 4), r = Math.round(info.width * 0.08);
      let best = c;
      for (let x = c - r; x <= c + r; x++) if (fill[x] < fill[best]) best = x;
      cuts.push(best);
    }
    cuts.push(info.width - 1);
    runs = [0, 1, 2, 3].map((i) => ({ a: cuts[i] + 5, b: cuts[i + 1] - 5 }));
  }
  const clean = await sharp(data, { raw: info }).png().toBuffer();
  return Promise.all(runs.map((r) => sharp(clean).extract({ left: Math.max(0, r.a - 4), top, width: Math.min(info.width - Math.max(0, r.a - 4), r.b - r.a + 9), height: bottom - top + 1 }).png().toBuffer()));
}

/** A usable walk sheet slices into 4 whole characters of similar height, not fragments. */
async function walkFramesOk(frames) {
  const heights = [];
  for (const f of frames) {
    // A character touching the slice's left/right edge was cut through.
    const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const edgeHit = (x) => { let n = 0; for (let y = 0; y < info.height; y++) { const i = (y * info.width + x) * 4; if (tint(data, i) <= 60) n++; } return n > 3; };
    if (edgeHit(0) || edgeHit(info.width - 1)) return false;
    heights.push((await sharp(await keyed(f)).metadata()).height);
  }
  const max = Math.max(...heights), min = Math.min(...heights);
  return min / max > 0.8 && max > 150;
}

/** Generates, slices, checks and saves one stage's walk cycle; retries a bad sheet. */
async function walkCycle(stage, base) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const sheet = await generate(WALK_SHEET, [base]);
      const frames = await sliceSheet(sheet);
      if (!(await walkFramesOk(frames))) { console.log(`  ${species} ${stage} walk sheet ${attempt}: bad layout, retrying`); continue; }
      await fs.writeFile(path.join(RAW, `${stage}-walksheet.png`), sheet);
      const left = await facesLeft(frames[0], base);
      const names = ['walk1', 'walkpass', 'walk2', 'walkpass2'];
      for (let i = 0; i < 4; i++) await fs.writeFile(path.join(RAW, `${stage}-${names[i]}.png`), left ? frames[i] : await sharp(frames[i]).flop().toBuffer());
      console.log(`  ${species} ${stage} walk ok (attempt ${attempt})`);
      return;
    } catch (e) { console.log(`  ${species} ${stage} walk attempt ${attempt} error: ${e.message}`); }
  }
  console.log(`  ${species} ${stage} walk FAILED after 5 attempts`);
}

/** Frames must face left (the animator mirrors for right). Compares each way against the idle silhouette. */
async function facesLeft(frame, idle) {
  const size = { width: 64, height: 64, fit: 'fill' };
  const mask = async (buf) => (await sharp(buf).resize(size).ensureAlpha().raw().toBuffer()).filter((_, i) => i % 4 === 3);
  const a = await mask(await keyed(frame)), b = await mask(await keyed(idle));
  const flipped = await mask(await sharp(await keyed(frame)).flop().toBuffer());
  const score = (m) => m.reduce((n, v, i) => n + ((v > 0) === (b[i] > 0) ? 1 : 0), 0);
  // Heads are heavier than tails: the side the idle (facing left) is heavy on should match.
  const leftMass = (m) => { let l = 0, r = 0; m.forEach((v, i) => { if (v > 0) (i % 64 < 32 ? l++ : r++); }); return l - r; };
  const idleLeft = leftMass(b) > 0;
  return (leftMass(a) > 0) === idleLeft ? score(a) >= score(flipped) - 200 : score(a) > score(flipped) + 200;
}

async function finish() {
  for (const stage of ['hatchling', 'sprout', 'companion']) {
    // A redrawn resting pose (e.g. the cat's sit) keeps the original drawing as the size reference.
    const refFile = path.join(RAW, `${stage}-base.png`);
    const idle = await keyed(await fs.readFile(await fs.access(refFile).then(() => refFile, () => path.join(RAW, `${stage}-idle.png`))));
    const scale = IDLE_H / (await sharp(idle).metadata()).height;
    const walk1 = await keyed(await fs.readFile(path.join(RAW, `${stage}-walk1.png`)));
    const walkScale = (IDLE_H * 0.97) / (await sharp(walk1).metadata()).height;
    for (const pose of ['idle', ...Object.keys(POSES), 'walk1', 'walkpass', 'walk2', 'walkpass2']) {
      try {
        await place(await keyed(await fs.readFile(path.join(RAW, `${stage}-${pose}.png`))), pose.startsWith('walk') ? walkScale : scale, path.join(OUT, `${stage}-${pose}.png`));
      } catch { console.log(`  ${species}: missing ${stage}-${pose}`); }
    }
  }
}

const spec = SPECIES[species];
if (!spec) throw new Error(`unknown species ${species}; one of ${Object.keys(SPECIES).join(', ')}`);
await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(OUT, { recursive: true });
const save = (name, buf) => fs.writeFile(path.join(RAW, `${name}.png`), buf);
const t0 = Date.now();

if (flag === '--rest') {
  // Redraw the resting pose and its blink, e.g. a cat sitting like a cat instead of standing upright.
  const how = process.argv.slice(4).join(' ');
  await Promise.all(['hatchling', 'sprout', 'companion'].map(async (stage) => {
    const baseFile = path.join(RAW, `${stage}-base.png`);
    const base = await fs.readFile(await fs.access(baseFile).then(() => baseFile, () => path.join(RAW, `${stage}-idle.png`)));
    await fs.writeFile(baseFile, base);
    const rest = await generate(`Edit this exact character: ${how}. ${KEEP}`, [base]);
    await fs.writeFile(path.join(RAW, `${stage}-idle.png`), rest);
    await fs.writeFile(path.join(RAW, `${stage}-blink.png`), await generate(POSES.blink + KEEP, [rest]));
    console.log(`  ${species} ${stage}: new resting pose`);
  }));
} else if (flag === '--reslice') {
  // Re-cut saved walk sheets (no generation).
  for (const stage of process.argv[4].split(',')) {
    const base = await fs.readFile(path.join(RAW, `${stage}-idle.png`));
    const frames = await sliceSheet(await fs.readFile(path.join(RAW, `${stage}-walksheet.png`)));
    console.log(`  ${species} ${stage}: ${(await walkFramesOk(frames)) ? 'ok' : 'still bad'}`);
    const left = await facesLeft(frames[0], base);
    const names = ['walk1', 'walkpass', 'walk2', 'walkpass2'];
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(RAW, `${stage}-${names[i]}.png`), left ? frames[i] : await sharp(frames[i]).flop().toBuffer());
  }
} else if (flag === '--walk') {
  const stages = process.argv[4].split(',');
  await Promise.all(stages.map(async (stage) => walkCycle(stage, await fs.readFile(path.join(RAW, `${stage}-idle.png`)))));
} else if (flag !== '--finish-only') {
  const style = await fs.readFile(STYLE_REF);
  const bases = {};
  bases.hatchling = await generate(`Draw ONE new original cute desktop pet character in exactly the same 16-bit pixel art style, pixel size, outline and shading as this reference image (a different character, not a green dragon): ${spec.hatchling}. Three-quarter view facing LEFT, standing idle pose, friendly expression. ${BG}`, [style]);
  await save('hatchling-idle', bases.hatchling);
  bases.sprout = await generate(`Edit this exact character: ${spec.sprout}. Same pose. ${KEEP}`, [bases.hatchling]);
  await save('sprout-idle', bases.sprout);
  bases.companion = await generate(`Edit this exact character: ${spec.companion}. Same pose. ${KEEP}`, [bases.sprout]);
  await save('companion-idle', bases.companion);
  console.log(`${species}: stages done ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await Promise.all(['hatchling', 'sprout', 'companion'].flatMap((stage) => [
    ...Object.entries(POSES).map(async ([pose, p]) => {
      try { await save(`${stage}-${pose}`, await generate(p + KEEP, [bases[stage]])); } catch (e) { console.log(`  ${species} ${stage}-${pose} failed`); }
    }),
    walkCycle(stage, bases[stage]),
  ]));
  console.log(`${species}: poses done ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await finish();
console.log(`${species}: frames written to public/pet/${species}/`);
