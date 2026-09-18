// SPDX-License-Identifier: AGPL-3.0-only
// Thin client for Gemini's image-generation models ("nano banana" —
// gemini-*-flash-image-*) via the generateContent REST API. Stdlib-only
// (uses Node's built-in fetch); no SDK dependency.
//
// Shared by:
//   - serve.js's POST /api/gemini/generate-image (ClawDoc's own UI/agent use)
//   - skills/nano-banana (the embedded-agent skill), which reimplements the
//     same call in Python so it works with no ClawDoc process running — keep
//     the two in sync if the request/response shape here changes.

const fs = require('fs');
const path = require('path');

const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

function mimeForPath(p) {
  return EXT_MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// refPaths: absolute filesystem paths to reference images (style/logo/product
// shots to compose or edit). Gemini image models take these as extra inline
// parts alongside the text prompt — this is how "edit this" / "put X into Y"
// requests work, not just from-scratch generation.
async function generateImage({ apiKey, baseUrl, model, prompt, refPaths }) {
  if (!apiKey) throw new Error('No Gemini API key configured — set one in Settings → Gemini.');
  if (!prompt || !prompt.trim()) throw new Error('missing prompt');

  const parts = [];
  for (const rp of refPaths || []) {
    const data = fs.readFileSync(rp);
    parts.push({ inlineData: { mimeType: mimeForPath(rp), data: data.toString('base64') } });
  }
  parts.push({ text: prompt });

  const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });

  let body;
  try { body = await resp.json(); } catch { body = null; }

  if (!resp.ok) {
    const msg = (body && body.error && body.error.message) || `HTTP ${resp.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }

  const blockReason = body && body.promptFeedback && body.promptFeedback.blockReason;
  if (blockReason) throw new Error(`Gemini blocked the request: ${blockReason}`);

  const candidate = body && body.candidates && body.candidates[0];
  const outParts = (candidate && candidate.content && candidate.content.parts) || [];
  const imgPart = outParts.find(p => p.inlineData && p.inlineData.data);
  const text = outParts.filter(p => p.text).map(p => p.text).join('\n').trim();

  if (!imgPart) {
    const reason = (candidate && candidate.finishReason) || 'no image returned';
    throw new Error(text ? `${reason}: ${text}` : `Gemini returned no image (${reason})`);
  }

  return {
    data: Buffer.from(imgPart.inlineData.data, 'base64'),
    mimeType: imgPart.inlineData.mimeType || 'image/png',
    text: text || null,
  };
}

module.exports = { generateImage, mimeForPath };
