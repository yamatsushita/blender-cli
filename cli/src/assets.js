'use strict';

/**
 * Asset library -- downloads and caches 3D models and textures.
 *
 * Folder structure (rooted at ASSET_ROOT):
 *   ASSET_ROOT/
 *     models/    -- OBJ / GLTF mesh files
 *     textures/  -- PNG / JPG texture maps
 *
 * ASSET_ROOT defaults to ~/.blender-copilot/assets/
 * Override with env var BLENDER_ASSET_PATH.
 *
 * Sources:
 *   1. Built-in registry  -- well-known free models (Utah teapot, Stanford meshes...)
 *   2. Poly Haven API     -- CC0 models (polyhaven.com/models) + textures (polyhaven.com/textures)
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const ASSET_ROOT = process.env.BLENDER_ASSET_PATH
  ?? path.join(os.homedir(), '.blender-copilot', 'assets');

const MODELS_DIR   = path.join(ASSET_ROOT, 'models');
const TEXTURES_DIR = path.join(ASSET_ROOT, 'textures');

fs.mkdirSync(MODELS_DIR,   { recursive: true });
fs.mkdirSync(TEXTURES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Built-in registry
// ---------------------------------------------------------------------------

const MODEL_REGISTRY = [
  {
    keywords: ['utah teapot', 'stanford teapot', 'newell teapot', 'teapot'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/teapot.obj',
    format: 'obj', name: 'utah_teapot',
  },
  {
    keywords: ['stanford bunny', 'bunny'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/stanford-bunny.obj',
    format: 'obj', name: 'stanford_bunny',
  },
  {
    keywords: ['stanford dragon', 'dragon'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/xyzrgb_dragon.obj',
    format: 'obj', name: 'stanford_dragon',
  },
  {
    keywords: ['armadillo'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/armadillo.obj',
    format: 'obj', name: 'armadillo',
  },
  {
    keywords: ['lucy'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/lucy.obj',
    format: 'obj', name: 'lucy',
  },
  {
    keywords: ['spot', 'spot cow'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/spot.obj',
    format: 'obj', name: 'spot',
  },
  {
    keywords: ['cow'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/spot.obj',
    format: 'obj', name: 'spot_cow',
  },
];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'blender-cli/2.0' } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('Request timed out')));
  });
}

function downloadFile(url, localPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    const lib = new URL(url).protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'blender-cli/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(localPath, () => {});
        return downloadFile(res.headers.location, localPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(localPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(localPath)));
      file.on('error', (e) => { file.close(); fs.unlink(localPath, () => {}); reject(e); });
    });
    req.on('error', (e) => { file.close(); fs.unlink(localPath, () => {}); reject(e); });
    req.setTimeout(120_000, () => req.destroy(new Error('Download timed out')));
  });
}

// ---------------------------------------------------------------------------
// Poly Haven
// ---------------------------------------------------------------------------

async function searchPolyHaven(query, category) {
  try {
    const { statusCode, body } = await httpsGet(
      `https://api.polyhaven.com/assets?t=${category}`,
    );
    if (statusCode !== 200) return null;
    const assets = JSON.parse(body);
    const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    let best = null, bestScore = 0;
    for (const [id, info] of Object.entries(assets)) {
      const text = (id + ' ' + (info.name ?? '')).toLowerCase();
      const score = words.filter((w) => text.includes(w)).length;
      if (score > bestScore) { bestScore = score; best = { id, ...info }; }
    }
    return bestScore > 0 ? best : null;
  } catch { return null; }
}

async function getPolyHavenFiles(assetId) {
  try {
    const { statusCode, body } = await httpsGet(`https://api.polyhaven.com/files/${assetId}`);
    if (statusCode !== 200) return null;
    return JSON.parse(body);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Model resolver
// ---------------------------------------------------------------------------

async function resolveModel(query, log = () => {}) {
  const q = query.toLowerCase();

  // 1. Built-in registry
  const entry = MODEL_REGISTRY.find((m) => m.keywords.some((k) => q.includes(k)));
  if (entry) {
    const localPath = path.join(MODELS_DIR, `${entry.name}.${entry.format}`);
    if (!fs.existsSync(localPath)) {
      log(`Downloading model: ${entry.name}.${entry.format}...`);
      await downloadFile(entry.url, localPath);
    }
    log(`Model ready: models/${entry.name}.${entry.format}`);
    return { absPath: localPath, format: entry.format, name: entry.name };
  }

  // 2. Poly Haven models
  log(`Searching Poly Haven models for "${query}"...`);
  const phAsset = await searchPolyHaven(query, 'models');
  if (phAsset) {
    const files = await getPolyHavenFiles(phAsset.id);
    const gltfUrl = files?.gltf?.['1k']?.gltf?.url ?? files?.gltf?.['2k']?.gltf?.url;
    const objUrl  = files?.obj?.['1k']?.obj?.url   ?? files?.obj?.['2k']?.obj?.url;
    const dlUrl = gltfUrl ?? objUrl;
    const fmt   = gltfUrl ? 'gltf' : 'obj';
    if (dlUrl) {
      const localPath = path.join(MODELS_DIR, `${phAsset.id}.${fmt}`);
      if (!fs.existsSync(localPath)) {
        log(`Downloading model: ${phAsset.id}.${fmt}...`);
        await downloadFile(dlUrl, localPath);
      }
      log(`Model ready: models/${phAsset.id}.${fmt}`);
      return { absPath: localPath, format: fmt, name: phAsset.id };
    }
  }

  log(`No model found for "${query}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Texture resolver
// ---------------------------------------------------------------------------

async function resolveTexture(query, log = () => {}) {
  log(`Searching Poly Haven textures for "${query}"...`);
  const phAsset = await searchPolyHaven(query, 'textures');
  if (!phAsset) { log(`No texture found for "${query}"`); return null; }

  const files = await getPolyHavenFiles(phAsset.id);
  if (!files) return null;

  const diffuse = files['Diffuse'] ?? files['diffuse'] ?? files['albedo'] ?? files['Color'];
  if (!diffuse) { log(`No diffuse channel for "${phAsset.id}"`); return null; }

  const res1k = diffuse['1k'] ?? diffuse['2k'];
  if (!res1k) return null;
  const imgInfo = res1k['jpg'] ?? res1k['png'];
  if (!imgInfo?.url) return null;

  const ext = imgInfo.url.endsWith('.png') ? 'png' : 'jpg';
  const localPath = path.join(TEXTURES_DIR, `${phAsset.id}_diff_1k.${ext}`);
  if (!fs.existsSync(localPath)) {
    log(`Downloading texture: ${phAsset.id}_diff_1k.${ext}...`);
    await downloadFile(imgInfo.url, localPath);
  }
  log(`Texture ready: textures/${phAsset.id}_diff_1k.${ext}`);
  return { absPath: localPath, name: phAsset.id };
}

// ---------------------------------------------------------------------------
// Batch downloader
// ---------------------------------------------------------------------------

/**
 * Download all requested assets and return a {key: absPath} mapping.
 *
 * @param {Array<{type: 'model'|'texture', query: string, key: string}>} assetList
 * @param {(msg: string) => void} [log]
 * @returns {Promise<Record<string, string>>}  key -> absolute path
 */
async function downloadAssets(assetList, log = () => {}) {
  const result = {};
  for (const item of assetList) {
    try {
      if (item.type === 'model') {
        const r = await resolveModel(item.query, log);
        if (r) result[item.key] = r.absPath;
      } else if (item.type === 'texture') {
        const r = await resolveTexture(item.query, log);
        if (r) result[item.key] = r.absPath;
      }
    } catch (err) {
      log(`Warning: failed to download "${item.query}": ${err.message}`);
    }
  }
  return result;
}

module.exports = { ASSET_ROOT, downloadAssets, resolveModel, resolveTexture };