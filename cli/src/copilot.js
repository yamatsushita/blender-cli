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

const SYSTEM_PROMPT = `\
You are an expert Blender 3D Python API developer.
Your job is to generate Python code (using the bpy module) that fulfills the user's request.

RESPONSE FORMAT -- you MUST follow this exactly, no exceptions:
<thinking>
Explain step-by-step: what the user wants, which Blender API calls to use, any special
considerations (e.g. how to use pre-downloaded assets, complex node setups, context requirements).
</thinking>
<Python code here -- no fences, no other text, starts immediately after </thinking>>

ALWAYS-AVAILABLE VARIABLES (injected into every execution):
- ASSET_DIR : str  -- absolute path to the root asset library DIRECTORY (not a file!).
    Contains subfolders: models/ (OBJ/GLTF meshes) and textures/ (PNG/JPG maps).
    Use ONLY for building paths manually: os.path.join(ASSET_DIR, 'models', 'file.obj')
    *** NEVER pass ASSET_DIR directly as a filepath to obj_import or any import operator ***
- ASSETS : dict    -- pre-downloaded files for THIS request, mapping a descriptive
    key (str) to an absolute file path (str).
    Example: ASSETS = {'bunny_model': '/path/assets/models/stanford_bunny.obj',
                        'wood_texture': '/path/assets/textures/wood_floor_diff_1k.jpg'}
    Use ASSETS.get('key') to safely access. ASSETS may be empty if nothing was downloaded.
- ASSET_PATH : str -- same as ASSET_DIR (backward-compat alias). Treat identically.

IMPORTING ASSETS -- use ASSETS['key'] for the file path, never ASSET_DIR:
  WRONG:  bpy.ops.wm.obj_import(filepath=ASSET_DIR)   # ← ASSET_DIR is a folder, not a file!
  WRONG:  bpy.ops.wm.obj_import(filepath=ASSET_PATH)  # ← same problem
  CORRECT OBJ:  bpy.ops.wm.obj_import(filepath=ASSETS['bunny_model'])
  CORRECT GLTF: bpy.ops.import_scene.gltf(filepath=ASSETS['some_model'])
  CORRECT TEX:
      img = bpy.data.images.load(ASSETS['wood_texture'])
      tex_node = mat.node_tree.nodes.new('ShaderNodeTexImage')
      tex_node.image = img
      mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])

RULES:
1. The global "bpy" is always available. "os" and "math" are also available.
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
ASSETS has bunny_model (OBJ path) and wood_texture (image path).
I import the OBJ using ASSETS['bunny_model'], create a Principled BSDF material,
load the texture from ASSETS['wood_texture'], wire it to Base Color.
</thinking>
bpy.ops.wm.obj_import(filepath=ASSETS['bunny_model'])
obj = bpy.context.active_object
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
 * @returns {Promise<Array<{type: 'model'|'texture', query: string, key: string}>>}
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
        'Format: {"assets": [{"type": "model"|"texture", "query": "<search term>", "key": "<snake_case_id>"}]}\n\n' +
        'Rules:\n' +
        '- Include type="model" for any specific named 3D mesh or scan that is NOT a Blender primitive.\n' +
        '  This includes: Stanford meshes (armadillo, bunny, dragon, lucy, buddha, happy buddha,\n' +
        '  xyzrgb dragon), Utah/Stanford/Newell teapot, spot (cow model), any named real-world scan,\n' +
        '  or any 3D object the user describes as needing a download / .obj / .gltf file.\n' +
        '  Also include if the user references a URL that points to a 3D scan image or dataset.\n' +
        '  query: use the canonical name (e.g. "stanford armadillo", "utah teapot", "stanford bunny").\n' +
        '- Include type="texture" for specific real-world surface textures (e.g. "oak wood floor",\n' +
        '  "brick wall", "marble", "concrete"). Include when photo-realistic texture is clearly requested.\n' +
        '- key: short snake_case identifier (e.g. "armadillo_model", "teapot_model", "wood_texture").\n' +
        '- Do NOT include standard Blender primitives (cube, sphere, cylinder, torus, cone, monkey/Suzanne,\n' +
        '  text, curve, light, camera) — Blender creates those natively.\n' +
        '- If nothing needs downloading, return {"assets": []}.\n\n' +
        'Examples:\n' +
        '  "Create a scene with the Stanford armadillo" ->\n' +
        '    {"assets": [{"type": "model", "query": "stanford armadillo", "key": "armadillo_model"}]}\n' +
        '  "Place a teapot and a bunny on a wood floor" ->\n' +
        '    {"assets": [{"type": "model", "query": "utah teapot", "key": "teapot_model"},\n' +
        '                {"type": "model", "query": "stanford bunny", "key": "bunny_model"},\n' +
        '                {"type": "texture", "query": "wood floor", "key": "wood_texture"}]}\n' +
        '  "Add a red cube" -> {"assets": []}',
    },
    { role: 'user', content: userPrompt },
  ];

  const payload = JSON.stringify({ model, messages, max_tokens: 200, temperature: 0 });
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
  messages.push({ role: 'user', content: userContent });

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

/** Reset cached model (useful for testing). */
function resetModelCache() { _cachedModel = null; }

module.exports = { getCopilotCode, getCopilotResponse, planAssets, discoverModel, resetModelCache };
