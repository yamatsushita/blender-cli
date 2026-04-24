'use strict';

/**
 * Asset library -- downloads and caches 3D models, textures, HDRIs, and Blender files.
 *
 * Folder structure (rooted at ASSET_ROOT):
 *   ASSET_ROOT/
 *     models/    -- OBJ / GLTF mesh files
 *     textures/  -- PNG / JPG PBR diffuse maps
 *     hdris/     -- EXR / HDR environment maps
 *     blends/    -- .blend Blender scene / object files
 *
 * ASSET_ROOT defaults to ~/.blender-copilot/assets/
 * Override with env var ASSET_PATH (or BLENDER_ASSET_PATH for backward compat).
 *
 * Sources:
 *   Models   : Built-in registry (Stanford meshes, Utah teapot) -> Poly Haven
 *   Textures : Poly Haven -> ambientCG (CC0 PBR materials, zip download)
 *   HDRIs    : Poly Haven HDRIs (CC0, EXR 1k)
 *   Blends   : Poly Haven models blend format
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { execSync } = require('child_process');

// Accept either ASSET_PATH or BLENDER_ASSET_PATH as the env var name.
const ASSET_ROOT = process.env.ASSET_PATH
  ?? process.env.BLENDER_ASSET_PATH
  ?? path.join(os.homedir(), '.blender-copilot', 'assets');

const MODELS_DIR   = path.join(ASSET_ROOT, 'models');
const TEXTURES_DIR = path.join(ASSET_ROOT, 'textures');
const HDRIS_DIR    = path.join(ASSET_ROOT, 'hdris');
const BLENDS_DIR   = path.join(ASSET_ROOT, 'blends');

for (const d of [MODELS_DIR, TEXTURES_DIR, HDRIS_DIR, BLENDS_DIR])
  fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------------------
// Built-in model registry
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
    keywords: ['armadillo', 'stanford armadillo'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/armadillo.obj',
    format: 'obj', name: 'armadillo',
  },
  {
    keywords: ['lucy', 'stanford lucy'],
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
  {
    keywords: ['bob', 'bob mesh', 'blob'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/bob.obj',
    format: 'obj', name: 'bob',
  },
  {
    keywords: ['fertility', 'vase'],
    url: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/fertility.obj',
    format: 'obj', name: 'fertility',
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
// Poly Haven helpers
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
      const tagText = Array.isArray(info.tags) ? info.tags.join(' ') : '';
      const catText = Array.isArray(info.categories) ? info.categories.join(' ') : '';
      const text = (id + ' ' + (info.name ?? '') + ' ' + tagText + ' ' + catText).toLowerCase();
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
// ZIP extraction helper (for ambientCG)
// ---------------------------------------------------------------------------

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'ignore' },
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'ignore' });
  }
}

function findColorMapInDir(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)); }
  catch { return null; }
  for (const suffix of ['Color', 'Albedo', 'Diffuse', 'col', 'diff']) {
    const f = files.find((n) => n.toLowerCase().includes(suffix.toLowerCase()));
    if (f) return path.join(dir, f);
  }
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

function cleanup(targets) {
  for (const t of targets) {
    try {
      if (fs.statSync(t).isDirectory()) fs.rmSync(t, { recursive: true, force: true });
      else fs.unlinkSync(t);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Model resolver (Built-in registry -> Poly Haven)
// ---------------------------------------------------------------------------

async function resolveModel(query, log = () => {}) {
  const q = query.toLowerCase();

  // 1. Built-in registry
  const entry = MODEL_REGISTRY.find((m) => m.keywords.some((k) => q.includes(k)));
  if (entry) {
    const localPath = path.join(MODELS_DIR, `${entry.name}.${entry.format}`);
    if (!fs.existsSync(localPath)) {
      log(`Downloading model from registry: ${entry.name}.${entry.format}...`);
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
    if (files) {
      // Poly Haven file structure per format at a given resolution:
      //   { url, size, md5, include: { "relative/path": {url, size, md5}, ... } }
      // "include" maps relative paths to companion files that MUST be downloaded
      // next to (or in subdirs relative to) the main file for the importer to work.
      // e.g. GLTF companion: "bark_debris_01.bin", "textures/diff_1k.jpg"
      //      blend companion: "textures/diff_1k.jpg", "textures/rough_1k.exr"
      const downloadBundle = async (formatObj, destDir) => {
        fs.mkdirSync(destDir, { recursive: true });
        // Main file
        const mainFname = path.basename(new URL(formatObj.url).pathname);
        const mainPath  = path.join(destDir, mainFname);
        if (!fs.existsSync(mainPath)) {
          log(`Downloading: ${mainFname}...`);
          await downloadFile(formatObj.url, mainPath);
        }
        // Companion files listed under "include" — keys are relative paths
        for (const [relPath, fileInfo] of Object.entries(formatObj.include ?? {})) {
          if (!fileInfo?.url) continue;
          const localPath = path.join(destDir, relPath);
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          if (!fs.existsSync(localPath)) {
            log(`Downloading: ${path.basename(relPath)}...`);
            await downloadFile(fileInfo.url, localPath);
          }
        }
        return mainPath;
      };

      const assetDir = path.join(MODELS_DIR, phAsset.id);

      // a. Prefer .blend (preserves materials, rigging, and linked textures)
      const blendFmt = files?.blend?.['1k']?.blend ?? files?.blend?.['2k']?.blend;
      if (blendFmt?.url) {
        const blendPath = await downloadBundle(blendFmt, assetDir);
        log(`Model ready (.blend): models/${phAsset.id}/`);
        return { absPath: blendPath, format: 'blend', name: phAsset.id };
      }

      // b. OBJ + companion files (MTL, textures)
      const objFmt = files?.obj?.['1k']?.obj ?? files?.obj?.['2k']?.obj;
      if (objFmt?.url) {
        const objPath = await downloadBundle(objFmt, assetDir);
        log(`Model ready (OBJ): models/${phAsset.id}/`);
        return { absPath: objPath, format: 'obj', name: phAsset.id };
      }

      // c. GLTF + companion files (.bin, textures) — all must be in same subdir
      const gltfFmt = files?.gltf?.['1k']?.gltf ?? files?.gltf?.['2k']?.gltf;
      if (gltfFmt?.url) {
        const gltfPath = await downloadBundle(gltfFmt, assetDir);
        log(`Model ready (GLTF): models/${phAsset.id}/`);
        return { absPath: gltfPath, format: 'gltf', name: phAsset.id };
      }
    }
  }

  log(`No model found for "${query}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Texture resolver (Poly Haven -> ambientCG fallback)
// ---------------------------------------------------------------------------

async function resolveTexture(query, log = () => {}) {
  // 1. Poly Haven textures
  log(`Searching Poly Haven textures for "${query}"...`);
  const phAsset = await searchPolyHaven(query, 'textures');
  if (phAsset) {
    const files = await getPolyHavenFiles(phAsset.id);
    if (files) {
      const diffuse = files['Diffuse'] ?? files['diffuse'] ?? files['albedo'] ?? files['Color'];
      if (diffuse) {
        const res1k = diffuse['1k'] ?? diffuse['2k'];
        const imgInfo = res1k?.['jpg'] ?? res1k?.['png'];
        if (imgInfo?.url) {
          const ext = imgInfo.url.endsWith('.png') ? 'png' : 'jpg';
          const localPath = path.join(TEXTURES_DIR, `${phAsset.id}_diff_1k.${ext}`);
          if (!fs.existsSync(localPath)) {
            log(`Downloading texture: ${phAsset.id}_diff_1k.${ext}...`);
            await downloadFile(imgInfo.url, localPath);
          }
          log(`Texture ready: textures/${phAsset.id}_diff_1k.${ext}`);
          return { absPath: localPath, name: phAsset.id };
        }
      }
    }
  }

  // 2. ambientCG fallback (CC0 PBR materials)
  log(`Searching ambientCG for "${query}"...`);
  try {
    const searchUrl = `https://ambientcg.com/api/v2/full_json?q=${encodeURIComponent(query)}&limit=5&sort=Popular`;
    const { statusCode, body } = await httpsGet(searchUrl);
    if (statusCode === 200) {
      const data = JSON.parse(body);
      const asset = data.foundAssets?.[0];
      if (asset) {
        const assetId = asset.assetId;
        const localPath = path.join(TEXTURES_DIR, `${assetId}_1K_Color.jpg`);
        if (fs.existsSync(localPath)) {
          log(`Texture ready (cached): textures/${path.basename(localPath)}`);
          return { absPath: localPath, name: assetId };
        }
        const zipPath  = path.join(TEXTURES_DIR, `_tmp_${assetId}.zip`);
        const extractDir = path.join(TEXTURES_DIR, `_extract_${assetId}`);
        let downloaded = false;
        for (const res of ['1K', '2K']) {
          const zipUrl = `https://ambientcg.com/get?file=${assetId}_${res}-JPG.zip`;
          try { await downloadFile(zipUrl, zipPath); downloaded = true; break; } catch (_) {}
        }
        if (downloaded) {
          try {
            extractZip(zipPath, extractDir);
            const colorFile = findColorMapInDir(extractDir);
            if (colorFile) {
              fs.copyFileSync(colorFile, localPath);
              cleanup([zipPath, extractDir]);
              log(`Texture ready (ambientCG): textures/${path.basename(localPath)}`);
              return { absPath: localPath, name: assetId };
            }
          } catch (e) {
            log(`Warning: could not extract ambientCG zip (is "unzip" installed?)`);
          }
          cleanup([zipPath, extractDir]);
        }
      }
    }
  } catch (_) {}

  log(`No texture found for "${query}"`);
  return null;
}

// ---------------------------------------------------------------------------
// HDRI resolver (Poly Haven HDRIs -> EXR 1k)
// ---------------------------------------------------------------------------

/**
 * Download a Poly Haven HDRI environment map (EXR 1k).
 * @param {string} query
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{absPath: string, name: string}|null>}
 */
