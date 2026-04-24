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

RESPONSE FORMAT -- you MUST follow this exactly, no exceptions:
<thinking>
Explain step-by-step: what the user wants, which Blender API calls to use, any special
considerations (e.g. how to use pre-downloaded assets, complex node setups, context requirements).
</thinking>
<Python code here -- no fences, no other text, starts immediately after </thinking>>

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

Example -- "place a bunny with wood texture" (ASSETS = {'bunny_model': '...', 'wood_texture': '...'}):
<thinking>
ASSETS has bunny_model (could be .blend/.obj/.gltf) and wood_texture (image path).
Use import_model() helper to handle any format, then apply the texture material.
</thinking>
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
 * Calls onToken(text) for each content delta.
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
            const content = choice?.delta?.content ?? '';
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (content) onToken(content);
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
 * Parse a model response that may contain <thinking>...</thinking> before code.
 * @param {string} raw
 * @returns {{ thinking: string|null, code: string }}
 */
function parseResponse(raw) {
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
 * Generate Blender Python code with reasoning from a natural language prompt.
 * @param {string} userPrompt
 * @param {Array<{prompt: string, code: string}>} history
 * @param {{assetDict?: Record<string, string>}} [opts]
 * @returns {Promise<{thinking: string|null, code: string}>}
 */
async function getCopilotResponse(userPrompt, history = [], opts = {}) {
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

  // --- Line-buffered streaming state machine ---
  // Phase transitions:
  //   'pre'      → waiting for <thinking> opening tag
  //   'thinking' → inside thinking block, emit lines live via callbacks
  //   'code'     → after </thinking>, buffer the Python code
  let lineBuffer = '';
  let fullRaw = '';
  let phase = 'pre';
  let thinkingLines = [];
  let codeBuffer = '';
  let thinkingStarted = false;

  const processToken = (tokenText) => {
    fullRaw += tokenText;
    lineBuffer += tokenText;

    // Process every complete line (split on \n)
    let nl;
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, nl);
      lineBuffer = lineBuffer.slice(nl + 1);

      if (phase === 'pre') {
        if (line.trim() === '<thinking>') {
          phase = 'thinking';
          if (!thinkingStarted) {
            thinkingStarted = true;
            callbacks.onThinkingStart?.();
          }
        }
        // pre lines (before <thinking>) are not emitted
      } else if (phase === 'thinking') {
        if (line.trim() === '</thinking>') {
          phase = 'code';
          callbacks.onThinkingEnd?.();
        } else {
          thinkingLines.push(line);
          callbacks.onThinkingLine?.(line);
        }
      } else {
        // phase === 'code'
        codeBuffer += line + '\n';
      }
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

  // Flush any remaining lineBuffer content
  if (lineBuffer) {
    if (phase === 'code') {
      codeBuffer += lineBuffer;
    } else if (phase === 'thinking') {
      thinkingLines.push(lineBuffer);
      callbacks.onThinkingLine?.(lineBuffer);
    }
    lineBuffer = '';
  }

  // If the model was cut off, do a non-streaming continuation
  if (finishReason === 'length') {
    messages.push({ role: 'assistant', content: fullRaw });
    messages.push({
      role: 'user',
      content: 'Continue exactly where you left off. Output only the remaining Python code, no preamble.',
    });
    // Non-streaming continuation
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

  // If the response had no <thinking> block, fall back to parsing the raw output
  if (phase === 'pre' || (phase === 'thinking' && thinkingLines.length === 0)) {
    return parseResponse(fullRaw);
  }

  const thinking = thinkingLines.join('\n').trim() || null;
  const code = stripCodeFences(codeBuffer.trim());
  return { thinking, code };
}

/** Reset cached model (useful for testing). */
function resetModelCache() { _cachedModel = null; }

module.exports = { getCopilotCode, getCopilotResponse, getCopilotResponseStream, planAssets, discoverModel, resetModelCache };
