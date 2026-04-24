'use strict';

/**
 * GitHub Copilot API client.
 *
 * - Auth via `gh auth token`
 * - Auto-discovers available models with GET /models so we never hardcode
 *   a model name that may not be supported on the user's Copilot plan.
 */

const { execSync } = require('child_process');
const https = require('https');

const COPILOT_ENDPOINT = 'api.githubcopilot.com';

/** Preferred models in priority order — use actual IDs from GET /models. */
const MODEL_PRIORITY = [
  'claude-opus-4.6',
  'claude-opus-4.5',
  'claude-opus-4.7',
  'gpt-4.1',
  'gpt-5.4',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'gpt-4o-mini',
  'claude-haiku-4.5',
  'gpt-3.5-turbo',
];

// ---------------------------------------------------------------------------
// Vision helpers -- multimodal message construction
// ---------------------------------------------------------------------------

/**
 * Extract image URLs from a text string.
 * Recognises http/https URLs that are clearly images (by extension, or known
 * image CDN patterns like Bing thumbnails, Sketchfab previews, imgur, etc.).
 */
function extractImageUrls(text) {
  const urlRe = /https?:\/\/[^\s\])"'>]+/gi;
  const rawUrls = text.match(urlRe) ?? [];
  return rawUrls.filter((url) => {
    const lower = url.toLowerCase();
    // Image file extensions before any query string
    if (/\.(jpg|jpeg|png|gif|webp|bmp|tiff?|avif)(\?|#|$)/.test(lower)) return true;
    // Known image CDN / thumbnail hosts
    if (/tse\d*\.mm\.bing\.net\/th\/|sketchfab\.com.*thumbnail|sketchfab\.com.*preview|cdn\.cloudflare\.steamstatic\.com|i\.imgur\.com|images\.unsplash\.com|upload\.wikimedia\.org|pbs\.twimg\.com|lh\d+\.googleusercontent\.com|graphics\.stanford\.edu\/data\//i.test(url)) return true;
    return false;
  });
}

/**
 * Download an image URL and return a base64 data URI.
 * Follows up to 5 redirects. Returns null on failure.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
function fetchImageAsBase64(url, redirectsLeft = 5) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'blender-cli/2.0' } }, (res) => {
      // Follow redirects (301/302/303/307/308)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        resolve(fetchImageAsBase64(res.headers.location, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      const contentType = res.headers['content-type'] ?? 'image/jpeg';
      const mimeType = contentType.split(';')[0].trim();
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const b64 = Buffer.concat(chunks).toString('base64');
        resolve(`data:${mimeType};base64,${b64}`);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Build OpenAI-compatible multimodal user message content.
 * Downloads any image URLs to base64 data URIs (Copilot API rejects external URLs).
 * Returns the plain string when no images are present.
 * @param {string} text
 * @returns {Promise<string | Array>}
 */
async function buildUserContent(text) {
  const imageUrls = extractImageUrls(text);
  if (imageUrls.length === 0) return text;

  // Download all images in parallel; skip any that fail
  const downloaded = await Promise.all(
    imageUrls.map(async (url) => {
      const dataUri = await fetchImageAsBase64(url);
      return dataUri ? { url, dataUri } : null;
    })
  );
  const valid = downloaded.filter(Boolean);

  if (valid.length === 0) return text; // all downloads failed — send text only

  return [
    { type: 'text', text },
    ...valid.map(({ dataUri }) => ({
      type: 'image_url',
      image_url: { url: dataUri, detail: 'high' },
    })),
  ];
}

const SYSTEM_PROMPT = `\
You are an expert Blender 3D Python API developer with vision capabilities.
Your job is to generate Python code (using the bpy module) that fulfills the user's request.
When the user provides an image URL, you CAN and MUST look at the image to understand
what 3D scene to create. Describe briefly what you see, then generate matching Blender code.

IMPORTANT: The CLI system has ALREADY searched the web and downloaded any needed 3D models,
textures, and HDRIs BEFORE your code runs. They are available in the ASSETS dict.
You do NOT need to download anything at runtime, and you must NEVER say
"I cannot search the web" — the CLI handles all downloading for you.

RESPONSE FORMAT -- you MUST follow this EXACTLY, with no variations:

## REASONING: <one-line summary of what you're doing>
## <more reasoning lines, each starting with "## ">
## <as many lines as needed>
<Python code starts here on the very next line after the last ## line, no blank line in between>

CRITICAL FORMAT RULES:
- Every reasoning line MUST start with "## " (hash hash space)
- The FIRST line of your response must be "## REASONING: ..." 
- Python code starts IMMEDIATELY after the last "## " line — no blank lines, no markdown fences
- Do NOT wrap code in markdown code fences
- Do NOT output any text after the Python code

ALWAYS-AVAILABLE VARIABLES (injected into every execution):
- ASSET_DIR : str  -- absolute path to the root asset library DIRECTORY (not a file!).
    Subfolders: models/ (OBJ/GLTF), textures/ (PNG/JPG), hdris/ (EXR/HDR), blends/ (.blend).
    Use ONLY for building paths: os.path.join(ASSET_DIR, 'models', 'file.obj')
    *** NEVER pass ASSET_DIR directly as a filepath to any import operator ***
- ASSETS : dict    -- pre-downloaded files for THIS request, mapping a descriptive
    key (str) to an absolute file path (str).
    Example: ASSETS = {'bunny_model': '/path/assets/models/stanford_bunny.obj',
                        'wood_texture': '/path/assets/textures/wood_floor_diff_1k.jpg',
                        'sky_hdri': '/path/assets/hdris/sky_1k.exr',
                        'chair_blend': '/path/assets/blends/chair.blend'}
    Use ASSETS.get('key') to safely access. ASSETS may be empty if nothing was downloaded.
- ASSET_PATH : str -- same as ASSET_DIR (backward-compat alias). Treat identically.
- os, math, mathutils are pre-imported -- do NOT import them again.

IMPORTING ASSETS -- use ASSETS['key'] for the file path, NEVER ASSET_DIR as a filepath:
  WRONG:  bpy.ops.wm.obj_import(filepath=ASSET_DIR)   # ← ASSET_DIR is a folder!
  WRONG:  bpy.ops.wm.obj_import(filepath=ASSET_PATH)  # ← same problem

  MODEL IMPORT -- the file could be .blend, .gltf, or .obj depending on what was available.
  ALWAYS use this helper; NEVER hardcode bpy.ops.wm.obj_import or bpy.ops.import_scene.gltf directly:
      def import_model(key):
          fp = ASSETS[key]
          ext = fp.rsplit('.', 1)[-1].lower()
          bpy.ops.object.select_all(action='DESELECT')
          if ext == 'blend':
              with bpy.data.libraries.load(fp, link=False) as (data_from, data_to):
                  data_to.objects = list(data_from.objects)
              for obj in data_to.objects:
                  if obj is not None:
                      bpy.context.scene.collection.objects.link(obj)
                      obj.select_set(True)
          elif ext in ('gltf', 'glb'):
              bpy.ops.import_scene.gltf(filepath=fp)
          else:  # .obj
              bpy.ops.wm.obj_import(filepath=fp)
          return list(bpy.context.selected_objects)
      objs = import_model('tree_model')   # returns list of imported objects
      obj = objs[0] if objs else bpy.context.active_object

  TEXTURE:
      img = bpy.data.images.load(ASSETS['wood_texture'])
      tex_node = mat.node_tree.nodes.new('ShaderNodeTexImage')
      tex_node.image = img
      mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])

  HDRI environment map (sky/background lighting):
      world = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
      bpy.context.scene.world = world
      world.use_nodes = True
      nt = world.node_tree
      nt.nodes.clear()
      bg  = nt.nodes.new('ShaderNodeBackground')
      env = nt.nodes.new('ShaderNodeTexEnvironment')
      out = nt.nodes.new('ShaderNodeOutputWorld')
      env.image = bpy.data.images.load(ASSETS['sky_hdri'])
      nt.links.new(env.outputs['Color'], bg.inputs['Color'])
      nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
      bg.inputs['Strength'].default_value = 1.0

RULES:
1. The global "bpy" is always available. "os", "math", and "mathutils" are also available.
2. Keep code concise and correct. Make reasonable creative choices for ambiguous requests.
3. Your code runs inside a bpy.context.temp_override() targeting the active VIEW_3D area.
   Prefer DIRECT PROPERTY ACCESS over operators for viewport changes:
   - Camera view:       area.spaces[0].region_3d.view_perspective = 'CAMERA'
   - Perspective view:  area.spaces[0].region_3d.view_perspective = 'PERSP'
   - Shading mode:      area.spaces[0].shading.type = 'RENDERED'
   (loop over bpy.context.screen.areas, check area.type == 'VIEW_3D')

4. UNDO / REDO -- require a window-level context, NOT VIEW_3D:
       win = bpy.context.window_manager.windows[0]
       with bpy.context.temp_override(window=win):
           bpy.ops.ed.undo()    # repeat in a loop for multiple undos

5. For all other operations use bpy.ops, bpy.data, bpy.context as normal.

6. BLENDER 4.x ENUM VALUES -- use EXACTLY these strings (wrong values raise errors):

   view_settings.look (color management):
     VALID:   'None'  OR  'AgX - Base Contrast'  OR  'AgX - Punchy'
              Full list: 'AgX - Very Low Contrast', 'AgX - Low Contrast',
              'AgX - Medium Low Contrast', 'AgX - Base Contrast',
              'AgX - Medium High Contrast', 'AgX - High Contrast',
              'AgX - Very High Contrast', 'AgX - Greyscale', 'AgX - Punchy'
     WRONG:   'Medium High Contrast'  ← missing 'AgX - ' prefix!
     SAFE DEFAULT: bpy.context.scene.view_settings.look = 'AgX - Medium High Contrast'

   Principled BSDF inputs (Blender 4.x node names):
     Use 'Specular IOR Level' NOT 'Specular'
     Use 'Coat Weight'        NOT 'Clearcoat'
     Use 'Coat Roughness'     NOT 'Clearcoat Roughness'
     Use 'Emission Color'     NOT 'Emission'   (strength is 'Emission Strength')
     Use 'Sheen Weight'       NOT 'Sheen'

   ParticleSettings (Blender 4.x renamed attributes):
     Use .child_count  NOT .child_nbr
     Use .child_length NOT .child_radius  (hair children length)

   render.engine values: 'CYCLES', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'
     (use 'BLENDER_EEVEE' for all EEVEE — both Blender 3.x and 4.x accept it)

Example -- "place a bunny with wood texture" (ASSETS = {'bunny_model': '...', 'wood_texture': '...'}):
## REASONING: Import the bunny (format unknown, use import_model helper).
## Apply wood texture via Principled BSDF ShaderNodeTexImage node.
def import_model(key):
    fp = ASSETS[key]; ext = fp.rsplit('.', 1)[-1].lower()
    bpy.ops.object.select_all(action='DESELECT')
    if ext == 'blend':
        with bpy.data.libraries.load(fp, link=False) as (df, dt): dt.objects = list(df.objects)
        [bpy.context.scene.collection.objects.link(o) or o.select_set(True) for o in dt.objects if o]
    elif ext in ('gltf', 'glb'): bpy.ops.import_scene.gltf(filepath=fp)
    else: bpy.ops.wm.obj_import(filepath=fp)
    return list(bpy.context.selected_objects)
objs = import_model('bunny_model')
obj = objs[0] if objs else bpy.context.active_object
mat = bpy.data.materials.new(name="Wood")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
img = bpy.data.images.load(ASSETS['wood_texture'])
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = img
mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
if obj.data.materials: obj.data.materials[0] = mat
else: obj.data.materials.append(mat)
`;

/** @type {string|null} Cached model ID for the session. */
let _cachedModel = null;

function getGitHubToken() {
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error('Could not get GitHub token. Run `gh auth login` first.\n' + err.message);
  }
}

function copilotHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': 'vscode/1.90.0',
    'Editor-Plugin-Version': 'copilot-chat/0.15.0',
    'User-Agent': 'blender-cli/2.0',
  };
}

