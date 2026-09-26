// Generates the three Byte stage portraits with an OpenRouter image model.
// Hatchling first, then each later stage is an edit of the previous one so the
// face, palette and framing stay consistent. The model paints on flat magenta;
// sharp keys that out to a transparent 512x512 PNG with a shared baseline.
// Usage: OPENROUTER_API_KEY=... node scripts/gen-sprites.mjs [hatchling|sprout|companion]
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY && process.argv[2] !== 'rekey') throw new Error('OPENROUTER_API_KEY is not set');
const MODEL = process.env.SPRITE_MODEL ?? 'google/gemini-3-pro-image';
const OUT = path.resolve('public/pet');
const RAW = path.resolve('.byte/raw');

const BASE =
  'A single original adorable mint-green baby dragon game pet, front three-quarter view, rounded bean-shaped body, cream belly, tiny charcoal horns, large simple dark oval eyes, tiny feet, one small tail, friendly neutral expression. Clean polished 2D game sprite, crisp smooth dark outlines, flat limited palette, subtle shading, readable at 96 pixels. Whole character centered on a square canvas, feet near 85 percent canvas height, ample empty margin on every side, no text, no props, no cast shadow. Background: perfectly flat solid pure magenta (#FF00FF), nothing else in the background.';

const EDITS = {
  sprout:
    'Edit this exact character. Preserve the exact same face, eyes, horns, palette, outline style, pose, framing and flat pure magenta (#FF00FF) background. Only changes: add two small rounded mint-green wings on its back, and make the body slightly larger. Do not change the art style. No text.',
  companion:
    'Edit this exact character. Preserve the exact same face, eyes, horns, palette, outline style, pose, framing and flat pure magenta (#FF00FF) background. Only changes: make the wings noticeably larger and more confident, and add one small gold star marking on the cream belly. Do not change the art style. No text.',
};

async function generate(prompt, refPng) {
  const content = [{ type: 'text', text: prompt }];
  if (refPng) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${refPng.toString('base64')}` } });
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 400)}`);
  return Buffer.from(url.split(',')[1], 'base64');
}

/** Keys out magenta, crops to the character, and places it on a 512 canvas with feet at 85%. */
async function toSprite(raw) {
  const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    // Magenta-ness: red and blue high, green low. Soft edge for anti-aliasing.
    const m = Math.min(r, b) - g;
    if (m > 120) data[i + 3] = 0;
    else if (m > 60) {
      data[i + 3] = Math.round(255 * (1 - (m - 60) / 60));
      // Despill: pull the magenta tint out of edge pixels.
      data[i] = Math.min(r, g + 40);
      data[i + 2] = Math.min(b, g + 40);
    }
  }
  const keyed = sharp(data, { raw: info }).png();
  const trimmed = await sharp(await keyed.toBuffer()).trim({ threshold: 1 }).toBuffer();
  const meta = await sharp(trimmed).metadata();
  // Fit by height (380px) so wings never shrink the body; width capped at 500, bottom at y=435 (85% of 512).
  const scale = Math.min(500 / meta.width, 380 / meta.height);
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);
  const body = await sharp(trimmed).resize(w, h).toBuffer();
  return sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, left: Math.round((512 - w) / 2), top: 435 - h }])
    .png()
    .toBuffer();
}

async function stage(name, prompt, ref) {
  console.log(`generating ${name} with ${MODEL}...`);
  const t = Date.now();
  const raw = await generate(prompt, ref);
  await fs.writeFile(path.join(RAW, `${name}.png`), raw);
  await fs.writeFile(path.join(OUT, `${name}.png`), await toSprite(raw));
  console.log(`  ${name} done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return raw;
}

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(RAW, { recursive: true });
const only = process.argv[2];
const rawPath = (n) => path.join(RAW, `${n}.png`);
const load = (n) => fs.readFile(rawPath(n));

if (only === 'rekey') {
  for (const n of ['hatchling', 'sprout', 'companion']) await fs.writeFile(path.join(OUT, `${n}.png`), await toSprite(await load(n)));
  console.log('re-keyed');
} else if (!only || only === 'hatchling') {
  const h = await stage('hatchling', BASE);
  if (!only) {
    const s = await stage('sprout', EDITS.sprout, h);
    await stage('companion', EDITS.companion, s);
  }
} else if (only === 'sprout') {
  await stage('sprout', EDITS.sprout, await load('hatchling'));
} else if (only === 'companion') {
  await stage('companion', EDITS.companion, await load('sprout'));
}
