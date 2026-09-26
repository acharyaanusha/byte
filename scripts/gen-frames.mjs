// Generates Byte's animation frames (pixel-art style) with an OpenRouter image model.
// 1. Stage bases: hatchling (the chosen reference) → sprout (+ small wings) → companion (+ big wings, gold star).
// 2. Per stage, each pose is an edit of that stage's base, so the character stays consistent.
// Frames are keyed off magenta and placed on a shared 256x256 canvas: one scale per stage
// (taken from the idle frame) and a shared ground line, so switching frames never jumps.
// Usage: OPENROUTER_API_KEY=... node scripts/gen-frames.mjs <hatchling-reference.png> [--rekey]
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.SPRITE_MODEL ?? 'google/gemini-3-pro-image';
const RAW = path.resolve('.byte/frames-raw');
const OUT = path.resolve('public/pet/frames');
// Wide canvas so the companion's wings never shrink its body.
const CANVAS_W = 384, CANVAS_H = 256, GROUND = 244, IDLE_H = 200;

const KEEP = 'Keep the exact same character design, face, eyes, horns, colors, 16-bit pixel art style, pixel size and outline. Flat solid pure magenta (#FF00FF) background, whole body visible with margin, no text, no props, no shadow.';
const STAGES = {
  sprout: 'Edit this exact character: add two small rounded mint-green dragon wings on its back and make the body very slightly larger. Same pose. ' + KEEP,
  companion: 'Edit this exact character: make its wings noticeably bigger and more majestic, and add one small gold star marking on the cream belly. Same pose. ' + KEEP,
};
const POSES = {
  blink: 'Edit this exact character: same pose, but with both eyes closed in a gentle happy blink (curved lines). ' + KEEP,
  walk1: 'Redraw this exact character in a clearly different pose: a walking animation frame in strict SIDE PROFILE facing LEFT (we only see one eye). Big mid-stride step: the front leg is lifted high and reaching forward to the left, the back leg pushes off behind, arms swinging, tail trailing out to the right. The pose must look obviously different from standing. ' + KEEP,
  walk2: 'This is frame 1 of a walk cycle. Draw frame 2: the same character in the same strict side profile facing LEFT, but now the OPPOSITE leg is lifted and stepping forward while the other leg is planted behind, arms swinging the other way. Clearly different leg positions from frame 1. ' + KEEP,
  jump: 'Edit this exact character: joyful celebration jump, both arms raised up, mouth open in a big smile, eyes happy, feet tucked up off the ground. ' + KEEP,
  puzzled: 'Edit this exact character: confused and puzzled, head tilted to one side, one paw scratching its head, small frown, one eyebrow raised. ' + KEEP,
  sleep: 'Edit this exact character: fast asleep, curled up lying down on its belly with tail wrapped around, eyes closed, peaceful. IMPORTANT: the entire background must stay flat pure magenta #FF00FF, no bed, no blanket, no colored box. ' + KEEP,
  wave: 'Edit this exact character: happily waving hello with one paw raised high, big smile. ' + KEEP,
  walkpass: 'This is a walk-cycle contact frame. Draw the PASSING frame of the same walk: same strict side profile facing LEFT, the body slightly higher, one leg straight under the body carrying the weight and the other leg bent and lifted, passing it mid-swing. Arms relaxed at the sides. ' + KEEP,
  sit: 'Edit this exact character: sitting down on its bottom on the ground, legs stretched out in front, relaxed and content, looking forward with a small smile. ' + KEEP,
};