function httpsRequest(options, body = null, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() })
      );
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * SSE-streaming variant of httpsRequest.
 * Calls onToken(text, isThinking) for each content delta.
 *   isThinking=true  → token is from a thinking/reasoning field (not shown as code)
 *   isThinking=false → token is regular text/code content
 * Resolves with { finishReason } when the stream ends.
 */
function streamHttpsRequest(options, body, onToken, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          let detail = Buffer.concat(chunks).toString();
          try { detail = JSON.parse(detail).error?.message ?? detail; } catch (_) {}
          reject(new Error(`Copilot API error ${res.statusCode}: ${detail}`));
        });
        return;
      }
      let partial = '';
      let finishReason = null;
      res.on('data', (chunk) => {
        partial += chunk.toString();
        const lines = partial.split('\n');
        partial = lines.pop(); // keep last incomplete line
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') { resolve({ finishReason }); return; }
          try {
            const data = JSON.parse(raw);
            const choice = data.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;

            // Regular text content
            const content = choice.delta?.content ?? '';
            if (content) onToken(content, false);

            // Thinking / reasoning content — various field names used by different APIs:
            //   delta.thinking            (Anthropic-style via some wrappers)
            //   delta.reasoning           (generic)
            //   delta.reasoning_content   (OpenAI o-series style)
            const thinkingContent =
              choice.delta?.thinking ??
              choice.delta?.reasoning ??
              choice.delta?.reasoning_content ?? '';
            if (thinkingContent) onToken(thinkingContent, true);
          } catch (_) {}
        }
      });
      res.on('end', () => resolve({ finishReason }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Stream timed out after ${timeoutMs / 1000}s`)));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Query GET /models and return the best available chat model ID.
 * Falls back to the first item in MODEL_PRIORITY if the request fails.
 * @returns {Promise<string>}
 */
async function discoverModel() {
  if (_cachedModel) return _cachedModel;

  const token = getGitHubToken();
  try {
    const { statusCode, body } = await httpsRequest({
      hostname: COPILOT_ENDPOINT,
      path: '/models',
      method: 'GET',
      headers: copilotHeaders(token),
    });

    if (statusCode === 200) {
      const data = JSON.parse(body);
      const available = (data.data || [])
        .filter((m) => m.capabilities?.type === 'chat')
        .map((m) => m.id);

      for (const preferred of MODEL_PRIORITY) {
        const found =
          available.find((a) => a === preferred) ||
          available.find((a) => a.startsWith(preferred + '-'));
        if (found) {
          _cachedModel = found;
          return _cachedModel;
        }
      }
      if (available.length > 0) {
        _cachedModel = available[0];
        return _cachedModel;
      }
    }
  } catch (_) { /* fall through to hardcoded default */ }

  _cachedModel = MODEL_PRIORITY[0];
  return _cachedModel;
}

function stripCodeFences(text) {
  return text
    .replace(/^```(?:python)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Parse a model response.
 * Primary format:  leading lines starting with "## " are reasoning, rest is code.
 * Fallback format: legacy <thinking>...</thinking> XML tags.
 * @param {string} raw
 * @returns {{ thinking: string|null, code: string }}
 */
function parseResponse(raw) {
  // Primary: "## " prefix lines at the top
  const lines = raw.split('\n');
  const reasoningLines = [];
  let codeStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      reasoningLines.push(lines[i].slice(3)); // strip "## " prefix
      codeStart = i + 1;
    } else if (i === 0 && lines[i].trim() === '') {
      codeStart = 1; // skip optional leading blank line
    } else {
      break;
    }
  }
  if (reasoningLines.length > 0) {
    return {
      thinking: reasoningLines.join('\n').trim() || null,
      code: stripCodeFences(lines.slice(codeStart).join('\n').trim()),
    };
  }

  // Fallback: legacy <thinking>...</thinking> tags
  const match = raw.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (!match) return { thinking: null, code: stripCodeFences(raw.trim()) };
  const thinking = match[1].trim();
  const code = stripCodeFences(raw.slice(match.index + match[0].length).trim());
  return { thinking, code };
}

