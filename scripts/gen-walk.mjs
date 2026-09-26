// Generates a stage's walk cycle as ONE 4-frame sprite sheet (so the frames are drawn
// together and actually alternate feet), then slices it into walk1/walkpass/walk2/walkpass2.
// Usage: OPENROUTER_API_KEY=... node scripts/gen-walk.mjs <stage> [--slice-only] [--flip]
// --flip mirrors the frames when the model drew the character facing right (frames face left).
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const [stage, ...flags] = process.argv.slice(2);
const flag = flags.includes('--slice-only') ? '--slice-only' : undefined;
const flip = flags.includes('--flip');
const RAW = path.resolve('.pico/frames-raw');
const PROMPT = 'Using this exact character (same design, colors, horns, 16-bit pixel art style and outline), draw a 4-frame WALK CYCLE sprite sheet: four frames side by side in ONE horizontal row, evenly spaced, with wide empty gaps between frames, every frame in strict side profile facing LEFT, all the same size and on the same ground line. Frame 1: contact, the LEFT/front leg stepping far forward and the back leg stretched behind. Frame 2: passing, legs together under the body, body slightly higher. Frame 3: contact, the OPPOSITE leg forward (back leg now in front) and the other stretched behind. Frame 4: passing again, legs together. The legs must clearly alternate between frame 1 and frame 3. Flat solid pure magenta (#FF00FF) background everywhere, no text, no numbers, no grid lines, no shadows.';

async function generate(ref) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'google/gemini-3-pro-image', modalities: ['image', 'text'],
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:image/png;base64,${ref.toString('base64')}` } }] }] }),
  });
  const j = await res.json();
  const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(JSON.stringify(j).slice(0, 300));
  return Buffer.from(url.split(',')[1], 'base64');
}

/** Splits the sheet on fully-background columns into the 4 widest runs. */
async function slice(sheet) {
  const { data, info } = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = (i) => Math.min(data[i], data[i + 2]) - data[i + 1] > 60;
  // Paint over a drawn ground line: a row that is mostly dark pixels (bodies are mostly green).
  const dark = (i) => data[i] < 70 && data[i + 1] < 70 && data[i + 2] < 70;
  for (let y = 0; y < info.height; y++) {
    let n = 0;
    for (let x = 0; x < info.width; x++) if (dark((y * info.width + x) * 4)) n++;
    if (n > info.width * 0.4) for (let x = 0; x < info.width; x++) { const i = (y * info.width + x) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 255; }
  }
  sheet = await sharp(data, { raw: info }).png().toBuffer();
  const filled = [];
  for (let x = 0; x < info.width; x++) {
    let n = 0;
    for (let y = 0; y < info.height; y++) if (!bg((y * info.width + x) * 4)) n++;
    filled.push(n > 2);
  }
  const runs = [];
  for (let x = 0; x < info.width; x++) {
    if (filled[x] && (x === 0 || !filled[x - 1])) runs.push({ a: x, b: x });
    if (filled[x]) runs[runs.length - 1].b = x;
  }
  let frames = runs.filter((r) => r.b - r.a > info.width / 20).sort((p, q) => p.a - q.a);
  if (frames.length !== 4) {
    // Frames touch: cut at the emptiest column near each quarter mark instead.
    const fill = [];
    for (let x = 0; x < info.width; x++) {
      let n = 0;
      for (let y = 0; y < info.height; y++) if (!bg((y * info.width + x) * 4)) n++;
      fill.push(n);
    }
    const cuts = [0];
    for (let q = 1; q < 4; q++) {
      const c = Math.round((info.width * q) / 4), r = Math.round(info.width * 0.08);
      let best = c;
      for (let x = c - r; x <= c + r; x++) if (fill[x] < fill[best]) best = x;
      cuts.push(best);
    }
    cuts.push(info.width - 1);
    frames = [0, 1, 2, 3].map((i) => ({ a: cuts[i] + 5, b: cuts[i + 1] - 5 }));
    console.log(`  frames touch; cut at columns ${cuts.slice(1, 4).join(', ')}`);
  }
  return Promise.all(frames.map((r) => {
    const img = sharp(sheet).extract({ left: Math.max(0, r.a - 4), top: 0, width: Math.min(info.width - Math.max(0, r.a - 4), r.b - r.a + 9), height: info.height });
    return (flip ? img.flop() : img).png().toBuffer();
  }));
}

const sheetPath = path.join(RAW, `${stage}-walksheet.png`);
if (flag !== '--slice-only') await fs.writeFile(sheetPath, await generate(await fs.readFile(path.join(RAW, `${stage}-idle.png`))));
const [f1, f2, f3, f4] = await slice(await fs.readFile(sheetPath));
await fs.writeFile(path.join(RAW, `${stage}-walk1.png`), f1);
await fs.writeFile(path.join(RAW, `${stage}-walkpass.png`), f2);
await fs.writeFile(path.join(RAW, `${stage}-walk2.png`), f3);
await fs.writeFile(path.join(RAW, `${stage}-walkpass2.png`), f4);
console.log(`${stage}: sliced 4 walk frames`);