async function resolveHDRI(query, log = () => {}) {
  log(`Searching Poly Haven HDRIs for "${query}"...`);
  const phAsset = await searchPolyHaven(query, 'hdris');
  if (!phAsset) { log(`No HDRI found for "${query}"`); return null; }

  const files = await getPolyHavenFiles(phAsset.id);
  if (!files) return null;

  // HDRI files: files.hdri['1k'].exr.url or files.hdri['1k'].hdr.url
  const hdriSection = files.hdri ?? files;
  const res1k = hdriSection['1k'] ?? hdriSection['2k'];
  if (!res1k) { log(`No 1k/2k resolution for HDRI "${phAsset.id}"`); return null; }

  // Prefer EXR (better precision), fall back to HDR
  const fileInfo = res1k.exr ?? res1k.hdr;
  if (!fileInfo?.url) return null;

  const ext = res1k.exr ? 'exr' : 'hdr';
  const localPath = path.join(HDRIS_DIR, `${phAsset.id}_1k.${ext}`);
  if (!fs.existsSync(localPath)) {
    log(`Downloading HDRI: ${phAsset.id}_1k.${ext}...`);
    await downloadFile(fileInfo.url, localPath);
  }
  log(`HDRI ready: hdris/${phAsset.id}_1k.${ext}`);
  return { absPath: localPath, name: phAsset.id };
}

