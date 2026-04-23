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
Generate Python code using the bpy module that fulfills the user's request.

RULES:
1. Output ONLY valid executable Python code. No markdown fences, no prose.
2. The global "bpy" is always available — do not re-import unless needed.
3. Use bpy.ops, bpy.data, bpy.context as appropriate.
4. Keep code concise and correct. Make reasonable creative choices for ambiguous requests.
5. Your code runs inside a bpy.context.temp_override() that targets the active
   VIEW_3D area, so viewport operators (view3d.view_camera, view3d.view_axis,
   view3d.zoom, etc.) work without any additional context setup in your code.
   Never add your own context override for VIEW_3D operators — it is already done.
6. For non-viewport operators that need a specific context (e.g. node editor),
   you may still use bpy.context.temp_override() as needed.

Example – "switch to camera view":
bpy.ops.view3d.view_camera()

Example – "add a red cube at the origin":
import bpy
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
obj = bpy.context.active_object
mat = bpy.data.materials.new(name="Red")
mat.diffuse_color = (1, 0, 0, 1)
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
    'User-Agent': 'blender-copilot-cli/2.0',
  };
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() })
      );
    });
    req.on('error', reject);
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
      // Only consider chat-capable models
      const available = (data.data || [])
        .filter((m) => m.capabilities?.type === 'chat')
        .map((m) => m.id);

      for (const preferred of MODEL_PRIORITY) {
        // Exact match first; then prefix match (e.g. "gpt-4.1-2025-04-14" for "gpt-4.1")
        const found =
          available.find((a) => a === preferred) ||
          available.find((a) => a.startsWith(preferred + '-'));
        if (found) {
          _cachedModel = found;
          return _cachedModel;
        }
      }
      // No preferred model found — take the first chat model
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
 * Generate Blender Python code from a natural language prompt.
 * @param {string} userPrompt
 * @param {Array<{prompt: string, code: string}>} history
 * @returns {Promise<string>} Python code
 */
async function getCopilotCode(userPrompt, history = []) {
  const token = getGitHubToken();
  const model = await discoverModel();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const { prompt, code } of history) {
    messages.push({ role: 'user', content: prompt });
    messages.push({ role: 'assistant', content: code });
  }
  messages.push({ role: 'user', content: userPrompt });

  const payload = JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0.2 });
  const headers = { ...copilotHeaders(token), 'Content-Length': Buffer.byteLength(payload) };

  const { statusCode, body } = await httpsRequest(
    { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers },
    payload
  );

  if (statusCode !== 200) {
    let detail = body;
    try { detail = JSON.parse(body).error?.message ?? body; } catch (_) {}
    throw new Error(`Copilot API error ${statusCode}: ${detail}`);
  }

  const data = JSON.parse(body);
  const raw = data.choices?.[0]?.message?.content ?? '';
  return stripCodeFences(raw.trim());
}

/** Reset cached model (useful for testing). */
function resetModelCache() { _cachedModel = null; }

module.exports = { getCopilotCode, discoverModel, resetModelCache };