/**
 * Ask Copilot to list all 3D assets (models + textures) needed for the prompt.
 * Returns an array of {type, query, key} items to pass to downloadAssets().
 * @param {string} userPrompt
 * @returns {Promise<Array<{type: 'model'|'texture'|'hdri'|'blend', query: string, key: string}>>}
 */
async function planAssets(userPrompt) {
  const token = getGitHubToken();
  const model = await discoverModel();

  const messages = [
    {
      role: 'system',
      content:
        'You are a 3D asset detector. Analyze the Blender scene request and respond ONLY with valid JSON ' +
        '(no markdown, no prose).\n' +
        'Format: {"assets": [{"type": "model"|"texture"|"hdri"|"blend", "query": "<search term>", "key": "<snake_case_id>"}]}\n\n' +
        'Asset types:\n' +
        '- type="model" : any specific named 3D mesh/scan NOT a Blender primitive.\n' +
        '  Includes: Stanford meshes (armadillo, bunny, dragon, lucy, buddha),\n' +
        '  Utah/Newell teapot, spot (cow), any named real-world scan, any .obj/.gltf request.\n' +
        '  query: canonical name ("stanford armadillo", "utah teapot", "stanford bunny").\n' +
        '- type="texture" : real-world PBR surface texture ("oak wood floor", "brick wall",\n' +
        '  "marble", "concrete", "metal"). Use when photo-realistic surface is clearly needed.\n' +
        '- type="hdri" : environment/sky/background lighting map. Use for outdoor scenes,\n' +
        '  realistic sky, studio lighting, or when the user mentions sky/environment/HDRI/backdrop.\n' +
        '  query: describe the environment ("sunny sky", "studio lighting", "forest", "sunset", "night city").\n' +
        '- type="blend" : native .blend scene/object file. Use ONLY when user explicitly asks for a\n' +
        '  Blender file or requests a complex pre-built 3D asset best served as a .blend.\n' +
        '- key: short snake_case id ("armadillo_model", "wood_texture", "sky_hdri", "chair_blend").\n' +
        '- Do NOT include Blender primitives (cube, sphere, cylinder, torus, cone, monkey/Suzanne).\n' +
        '- If nothing needs downloading, return {"assets": []}.\n\n' +
        'Examples:\n' +
        '  "Stanford armadillo on a marble floor with sunny sky" ->\n' +
        '    {"assets": [{"type": "model", "query": "stanford armadillo", "key": "armadillo_model"},\n' +
        '                {"type": "texture", "query": "marble", "key": "marble_texture"},\n' +
        '                {"type": "hdri", "query": "sunny sky", "key": "sky_hdri"}]}\n' +
        '  "Place a teapot and a bunny on a wood floor" ->\n' +
        '    {"assets": [{"type": "model", "query": "utah teapot", "key": "teapot_model"},\n' +
        '                {"type": "model", "query": "stanford bunny", "key": "bunny_model"},\n' +
        '                {"type": "texture", "query": "wood floor", "key": "wood_texture"}]}\n' +
        '  "Add a red cube" -> {"assets": []}',
    },
    { role: 'user', content: await buildUserContent(userPrompt) },
  ];
  const payload = JSON.stringify({ model, messages, max_tokens: 300, temperature: 0 });
  const headers = { ...copilotHeaders(token), 'Content-Length': Buffer.byteLength(payload) };

  try {
    const { statusCode, body } = await httpsRequest(
      { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers },
      payload,
      20_000,
    );
    if (statusCode !== 200) return [];
    const data = JSON.parse(body);
    const raw = (data.choices?.[0]?.message?.content ?? '{}')
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.assets) ? parsed.assets : [];
  } catch { return []; }
}

