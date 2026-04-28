'use strict';

/**
 * Asset library -- AI-selected downloads of 3D models, textures, HDRIs, and Blender files.
 *
 * Instead of keyword-matching filenames, this module:
 *   1. Searches Poly Haven / ambientCG APIs for multiple candidates (coarse text pre-filter)
 *   2. Calls a `selectFn(candidates, query, sceneContext)` that uses Copilot vision to examine
 *      actual thumbnail images and pick the most visually appropriate asset.
 *   3. Downloads only the AI-chosen asset.
 *
 * Folder structure (rooted at ASSET_ROOT):
 *   ASSET_ROOT/
 *     models/    -- OBJ / GLTF / .blend mesh files
 *     textures/  -- PNG / JPG PBR diffuse maps
 *     hdris/     -- EXR / HDR environment maps
 *     blends/    -- native .blend scene / object files
 *
 * ASSET_ROOT defaults to ~/.blender-copilot/assets/
 * Override with env var ASSET_PATH (or BLENDER_ASSET_PATH for backward compat).
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { execSync } = require('child_process');

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
// HTTP helpers
// ---------------------------------------------------------------------------

function httpsGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'blender-cli/2.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        resolve(httpsGet(res.headers.location, redirectsLeft - 1));
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('Request timed out')));
  });
}

function downloadFile(url, localPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    const lib  = new URL(url).protocol === 'https:' ? https : http;
    const req  = lib.get(url, { headers: { 'User-Agent': 'blender-cli/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        file.close();
        fs.unlink(localPath, () => {});
        return downloadFile(res.headers.location, localPath, redirectsLeft - 1).then(resolve).catch(reject);
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
// ZIP extraction (for ambientCG)
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
// Well-known 3D test meshes
// These are canonical reference models whose name IS their content; included as
// candidates alongside Poly Haven results so the AI can visually compare.
// ---------------------------------------------------------------------------

const WELL_KNOWN_MODELS = [
  {
    source: 'common3d', id: 'teapot', name: 'Utah Teapot',
    tags: ['teapot', 'ceramic', 'kitchen', 'tableware', 'pot'],
    previewUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/Utah_teapot_%28solid%29.png/200px-Utah_teapot_%28solid%29.png',
    downloadUrl: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/teapot.obj',
  },
  {
    source: 'common3d', id: 'stanford-bunny', name: 'Stanford Bunny',
    tags: ['bunny', 'rabbit', 'animal', 'stanford', 'small'],
    previewUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/43/Stanford_Bunny.png/200px-Stanford_Bunny.png',
    downloadUrl: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/stanford-bunny.obj',
  },
  {
    source: 'common3d', id: 'xyzrgb_dragon', name: 'Stanford Dragon',
    tags: ['dragon', 'creature', 'mythical', 'scan', 'stanford'],
    previewUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b3/Dragon_front_current.jpg/200px-Dragon_front_current.jpg',
    downloadUrl: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/xyzrgb_dragon.obj',
  },
  {
    source: 'common3d', id: 'armadillo', name: 'Stanford Armadillo',
    tags: ['armadillo', 'animal', 'scan', 'stanford'],
    previewUrl: null,
    downloadUrl: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/armadillo.obj',
  },
  {
    source: 'common3d', id: 'lucy', name: 'Stanford Lucy (Angel)',
    tags: ['angel', 'statue', 'sculpture', 'winged', 'figure', 'woman', 'classical', 'marble', 'standing'],
    previewUrl: null,
    downloadUrl: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/lucy.obj',
  },
  {
    source: 'common3d', id: 'spot', name: 'Spot (Cow)',
    tags: ['cow', 'animal', 'spot', 'quad', 'bovine'],
    previewUrl: null,
    downloadUrl: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/spot.obj',
  },
  {
    source: 'common3d', id: 'fertility', name: 'Fertility Vase',
    tags: ['vase', 'fertility', 'classical', 'ornate', 'ceramic', 'antique'],
    previewUrl: null,
    downloadUrl: 'https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/fertility.obj',
  },
];

// ---------------------------------------------------------------------------
// Poly Haven multi-candidate search
// Returns top N candidates ordered by coarse text score — AI vision does final selection.
// ---------------------------------------------------------------------------

/**
 * @param {string} query
 * @param {'hdris'|'textures'|'models'} category
 * @param {number} limit
 * @returns {Promise<Array<{source,id,name,tags,categories,score,previewUrl}>>}
 */
