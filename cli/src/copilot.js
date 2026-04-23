'use strict';

/**
 * GitHub Copilot API client.
 *
 * Authentication: we call `gh auth token` to obtain the current user's token,
 * then use it against the Copilot chat completions endpoint.
 *
 * The system prompt is carefully crafted so the model always returns
 * *only* Python code that can be exec()'d inside Blender (no markdown fences,
 * no prose).
 */

const { execSync } = require('child_process');
const https = require('https');

const COPILOT_ENDPOINT = 'api.githubcopilot.com';
const COPILOT_PATH = '/chat/completions';

const SYSTEM_PROMPT = `\
You are an expert Blender 3D Python API developer.
Your job is to generate Python code using the bpy module that fulfills the user's natural language request.

STRICT RULES:
1. Output ONLY valid, executable Python code. No markdown code fences, no explanations, no comments unless clarifying.
2. Always import bpy at the top if not already imported (it is always available as a global in Blender).
3. Use bpy.ops, bpy.data, bpy.context as needed.
4. When creating objects, deselect all first, then select the new object.
5. When modifying materials, check if they exist before creating new ones.
6. Keep code concise — prefer bpy.ops for common tasks.
7. If the request is ambiguous, make a reasonable creative choice.

Example – "add a red cube at the origin":
import bpy
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
obj = bpy.context.active_object
mat = bpy.data.materials.new(name="Red")
mat.diffuse_color = (1, 0, 0, 1)
obj.data.materials.append(mat)
`;

/**
 * Retrieve GitHub token via the `gh` CLI.
 * @returns {string}
 */
function getGitHubToken() {
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(
      'Could not get GitHub token. Make sure you are logged in with `gh auth login`.\n' +
      err.message
    );
  }
}

/**
 * Make an HTTPS request and return the response body as a string.
 * @param {object} options - Node https.request options
 * @param {string|null} body - request body
 * @returns {Promise<{statusCode: number, body: string}>}
 */
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
 * Call the GitHub Copilot chat completions API and return the generated Python code.
 * @param {string} userPrompt
 * @param {string[]} history - previous (prompt, code) pairs for context
 * @returns {Promise<string>} Python code
 */
async function getCopilotCode(userPrompt, history = []) {
  const token = getGitHubToken();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // Inject prior turns so the model understands scene state
  for (const { prompt, code } of history) {
    messages.push({ role: 'user', content: prompt });
    messages.push({ role: 'assistant', content: code });
  }

  messages.push({ role: 'user', content: userPrompt });

  const payload = JSON.stringify({
    model: 'gpt-4o',
    messages,
    max_tokens: 1024,
    temperature: 0.2,
  });

  const options = {
    hostname: COPILOT_ENDPOINT,
    path: COPILOT_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${token}`,
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.90.0',
      'Editor-Plugin-Version': 'copilot-chat/0.15.0',
    },
  };

  const { statusCode, body } = await httpsRequest(options, payload);

  if (statusCode !== 200) {
    let detail = body;
    try {
      detail = JSON.parse(body).error?.message ?? body;
    } catch (_) { /* ignore */ }
    throw new Error(`Copilot API error ${statusCode}: ${detail}`);
  }

  const data = JSON.parse(body);
  const raw = data.choices?.[0]?.message?.content ?? '';

  // Strip markdown code fences if the model added them despite our instructions
  return stripCodeFences(raw.trim());
}

/**
 * Remove ```python ... ``` or ``` ... ``` wrappers.
 * @param {string} text
 * @returns {string}
 */
function stripCodeFences(text) {
  return text
    .replace(/^```(?:python)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

module.exports = { getCopilotCode };