/**
 * Ask Copilot to suggest specific direct download URLs for free 3D assets.
 * This enriches the asset list returned by planAssets() with concrete URLs
 * that the CLI can download directly — no API key required.
 *
 * Returns a new array with `url` fields added where found.
 * Items that couldn't be matched keep their original form (no url field).
 *
 * @param {string} userPrompt
 * @param {Array<{type: string, query: string, key: string}>} assetList
 * @returns {Promise<Array<{type: string, query: string, key: string, url?: string}>>}
 */
async function searchWebAssets(userPrompt, assetList) {
  if (assetList.length === 0) return assetList;
  const token = getGitHubToken();
  const model = await discoverModel();

  const assetJson = JSON.stringify(assetList, null, 2);

  const messages = [
    {
      role: 'system',
      content:
        'You are a 3D asset URL finder. Given a list of needed assets, provide direct download URLs ' +
        'from free, CC0-licensed repositories. Respond ONLY with valid JSON — no prose, no markdown.\n\n' +
        'Output format: {"assets": [{"key": "...", "url": "https://...direct-download-url..."}]}\n' +
        'Only include entries where you are confident the URL is valid and the file is freely downloadable.\n' +
        'Omit any asset if you are unsure. Do NOT invent URLs.\n\n' +
        'KNOWN FREE REPOSITORIES — use these patterns:\n\n' +
        'POLY HAVEN (polyhaven.com, CC0):\n' +
        '  Models blend: https://dl.polyhaven.org/file/ph-assets/Models/{id}/{id}_1k.blend\n' +
        '  HDRIs EXR:    https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/1k/{id}_1k.exr\n' +
        '  Texture diff: https://dl.polyhaven.org/file/ph-assets/Textures/{id}/1k/{id}_diff_1k.jpg\n' +
        '  Known HDRI IDs: studio_small_09, kloofendal_48d_partly_cloudy, sunset_jhbcentral,\n' +
        '    industrial_sunset_02, sunset_in_the_chalk_quarry, sunflowers, kiara_1_dawn,\n' +
        '    forest_slope, urban_street_02, belfast_sunset, golden_bay, meadow_2\n' +
        '  Known model IDs: rubber_duck, tin_cup, coffee_mug, round_wooden_table, \n' +
        '    old_wooden_chair, potted_plant_02, beer_bottle, wine_bottle, ceramic_vase_01\n\n' +
        'KHRONOS GLTF SAMPLE MODELS (github.com/KhronosGroup/glTF-Sample-Models, CC license):\n' +
        '  URL pattern: https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/{Name}/glTF/{Name}.gltf\n' +
        '  Available (exact name required): Box, Duck, BrainStem, CesiumMilkTruck, Fox, Avocado,\n' +
        '    Buggy, BarramundiFish, Corset, DamagedHelmet, FlightHelmet, Lantern, MetalRoughSpheres,\n' +
        '    SciFiHelmet, Sponza, ToyCar, WaterBottle, AntiqueCamera, DragonAttenuation\n\n' +
        'COMMON 3D TEST MODELS (github.com/alecjacobson/common-3d-test-models, free):\n' +
        '  URL pattern: https://raw.githubusercontent.com/alecjacobson/common-3d-test-models/master/data/{name}.obj\n' +
        '  Available: teapot, stanford-bunny, xyzrgb_dragon, armadillo, lucy, spot, bob, fertility,\n' +
        '    horse, camel, elephant, cow, cheburashka, suzanne, woody\n\n' +
        'AMBIENT CG (ambientcg.com, CC0 PBR textures):\n' +
        '  URL pattern: https://ambientcg.com/get?file={Id}_1K-JPG.zip  (zip containing textures)\n' +
        '  Many IDs available: Bricks001..Bricks079, Concrete001..Concrete065, Metal001..Metal090,\n' +
        '    Wood001..Wood094, Ground001..Ground075, Fabric001..Fabric099, Tiles001..Tiles139,\n' +
        '    Leather001..Leather032, Grass001..Grass010, Rock001..Rock054, Plaster001..Plaster022\n',
    },
    {
      role: 'user',
      content:
        `Scene request: "${userPrompt}"\n\nAssets needed:\n${assetJson}\n\n` +
        'For each asset, provide a direct download URL if you know a good free source. ' +
        'Return JSON with only the assets you found URLs for.',
    },
  ];

  try {
    const payload = JSON.stringify({ model, messages, max_tokens: 600, temperature: 0 });
    const headers = { ...copilotHeaders(token), 'Content-Length': Buffer.byteLength(payload) };
    const { statusCode, body } = await httpsRequest(
      { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers },
      payload, 20_000,
    );
    if (statusCode !== 200) return assetList;
    const raw = (JSON.parse(body).choices?.[0]?.message?.content ?? '{}')
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const found = JSON.parse(raw);
    const urlMap = {};
    for (const item of (found.assets ?? [])) {
      if (item.key && item.url) urlMap[item.key] = item.url;
    }
    // Merge URLs back into the original asset list
    return assetList.map((a) => urlMap[a.key] ? { ...a, url: urlMap[a.key] } : a);
  } catch { return assetList; }
}


