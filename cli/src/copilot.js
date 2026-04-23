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

RESPONSE FORMAT — you MUST follow this exactly, no exceptions:
<thinking>
Explain step-by-step: what the user wants, which Blender API calls to use, any special
considerations (e.g. external assets, complex node setups, context requirements).
</thinking>
<Python code here — no fences, no other text, starts immediately after </thinking>>

RULES:
1. The global "bpy" is always available — do not re-import unless needed.
2. Keep code concise and correct. Make reasonable creative choices for ambiguous requests.
3. Your code runs inside a bpy.context.temp_override() targeting the active VIEW_3D
   area, so most viewport operators work. However, prefer DIRECT PROPERTY ACCESS over
   operators for viewport and perspective changes:

   - Camera view:       area.spaces[0].region_3d.view_perspective = 'CAMERA'
   - Perspective view:  area.spaces[0].region_3d.view_perspective = 'PERSP'
   - Orthographic view: area.spaces[0].region_3d.view_perspective = 'ORTHO'
   - Shading mode:      area.spaces[0].shading.type = 'RENDERED'
   (loop over bpy.context.screen.areas, check area.type == 'VIEW_3D')

4. UNDO / REDO — require a window-level context, NOT VIEW_3D. Use this exact pattern:
       win = bpy.context.window_manager.windows[0]
       with bpy.context.temp_override(window=win):
           bpy.ops.ed.undo()    # or bpy.ops.ed.redo()
   To undo N steps, loop N times (one bpy.ops.ed.undo() per iteration).

5. IMPORTING EXTERNAL ASSETS — if the variable ASSET_PATH is defined in the namespace,
   an external 3D model has been pre-downloaded. Import it with the appropriate operator:
   - .obj file:      bpy.ops.wm.obj_import(filepath=ASSET_PATH)
   - .gltf/.glb:    bpy.ops.import_scene.gltf(filepath=ASSET_PATH)
   After import, the newly added object(s) are active/selected. Apply transforms/
   materials as needed. Do NOT attempt to download files yourself.

6. For all other operations use bpy.ops, bpy.data, bpy.context as normal.

Example — "undo 3 times":
<thinking>
The user wants to undo 3 times. undo/redo require a window context, not VIEW_3D.
I'll loop 3 times, each time using temp_override(window=win).
</thinking>
win = bpy.context.window_manager.windows[0]
for _ in range(3):
    with bpy.context.temp_override(window=win):
        bpy.ops.ed.undo()

Example — "add a red cube at the origin":
<thinking>
The user wants a red cube. I'll use primitive_cube_add, then create a Principled BSDF
material with red base color and attach it.
</thinking>
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
obj = bpy.context.active_object
mat = bpy.data.materials.new(name="Red")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs['Base Color'].default_value = (1, 0, 0, 1)
obj.data.materials.append(mat)
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
 * Ask Copilot whether this prompt requires downloading an external 3D model.
 * Returns { needsAsset: bool, query: string }.
 * @param {string} userPrompt
 * @returns {Promise<{needsAsset: boolean, query: string}>}
 */
async function planAssetDownload(userPrompt) {
  const token = getGitHubToken();
  const model = await discoverModel();

  const messages = [
    {
      role: 'system',
      content:
        'You are a 3D asset detector. Analyze the Blender scene request and respond ONLY with valid JSON ' +
        '(no markdown, no prose, no explanation).\n' +
        'Format: {"needs_asset": <bool>, "query": "<search query for the 3D model file, or empty string>"}\n' +
        'Set needs_asset=true ONLY if the request asks for a specific real-world or named 3D model that ' +
        'is not built into Blender (e.g. "Stanford teapot", "Stanford bunny", "Utah teapot", a named scan, ' +
        'a named famous test model). ' +
        'Set needs_asset=false for anything Blender can create natively (cube, sphere, cylinder, torus, ' +
        'cone, monkey/Suzanne, text, curve, light, camera, etc.).',
    },
    { role: 'user', content: userPrompt },
  ];

  const payload = JSON.stringify({ model, messages, max_tokens: 80, temperature: 0 });
  const headers = { ...copilotHeaders(token), 'Content-Length': Buffer.byteLength(payload) };

  try {
    const { statusCode, body } = await httpsRequest(
      { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers },
      payload,
      20_000,
    );
    if (statusCode !== 200) return { needsAsset: false, query: '' };
    const data = JSON.parse(body);
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
    return { needsAsset: Boolean(parsed.needs_asset), query: parsed.query ?? '' };
  } catch { return { needsAsset: false, query: '' }; }
}

/**
 * Generate Blender Python code with reasoning from a natural language prompt.
 * @param {string} userPrompt
 * @param {Array<{prompt: string, code: string}>} history
 * @param {{assetPath?: string, assetFormat?: string}} [opts]
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
  if (opts.assetPath) {
    const fwdPath = opts.assetPath.replace(/\\/g, '/');
    userContent =
      `[ASSET PRE-DOWNLOADED: ASSET_PATH = '${fwdPath}', format: ${opts.assetFormat ?? 'obj'}]\n` +
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

module.exports = { getCopilotCode, getCopilotResponse, planAssetDownload, discoverModel, resetModelCache };