async function searchPolyHavenCandidates(query, category, limit = 8) {
  try {
    const { statusCode, body } = await httpsGet(`https://api.polyhaven.com/assets?t=${category}`);
    if (statusCode !== 200) return [];
    const assets = JSON.parse(body);
    const words  = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const scored = [];
    for (const [id, info] of Object.entries(assets)) {
      const tagText = (info.tags ?? []).join(' ');
      const catText = (info.categories ?? []).join(' ');
      const text    = `${id} ${info.name ?? ''} ${tagText} ${catText}`.toLowerCase();
      const score   = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
      scored.push({
        source: 'polyhaven',
        id,
        name: info.name ?? id,
        tags: info.tags ?? [],
        categories: info.categories ?? [],
        score,
        previewUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?height=200`,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// ambientCG multi-candidate search (textures only)
// ---------------------------------------------------------------------------

/**
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{source,id,name,tags,previewUrl}>>}
 */
async function searchAmbientCGCandidates(query, limit = 5) {
  try {
    const url = `https://ambientcg.com/api/v2/full_json?q=${encodeURIComponent(query)}&limit=${limit}&sort=Popular`;
    const { statusCode, body } = await httpsGet(url);
    if (statusCode !== 200) return [];
    const data = JSON.parse(body);
    return (data.foundAssets ?? []).map((a) => ({
      source: 'ambientcg',
      id: a.assetId,
      name: a.displayName ?? a.assetId,
      tags: a.tags ?? [],
      categories: a.categories ?? [],
      previewUrl: `https://ambientcg.com/img/AssetImages/${a.assetId}_PREVIEW.jpg`,
    }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Poly Haven file info + bundle download
// ---------------------------------------------------------------------------

async function getPolyHavenFiles(assetId) {
  try {
    const { statusCode, body } = await httpsGet(`https://api.polyhaven.com/files/${assetId}`);
    if (statusCode !== 200) return null;
    return JSON.parse(body);
  } catch { return null; }
}

/**
 * Download a Poly Haven bundle (main file + all companion files listed in .include).
 * Returns the absolute path of the main file.
 */
async function downloadPolyHavenBundle(formatObj, destDir, log = () => {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const mainFname = path.basename(new URL(formatObj.url).pathname);
  const mainPath  = path.join(destDir, mainFname);
  log(`Downloading: ${mainFname}...`);
  await downloadFile(formatObj.url, mainPath);
  for (const [relPath, fileInfo] of Object.entries(formatObj.include ?? {})) {
    if (!fileInfo?.url) continue;
    const localPath = path.join(destDir, relPath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    log(`Downloading companion: ${path.basename(relPath)}...`);
    await downloadFile(fileInfo.url, localPath);
  }
  return mainPath;
}

// ---------------------------------------------------------------------------
// Model resolver — Poly Haven + well-known meshes, AI-selected by visual content
// ---------------------------------------------------------------------------

/**
 * @param {string} query
 * @param {string} sceneContext  Full user prompt for AI selection context
 * @param {Function|null} selectFn  async (candidates, query, sceneContext) => id
 * @param {Function} log
 * @returns {Promise<{absPath:string, format:string, name:string}|null>}
 */
async function resolveModel(query, sceneContext, selectFn, log = () => {}) {
  log(`Searching models for "${query}"...`);

  // Gather candidates from multiple sources in parallel
  const [phCandidates] = await Promise.all([
    searchPolyHavenCandidates(query, 'models', 6),
  ]);

  // Include well-known test meshes if their tags are plausibly relevant
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const knownRelevant = WELL_KNOWN_MODELS.filter((m) => {
    const text = `${m.name} ${m.tags.join(' ')}`.toLowerCase();
    return queryWords.some((w) => w.length >= 3 && text.includes(w));
  });

  const allCandidates = [...knownRelevant, ...phCandidates];
  if (allCandidates.length === 0) { log(`No model candidates for "${query}"`); return null; }

  log(`Found ${allCandidates.length} candidates, AI selecting best for "${query}"...`);

  let chosenId = allCandidates[0].id;
  if (selectFn && allCandidates.length > 1) {
    chosenId = await selectFn(allCandidates, query, sceneContext) ?? chosenId;
  }

  const chosen = allCandidates.find((c) => c.id === chosenId) ?? allCandidates[0];
  log(`Selected model: ${chosen.name} (${chosen.source})`);

  // --- Download ---
  if (chosen.source === 'common3d') {
    const ext       = chosen.downloadUrl.split('.').pop();
    const localPath = path.join(MODELS_DIR, `${chosen.id}.${ext}`);
    log(`Downloading ${chosen.name}...`);
    await downloadFile(chosen.downloadUrl, localPath);
    return { absPath: localPath, format: ext, name: chosen.id };
  }

  if (chosen.source === 'polyhaven') {
    const files = await getPolyHavenFiles(chosen.id);
    if (!files) return null;
    const assetDir = path.join(MODELS_DIR, chosen.id);

    const blendFmt = files?.blend?.['1k']?.blend ?? files?.blend?.['2k']?.blend;
    if (blendFmt?.url) {
      const p = await downloadPolyHavenBundle(blendFmt, assetDir, log);
      return { absPath: p, format: 'blend', name: chosen.id };
    }
    const objFmt = files?.obj?.['1k']?.obj ?? files?.obj?.['2k']?.obj;
    if (objFmt?.url) {
      const p = await downloadPolyHavenBundle(objFmt, assetDir, log);
      return { absPath: p, format: 'obj', name: chosen.id };
    }
    const gltfFmt = files?.gltf?.['1k']?.gltf ?? files?.gltf?.['2k']?.gltf;
    if (gltfFmt?.url) {
      const p = await downloadPolyHavenBundle(gltfFmt, assetDir, log);
      return { absPath: p, format: 'gltf', name: chosen.id };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Texture resolver — Poly Haven + ambientCG, AI-selected by visual content
// ---------------------------------------------------------------------------

/**
 * @param {string} query
 * @param {string} sceneContext
 * @param {Function|null} selectFn
 * @param {Function} log
 * @returns {Promise<{absPath:string, name:string}|null>}
 */
async function resolveTexture(query, sceneContext, selectFn, log = () => {}) {
  log(`Searching textures for "${query}"...`);

  const [phCandidates, acgCandidates] = await Promise.all([
    searchPolyHavenCandidates(query, 'textures', 5),
    searchAmbientCGCandidates(query, 5),
  ]);

  const allCandidates = [...phCandidates, ...acgCandidates];
  if (allCandidates.length === 0) { log(`No texture candidates for "${query}"`); return null; }

  log(`Found ${allCandidates.length} candidates, AI selecting best texture for "${query}"...`);

  let chosenId = allCandidates[0].id;
  if (selectFn && allCandidates.length > 1) {
    chosenId = await selectFn(allCandidates, query, sceneContext) ?? chosenId;
  }

  const chosen = allCandidates.find((c) => c.id === chosenId) ?? allCandidates[0];
  log(`Selected texture: ${chosen.name} (${chosen.source})`);

  // --- Download ---
  if (chosen.source === 'polyhaven') {
    const files = await getPolyHavenFiles(chosen.id);
    if (!files) return null;
    const diffuse = files['Diffuse'] ?? files['diffuse'] ?? files['albedo'] ?? files['Color'];
    if (!diffuse) return null;
    const res1k   = diffuse['1k'] ?? diffuse['2k'];
    const imgInfo = res1k?.['jpg'] ?? res1k?.['png'];
    if (!imgInfo?.url) return null;
    const ext       = imgInfo.url.endsWith('.png') ? 'png' : 'jpg';
    const localPath = path.join(TEXTURES_DIR, `${chosen.id}_diff_1k.${ext}`);
    log(`Downloading texture: ${chosen.id}_diff_1k.${ext}...`);
    await downloadFile(imgInfo.url, localPath);
    return { absPath: localPath, name: chosen.id };
  }

  if (chosen.source === 'ambientcg') {
    const localPath  = path.join(TEXTURES_DIR, `${chosen.id}_1K_Color.jpg`);
    const zipPath    = path.join(TEXTURES_DIR, `_tmp_${chosen.id}.zip`);
    const extractDir = path.join(TEXTURES_DIR, `_extract_${chosen.id}`);
    for (const res of ['1K', '2K']) {
      try {
        await downloadFile(`https://ambientcg.com/get?file=${chosen.id}_${res}-JPG.zip`, zipPath);
        extractZip(zipPath, extractDir);
        const colorFile = findColorMapInDir(extractDir);
        if (colorFile) {
          fs.copyFileSync(colorFile, localPath);
          cleanup([zipPath, extractDir]);
          return { absPath: localPath, name: chosen.id };
        }
        cleanup([zipPath, extractDir]);
        break;
      } catch (_) {}
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// HDRI resolver — Poly Haven, AI-selected by visual content
// ---------------------------------------------------------------------------

/**
 * @param {string} query
 * @param {string} sceneContext
 * @param {Function|null} selectFn
 * @param {Function} log
 * @returns {Promise<{absPath:string, name:string}|null>}
 */
async function resolveHDRI(query, sceneContext, selectFn, log = () => {}) {
  log(`Searching HDRIs for "${query}"...`);

  const candidates = await searchPolyHavenCandidates(query, 'hdris', 8);
  if (candidates.length === 0) { log(`No HDRI candidates for "${query}"`); return null; }

  log(`Found ${candidates.length} candidates, AI selecting best HDRI for "${query}"...`);

  let chosenId = candidates[0].id;
  if (selectFn && candidates.length > 1) {
    chosenId = await selectFn(candidates, query, sceneContext) ?? chosenId;
  }

  const chosen = candidates.find((c) => c.id === chosenId) ?? candidates[0];
  log(`Selected HDRI: ${chosen.name}`);

  const files = await getPolyHavenFiles(chosen.id);
  if (!files) return null;

  const hdriSection = files.hdri ?? files;
  const res1k       = hdriSection['1k'] ?? hdriSection['2k'];
  if (!res1k) return null;
  const fileInfo = res1k.exr ?? res1k.hdr;
  if (!fileInfo?.url) return null;

  const ext       = res1k.exr ? 'exr' : 'hdr';
  const localPath = path.join(HDRIS_DIR, `${chosen.id}_1k.${ext}`);
  log(`Downloading HDRI: ${chosen.id}_1k.${ext}...`);
  await downloadFile(fileInfo.url, localPath);
  return { absPath: localPath, name: chosen.id };
}

// ---------------------------------------------------------------------------
// Blend resolver — Poly Haven, AI-selected
// ---------------------------------------------------------------------------

/**
 * @param {string} query
 * @param {string} sceneContext
 * @param {Function|null} selectFn
 * @param {Function} log
 * @returns {Promise<{absPath:string, name:string}|null>}
 */
async function resolveBlend(query, sceneContext, selectFn, log = () => {}) {
  log(`Searching .blend files for "${query}"...`);

  const candidates = await searchPolyHavenCandidates(query, 'models', 6);
  if (candidates.length === 0) { log(`No .blend candidates for "${query}"`); return null; }

  log(`Found ${candidates.length} candidates, AI selecting best .blend for "${query}"...`);

  let chosenId = candidates[0].id;
  if (selectFn && candidates.length > 1) {
    chosenId = await selectFn(candidates, query, sceneContext) ?? chosenId;
  }

  const chosen = candidates.find((c) => c.id === chosenId) ?? candidates[0];

  const files = await getPolyHavenFiles(chosen.id);
  if (!files) return null;
  const blendFmt = files?.blend?.['1k']?.blend ?? files?.blend?.['2k']?.blend;
  if (!blendFmt?.url) { log(`No .blend available for "${chosen.name}"`); return null; }

  const assetDir  = path.join(BLENDS_DIR, chosen.id);
  const mainFname = path.basename(new URL(blendFmt.url).pathname);
  const mainPath  = path.join(assetDir, mainFname);
  log(`Downloading .blend: ${mainFname}...`);
  await downloadPolyHavenBundle(blendFmt, assetDir, log);
  return { absPath: mainPath, name: chosen.id };
}

// ---------------------------------------------------------------------------
// Batch downloader
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// URL-based resolver — when user provides a direct download link or GitHub repo URL
// ---------------------------------------------------------------------------

/** Walk a directory tree and collect all 3D mesh files, sorted by format priority. */
function collectMeshFiles(dir) {
  const MODEL_EXTS = ['.obj', '.gltf', '.glb', '.blend', '.stl', '.ply', '.fbx', '.dae'];
  // Blender 4.x dropped built-in Collada; put .dae last so .stl/.obj/.gltf are preferred.
  const EXT_PRIORITY = { '.obj': 1, '.gltf': 2, '.glb': 2, '.stl': 3, '.ply': 4, '.fbx': 5, '.blend': 6, '.dae': 7 };
  const results = [];
  function walk(d) {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (MODEL_EXTS.some((e) => entry.name.toLowerCase().endsWith(e))) results.push(full);
      }
    } catch (_) {}
  }
  walk(dir);
  results.sort((a, b) => {
    const pa = EXT_PRIORITY[path.extname(a).toLowerCase()] ?? 9;
    const pb = EXT_PRIORITY[path.extname(b).toLowerCase()] ?? 9;
    if (pa !== pb) return pa - pb;
    // prefer larger files (more complete mesh)
    try { return fs.statSync(b).size - fs.statSync(a).size; } catch { return 0; }
  });
  return results;
}

/**
 * Download an asset directly from a user-provided URL.
 *
 * Handles:
 *   - Direct file URLs (.obj / .gltf / .glb / .blend / .dae / .stl etc.)
 *   - GitHub blob URLs  (github.com/.../blob/...)  → converted to raw.githubusercontent.com
 *   - GitHub repo URLs  (github.com/owner/repo)    → ZIP archive extracted, mesh files collected
 *
 * When the source contains multiple mesh files (e.g. a robot description repo),
 * all mesh files are copied flat into a per-key directory and that directory path
 * is returned. The Blender `import_model` helper handles directory ASSETS automatically.
 *
 * @param {string} url
 * @param {string} key
 * @param {Function} log
 * @returns {Promise<{absPath:string, format:string, name:string}|null>}
 */
async function resolveFromUrl(url, key, log = () => {}) {
  // Convert GitHub blob URL → raw URL
  const rawUrl = url.replace(
    /github\.com\/([^/]+)\/([^/]+)\/blob\//,
    'raw.githubusercontent.com/$1/$2/',
  );

  // Case 1: Direct 3D file URL (after blob→raw conversion)
  const extMatch = rawUrl.match(/\.(obj|gltf|glb|blend|fbx|dae|stl|ply)(\?.*)?$/i);
  if (extMatch) {
    const ext       = extMatch[1].toLowerCase();
    const localPath = path.join(MODELS_DIR, `${key}.${ext}`);
    log(`Downloading ${key} from URL...`);
    await downloadFile(rawUrl, localPath);
    return { absPath: localPath, format: ext, name: key };
  }

  // Case 2: GitHub repo URL → download ZIP, extract, collect mesh files
  const ghRepoMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)\/?(?:\?.*)?$/);
  if (ghRepoMatch) {
    const [, owner, repoRaw] = ghRepoMatch;
    const repo       = repoRaw.replace(/\.git$/, '');
    const zipPath    = path.join(MODELS_DIR, `_tmp_${key}.zip`);
    const extractDir = path.join(MODELS_DIR, `_extract_${key}`);

    for (const branch of ['main', 'master']) {
      try {
        cleanup([zipPath, extractDir]);
        const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
        log(`Downloading ${owner}/${repo} (${branch} branch)...`);
        await downloadFile(zipUrl, zipPath);
        extractZip(zipPath, extractDir);
        fs.unlinkSync(zipPath);

        const meshFiles = collectMeshFiles(extractDir);
        if (meshFiles.length === 0) { cleanup([extractDir]); continue; }

        if (meshFiles.length === 1) {
          const ext       = path.extname(meshFiles[0]).slice(1).toLowerCase();
          const localPath = path.join(MODELS_DIR, `${key}.${ext}`);
          fs.copyFileSync(meshFiles[0], localPath);
          cleanup([extractDir]);
          log(`Downloaded 1 mesh file from ${owner}/${repo}`);
          return { absPath: localPath, format: ext, name: key };
        }

        // Multiple mesh files: copy flat into a named directory
        const destDir = path.join(MODELS_DIR, key);
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        const seen = new Set();
        for (const mf of meshFiles) {
          let fname = path.basename(mf);
          if (seen.has(fname)) {
            const base = path.basename(mf, path.extname(mf));
            let i = 2;
            while (seen.has(`${base}_${i}${path.extname(mf)}`)) i++;
            fname = `${base}_${i}${path.extname(mf)}`;
          }
          seen.add(fname);
          fs.copyFileSync(mf, path.join(destDir, fname));
        }
        cleanup([extractDir]);
        log(`Downloaded ${meshFiles.length} mesh files from ${owner}/${repo}`);
        return { absPath: destDir, format: 'dir', name: key };
      } catch (_) {
        cleanup([zipPath, extractDir]);
      }
    }
    return null;
  }

  // Case 3: Unknown URL — try downloading directly
  try {
    const localPath = path.join(MODELS_DIR, `${key}_download`);
    log(`Downloading ${key} from URL...`);
    await downloadFile(url, localPath);
    return { absPath: localPath, format: 'unknown', name: key };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Batch downloader
// ---------------------------------------------------------------------------

/**
 * Download all requested assets and return a {key: absPath} mapping.
 *
 * @param {Array<{type:'model'|'texture'|'hdri'|'blend', query:string, key:string, url?:string}>} assetList
 * @param {(msg:string) => void} [log]
 * @param {((candidates, query, sceneContext) => Promise<string|null>)|null} [selectFn]
 * @param {string} [sceneContext]
 * @returns {Promise<Record<string,string>>}  key -> absolute path
 */
async function downloadAssets(assetList, log = () => {}, selectFn = null, sceneContext = '') {
  const result = {};
  for (const item of assetList) {
    try {
      let r = null;
      if (item.url) {
        // User provided an explicit download URL — use it directly, skip AI search
        r = await resolveFromUrl(item.url, item.key, log);
      } else if (item.type === 'model')   {
        r = await resolveModel(item.query, sceneContext, selectFn, log);
      } else if (item.type === 'texture') {
        r = await resolveTexture(item.query, sceneContext, selectFn, log);
      } else if (item.type === 'hdri')    {
        r = await resolveHDRI(item.query, sceneContext, selectFn, log);
      } else if (item.type === 'blend')   {
        r = await resolveBlend(item.query, sceneContext, selectFn, log);
      }
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
  resolveModel, resolveTexture, resolveHDRI, resolveBlend, resolveFromUrl,
  searchPolyHavenCandidates, searchAmbientCGCandidates,
};