/**
 * Generate Blender Python code with reasoning from a natural language prompt.
 * @param {string} userPromptuserPrompt, history = [], opts = {}) {
  const token = getGitHubToken();
  const model = await discoverModel();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const { prompt, code } of history) {
    messages.push({ role: 'user', content: prompt });
    messages.push({ role: 'assistant', content: code });
  }

  let userContent = userPrompt;
  if (opts.assetDict && Object.keys(opts.assetDict).length > 0) {
    const listing = Object.entries(opts.assetDict)
      .map(([k, v]) => `  '${k}': r'${v.replace(/\\/g, '/')}'`)
      .join(',\n');
    userContent =
      `[PRE-DOWNLOADED ASSETS — use these via the ASSETS dict:\n${listing}\n]\n` +
      userPrompt;
  }
  // Wrap with image URLs if present (multimodal content)
  messages.push({ role: 'user', content: await buildUserContent(userContent) });

  // Fetch with automatic continuation if the response is truncated (finish_reason='length').
  let fullRaw = '';
  const MAX_CONTINUATIONS = 3;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const payload = JSON.stringify({ model, messages, max_tokens: 8192, temperature: 0.2 });
    const headers = { ...copilotHeaders(token), 'Content-Length': Buffer.byteLength(payload) };

    const { statusCode, body } = await httpsRequest(
      { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers },
      payload,
    );

    if (statusCode !== 200) {
      let detail = body;
      try { detail = JSON.parse(body).error?.message ?? body; } catch (_) {}
      throw new Error(`Copilot API error ${statusCode}: ${detail}`);
    }

    const data = JSON.parse(body);
    const choice = data.choices?.[0] ?? {};
    const chunk = choice.message?.content ?? '';
    fullRaw += chunk;

    // If not truncated, we're done.
    if (choice.finish_reason !== 'length') break;

    // Truncated — ask the model to continue from where it left off.
    messages.push({ role: 'assistant', content: chunk });
    messages.push({ role: 'user', content: 'Continue exactly where you left off. Output only the remaining Python code, no preamble.' });
  }

  return parseResponse(fullRaw);
}

/**
 * Generate Blender Python code from a natural language prompt (returns code string only).
 * @param {string} userPrompt
 * @param {Array<{prompt: string, code: string}>} history
 * @returns {Promise<string>} Python code
 */
