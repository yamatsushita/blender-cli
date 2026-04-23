'use strict';

/**
 * 3D asset resolver — finds and downloads free 3D models for use in Blender.
 *
 * Resolution order:
 *   1. Built-in registry  — well-known models (Stanford, Utah teapot, etc.)
 *   2. Poly Haven API     — free CC0 architectural / nature models
 *
 * Downloaded files are cached in ~/.blender-copilot/models/ and reused.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const MODELS_CACHE = path.join(os.homedir(), '.blender-copilot', 'models');
fs.mkdirSync(MODELS_CACHE, { recursive: true });

// ---------------------------------------------------------------------------
// Built-in registry of well-known free 3D models
// ---------------------------------------------------------------------------

const KNOWN_MODELS = [
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
// Helpers
// ---------------------------------------------------------------------------

/** GET a URL and return { statusCode, body }. */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'blender-cli/2.0' } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Timeout')));
  });
}

/** Download a URL to localPath, following redirects. */
function downloadFile(url, localPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'blender-cli/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(localPath, () => {});
        return downloadFile(res.headers.location, localPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(localPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(localPath)));
      file.on('error', (e) => { file.close(); fs.unlink(localPath, () => {}); reject(e); });
    });
    req.on('error', (e) => { file.close(); fs.unlink(localPath, () => {}); reject(e); });
    req.setTimeout(60_000, () => req.destroy(new Error('Download timed out')));
  });
}

// ---------------------------------------------------------------------------
// Poly Haven API
// ---------------------------------------------------------------------------

/** Search Poly Haven 3D models and return the best matching asset, or null. */
async function searchPolyHaven(query) {
  try {
    const { statusCode, body } = await httpsGet('https://api.polyhaven.com/assets?t=models');
    if (statusCode !== 200) return null;
    const assets = JSON.parse(body);
    const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    let best = null, bestScore = 0;
    for (const [id, info] of Object.entries(assets)) {
      const name = (id + ' ' + (info.name ?? '')).toLowerCase();
      const score = words.filter((w) => name.includes(w)).length;
      if (score > bestScore) { bestScore = score; best = { id, ...info }; }
    }
    return bestScore > 0 ? best : null;
  } catch { return null; }
}

/** Get the best download URL for a Poly Haven asset. */
async function getPolyHavenDownloadInfo(assetId) {
  try {
    const { statusCode, body } = await httpsGet(`https://api.polyhaven.com/files/${assetId}`);
    if (statusCode !== 200) return null;
    const files = JSON.parse(body);
    const gltfUrl = files?.gltf?.['1k']?.gltf?.url ?? files?.gltf?.['2k']?.gltf?.url;
    if (gltfUrl) return { url: gltfUrl, format: 'gltf', name: assetId };
    const objUrl = files?.obj?.['1k']?.obj?.url ?? files?.obj?.['2k']?.obj?.url;
    if (objUrl) return { url: objUrl, format: 'obj', name: assetId };
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to find and download a 3D asset matching `query`.
 *
 * @param {string} query  Natural-language name, e.g. "stanford teapot"
 * @param {(msg: string) => void} [log]  Progress callback
 * @returns {Promise<{path: string, format: string, name: string, source: string}|null>}
 */
async function resolveAsset(query, log = () => {}) {
  const q = query.toLowerCase();

  // 1. Built-in registry
  const known = KNOWN_MODELS.find((m) => m.keywords.some((k) => q.includes(k)));
  if (known) {
    const localPath = path.join(MODELS_CACHE, `${known.name}.${known.format}`);
    if (fs.existsSync(localPath)) {
      log(`Using cached model: ${known.name}.${known.format}`);
    } else {
      log(`Downloading ${known.name}.${known.format} from registry…`);
      await downloadFile(known.url, localPath);
      const size = Math.round(fs.statSync(localPath).size / 1024);
      log(`Downloaded ${known.name}.${known.format} (${size} KB)`);
    }
    return { path: localPath, format: known.format, name: known.name, source: 'registry' };
  }

  // 2. Poly Haven
  log(`Searching Poly Haven for "${query}"…`);
  const phAsset = await searchPolyHaven(query);
  if (phAsset) {
    log(`Found on Poly Haven: ${phAsset.id}`);
    const dlInfo = await getPolyHavenDownloadInfo(phAsset.id);
    if (dlInfo) {
      const localPath = path.join(MODELS_CACHE, `${dlInfo.name}.${dlInfo.format}`);
      if (fs.existsSync(localPath)) {
        log(`Using cached model: ${dlInfo.name}.${dlInfo.format}`);
      } else {
        log(`Downloading ${dlInfo.name}.${dlInfo.format}…`);
        await downloadFile(dlInfo.url, localPath);
        const size = Math.round(fs.statSync(localPath).size / 1024);
        log(`Downloaded ${dlInfo.name}.${dlInfo.format} (${size} KB)`);
      }
      return { path: localPath, format: dlInfo.format, name: dlInfo.name, source: 'polyhaven' };
    }
  }

  log(`No downloadable asset found for "${query}"`);
  return null;
}

module.exports = { resolveAsset };