// ---------------------------------------------------------------------------
// Blend file resolver (Poly Haven model .blend format)
// ---------------------------------------------------------------------------

/**
 * Download a Poly Haven asset as a native .blend file.
 * Falls back to null if no .blend format is available.
 * @param {string} query
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{absPath: string, name: string}|null>}
 */
async function resolveBlend(query, log = () => {}) {
  log(`Searching Poly Haven for .blend file: "${query}"...`);
  const phAsset = await searchPolyHaven(query, 'models');
  if (!phAsset) { log(`No Poly Haven model found for "${query}"`); return null; }

  const files = await getPolyHavenFiles(phAsset.id);
  if (!files) return null;

  // Poly Haven blend format: files.blend['1k'].blend has {url, include: {...}}
  const blendFmt = files?.blend?.['1k']?.blend ?? files?.blend?.['2k']?.blend;
  if (!blendFmt?.url) { log(`No .blend format available for "${phAsset.id}"`); return null; }

  // Download .blend + all companion textures under "include" key
  const assetDir = path.join(BLENDS_DIR, phAsset.id);
  fs.mkdirSync(assetDir, { recursive: true });
  const mainFname = path.basename(new URL(blendFmt.url).pathname);
  const mainPath  = path.join(assetDir, mainFname);
  if (!fs.existsSync(mainPath)) {
    log(`Downloading .blend: ${mainFname}...`);
    await downloadFile(blendFmt.url, mainPath);
  }
  for (const [relPath, fileInfo] of Object.entries(blendFmt.include ?? {})) {
    if (!fileInfo?.url) continue;
    const localFile = path.join(assetDir, relPath);
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    if (!fs.existsSync(localFile)) {
      log(`Downloading: ${path.basename(relPath)}...`);
      await downloadFile(fileInfo.url, localFile);
    }
  }
  log(`.blend ready: blends/${phAsset.id}/`);
  return { absPath: mainPath, name: phAsset.id };
}

// ---------------------------------------------------------------------------
// Batch downloader
// ---------------------------------------------------------------------------

/**
 * Download all requested assets and return a {key: absPath} mapping.
 *
 * @param {Array<{type: 'model'|'texture'|'hdri'|'blend', query: string, key: string}>} assetList
 * @param {(msg: string) => void} [log]
 * @returns {Promise<Record<string, string>>}  key -> absolute path
 */
async function downloadAssets(assetList, log = () => {}) {
  const result = {};
  for (const item of assetList) {
    try {
      let r = null;
      if      (item.type === 'model')   r = await resolveModel(item.query, log);
      else if (item.type === 'texture') r = await resolveTexture(item.query, log);
      else if (item.type === 'hdri')    r = await resolveHDRI(item.query, log);
      else if (item.type === 'blend')   r = await resolveBlend(item.query, log);
      if (r) result[item.key] = r.absPath;
    } catch (err) {
      log(`Warning: failed to download "${item.query}": ${err.message}`);
    }
  }
  return result;
}

module.exports = {
  ASSET_ROOT,
  MODELS_DIR, TEXTURES_DIR, HDRIS_DIR, BLENDS_DIR,
  downloadAssets,
  resolveModel, resolveTexture, resolveHDRI, resolveBlend,
};