async function getCopilotCode(userPrompt, history = []) {
  const { code } = await getCopilotResponse(userPrompt, history);
  return code;
}

/**
 * Streaming version of getCopilotResponse.
 *
 * Streams the model output and calls callbacks as tokens arrive so thinking
 * can be displayed in real-time on the CLI.
 *
 * @param {string} userPrompt
 * @param {Array<{prompt: string, code: string}>} history
 * @param {{assetDict?: Record<string, string>}} [opts]
 * @param {{
 *   onThinkingStart?: () => void,
 *   onThinkingLine?: (line: string) => void,
 *   onThinkingEnd?: () => void,
 * }} [callbacks]
 * @returns {Promise<{thinking: string|null, code: string}>}
 */
async function getCopilotResponseStream(userPrompt, history = [], opts = {}, callbacks = {}) {
  const token = getGitHubToken();
  const model = await discoverModel();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const { prompt, code } of history) {
    messages.push({ role: 'user', content: prompt });
    messages.push({ role: 'assistant', content: code });
  }

  let userContent = userPrompt;
  if (opts.assetDict && Object.keys(opts.assetDict).length > 0) {
    const listing = Object.entries(opts.assetDict)
      .map(([k, v]) => `  '${k}': r'${v.replace(/\\/g, '/')}'`)
      .join(',\n');
    userContent =
      `[PRE-DOWNLOADED ASSETS — use these via the ASSETS dict:\n${listing}\n]\n` +
      userPrompt;
  }
  messages.push({ role: 'user', content: await buildUserContent(userContent) });

  // --- Streaming state machine ---
  // The response format uses "## " prefix lines for reasoning, then raw Python code.
  // We also handle:
  //   Path A: API native thinking fields (delta.thinking / delta.reasoning_content)
  //   Path B: legacy <thinking> XML tags embedded in delta.content
  //
  // Phase: 'reasoning' = still reading "## " lines | 'code' = reading Python code
  let lineBuffer = '';
  let fullRaw = '';
  let thinkingStarted = false;
  let thinkingEnded = false;
  let thinkingLines = [];
  let codeBuffer = '';

  const emitThinkingLine = (line) => {
    if (!thinkingStarted) {
      thinkingStarted = true;
      callbacks.onThinkingStart?.();
    }
    thinkingLines.push(line);
    callbacks.onThinkingLine?.(line);
  };

  // Process one complete line of text content.
  const processLine = (line) => {
    if (!thinkingEnded) {
      // "## " prefix → reasoning line
      if (line.startsWith('## ')) {
        emitThinkingLine(line.slice(3));
        return;
      }
      // Blank line before any reasoning started → skip
      if (!thinkingStarted && line.trim() === '') return;
      // First non-"## " line after reasoning started → switch to code
      if (thinkingStarted) {
        thinkingEnded = true;
        callbacks.onThinkingEnd?.();
        // This line is code (fall through)
      }
      // Legacy: <thinking> tag embedded in text
      if (!thinkingStarted && line.includes('<thinking>')) {
        const rest = line.slice(line.indexOf('<thinking>') + '<thinking>'.length);
        if (rest.trim()) emitThinkingLine(rest.trim());
        return;
      }
      if (thinkingStarted && !thinkingEnded && line.includes('</thinking>')) {
        thinkingEnded = true;
        callbacks.onThinkingEnd?.();
        const after = line.slice(line.indexOf('</thinking>') + '</thinking>'.length).trim();
        if (after) codeBuffer += after + '\n';
        return;
      }
    }
    codeBuffer += line + '\n';
  };

  // Path A: native thinking field from the API (delta.thinking etc.)
  let nativeThinkingBuffer = '';
  const processNativeThinking = (text) => {
    nativeThinkingBuffer += text;
    let nl;
    while ((nl = nativeThinkingBuffer.indexOf('\n')) !== -1) {
      emitThinkingLine(nativeThinkingBuffer.slice(0, nl));
      nativeThinkingBuffer = nativeThinkingBuffer.slice(nl + 1);
    }
  };

  const processToken = (tokenText, isThinking) => {
    if (isThinking) {
      processNativeThinking(tokenText);
      return;
    }
    fullRaw += tokenText;
    lineBuffer += tokenText;
    let nl;
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      processLine(lineBuffer.slice(0, nl));
      lineBuffer = lineBuffer.slice(nl + 1);
    }
  };

  const payload = JSON.stringify({ model, messages, max_tokens: 8192, temperature: 0.2, stream: true });
  const headers = {
    ...copilotHeaders(token),
    'Content-Length': Buffer.byteLength(payload),
  };

  const { finishReason } = await streamHttpsRequest(
    { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers },
    payload,
    processToken,
    120_000,
  );

  // Flush remaining partial lines
  if (nativeThinkingBuffer) { emitThinkingLine(nativeThinkingBuffer); nativeThinkingBuffer = ''; }
  if (lineBuffer) { processLine(lineBuffer); lineBuffer = ''; }
  if (thinkingStarted && !thinkingEnded) {
    thinkingEnded = true;
    callbacks.onThinkingEnd?.();
  }

  // If the model was cut off, do a non-streaming continuation
  if (finishReason === 'length') {
    messages.push({ role: 'assistant', content: fullRaw });
    messages.push({
      role: 'user',
      content: 'Continue exactly where you left off. Output only the remaining Python code, no preamble.',
    });
    const contPayload = JSON.stringify({ model, messages, max_tokens: 8192, temperature: 0.2 });
    const contHeaders = { ...copilotHeaders(token), 'Content-Length': Buffer.byteLength(contPayload) };
    const { statusCode, body } = await httpsRequest(
      { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers: contHeaders },
      contPayload,
    );
    if (statusCode === 200) {
      const cont = JSON.parse(body).choices?.[0]?.message?.content ?? '';
      codeBuffer += cont;
    }
  }

  // If no streaming reasoning was captured, fall back to parseResponse on full text
  if (!thinkingStarted) {
    return parseResponse(fullRaw);
  }

  const thinking = thinkingLines.join('\n').trim() || null;
  const code = stripCodeFences(codeBuffer.trim());
  return { thinking, code };
}

/** Reset cached model (useful for testing). */
function resetModelCache() { _cachedModel = null; }

module.exports = { getCopilotCode, getCopilotResponse, getCopilotResponseStream, planAssets, searchWebAssets, discoverModel, resetModelCache };