async function generate(prompt, refPng) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, modalities: ['image', 'text'],
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${refPng.toString('base64')}` } },
          ] }],
        }),
      });
      const json = await res.json();
      const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) throw new Error(JSON.stringify(json).slice(0, 300));
      return Buffer.from(url.split(',')[1], 'base64');
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`  retry (${err.message.slice(0, 80)})`);
    }
  }
}

/**
 * Keys out magenta and trims to the character. Pixel art wants hard alpha, so:
 * clearly-magenta pixels go transparent, then two passes peel off pinkish edge
 * pixels that touch transparency (the anti-aliased fringe), and any tint left is
 * pulled out of the colors (despill).
 */
async function keyed(raw) {
  const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const tint = (i) => Math.min(data[i], data[i + 2]) - data[i + 1];
  for (let i = 0; i < data.length; i += 4) if (tint(i) > 60) data[i + 3] = 0;
  for (let pass = 0; pass < 2; pass++) {
    const clear = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] === 0 || tint(i) <= 15) continue;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx < 0 || ny < 0 || nx >= W || ny >= H || data[((ny * W) + nx) * 4 + 3] === 0;
      });
      if (edge) clear.push(i);
    }
    for (const i of clear) data[i + 3] = 0;
  }
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i + 3] = 255;
    if (tint(i) > 15) { const g = data[i + 1]; data[i] = Math.min(data[i], g + 15); data[i + 2] = Math.min(data[i + 2], g + 15); }
  }
  return sharp(await sharp(data, { raw: info }).png().toBuffer()).trim({ threshold: 1 }).toBuffer();
}

async function place(trimmed, scale, file) {
  const m = await sharp(trimmed).metadata();
  const s = Math.min(scale, (CANVAS_W - 6) / m.width, (GROUND - 4) / m.height);
  const w = Math.round(m.width * s), h = Math.round(m.height * s);
  const body = await sharp(trimmed).resize(w, h, { kernel: 'nearest' }).toBuffer();
  await sharp({ create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, left: Math.round((CANVAS_W - w) / 2), top: GROUND - h }])
    .png().toFile(file);
}

async function finishStage(stage) {
  const idle = await keyed(await fs.readFile(path.join(RAW, `${stage}-idle.png`)));
  const scale = IDLE_H / (await sharp(idle).metadata()).height;
  for (const pose of ['idle', ...Object.keys(POSES)]) {
    const raw = path.join(RAW, `${stage}-${pose}.png`);
    try { await place(await keyed(await fs.readFile(raw)), scale, path.join(OUT, `${stage}-${pose}.png`)); }
    catch { console.log(`  missing ${stage}-${pose}`); }
  }
}

await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(OUT, { recursive: true });
const [ref, flag] = process.argv.slice(2);
const stages = ['hatchling', 'sprout', 'companion'];

if (flag === '--only') {
  // Regenerate specific frames, e.g. --only hatchling-sleep,sprout-walk1 (walk2 always follows walk1).
  const wanted = process.argv[4].split(',');
  await Promise.all(wanted.map(async (id) => {
    const [stage, pose] = id.split('-');
    const base = await fs.readFile(path.join(RAW, `${stage}-${pose === 'walkpass' ? 'walk1' : 'idle'}.png`));
    const out = await generate(POSES[pose], base);
    await fs.writeFile(path.join(RAW, `${stage}-${pose}.png`), out);
    if (pose === 'walk1') await fs.writeFile(path.join(RAW, `${stage}-walk2.png`), await generate(POSES.walk2, out));
    console.log(`  ${id} done`);
  }));
} else if (flag !== '--rekey') {
  const t = Date.now();
  const bases = { hatchling: await fs.readFile(ref) };
  await fs.writeFile(path.join(RAW, 'hatchling-idle.png'), bases.hatchling);
  bases.sprout = await generate(STAGES.sprout, bases.hatchling);
  await fs.writeFile(path.join(RAW, 'sprout-idle.png'), bases.sprout);
  console.log(`sprout base ${((Date.now() - t) / 1000).toFixed(0)}s`);
  bases.companion = await generate(STAGES.companion, bases.sprout);
  await fs.writeFile(path.join(RAW, 'companion-idle.png'), bases.companion);
  console.log(`companion base ${((Date.now() - t) / 1000).toFixed(0)}s`);
  await Promise.all(stages.flatMap((stage) => {
    const save = (pose, buf) => fs.writeFile(path.join(RAW, `${stage}-${pose}.png`), buf);
    const simple = ['blink', 'jump', 'puzzled', 'sleep', 'wave'].map(async (pose) => save(pose, await generate(POSES[pose], bases[stage])));
    const walk = (async () => {
      const w1 = await generate(POSES.walk1, bases[stage]);
      await save('walk1', w1);
      await save('walk2', await generate(POSES.walk2, w1));
    })();
    return [...simple, walk].map((p) => p.catch((e) => console.log(`  ${stage} pose failed: ${e.message.slice(0, 120)}`)));
  }));
  console.log(`all poses ${((Date.now() - t) / 1000).toFixed(0)}s`);
}
for (const s of stages) await finishStage(s);
console.log('frames written to public/pet/frames');
