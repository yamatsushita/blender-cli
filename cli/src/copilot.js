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
    CRITICAL: ONLY reference keys that are listed in the [PRE-DOWNLOADED ASSETS] block of the
    user message. If a key is listed in [FAILED TO DOWNLOAD], do NOT use it in ASSETS at all —
    generate that object procedurally with Blender primitives instead.
    Use ASSETS.get('key') to safely access. ASSETS may be empty if nothing was downloaded.
- ASSET_PATH : str -- same as ASSET_DIR (backward-compat alias). Treat identically.
- os, math, mathutils are pre-imported -- do NOT import them again.

IMPORTING ASSETS -- ONLY use keys shown in [PRE-DOWNLOADED ASSETS]. Use .get() for safety:
  WRONG:  bpy.ops.wm.obj_import(filepath=ASSET_DIR)   # ← ASSET_DIR is a folder!
  WRONG:  bpy.ops.wm.obj_import(filepath=ASSET_PATH)  # ← same problem
  WRONG:  ASSETS['some_key']  # ← KeyError if not downloaded; use .get() instead
  RIGHT:  fp = ASSETS.get('tree_model')
          if fp: bpy.ops.wm.obj_import(filepath=fp)
          else: # generate procedurally

  MODEL IMPORT -- the file could be .blend, .gltf, .obj, .stl, .dae, or a DIRECTORY of mesh files.
  ALWAYS use this helper; NEVER hardcode any import operator directly:
      def import_model(key):
          fp = ASSETS.get(key)
          if not fp:
              return []  # asset not available — caller should generate procedurally
          def _import_stl(p):
              # bpy.ops.import_mesh.stl was removed in Blender 4.x → use wm.stl_import
              if hasattr(bpy.ops.wm, 'stl_import'):
                  bpy.ops.wm.stl_import(filepath=p)
              elif hasattr(bpy.ops.import_mesh, 'stl'):
                  bpy.ops.import_mesh.stl(filepath=p)
              else:
                  print(f"No STL importer available, skipping {p}")
                  return []
              return list(bpy.context.selected_objects)
          def _import_file(p):
              ext = p.rsplit('.', 1)[-1].lower()
              bpy.ops.object.select_all(action='DESELECT')
              if ext == 'blend':
                  with bpy.data.libraries.load(p, link=False) as (data_from, data_to):
                      data_to.objects = list(data_from.objects)
                  return [o for o in data_to.objects if o and (bpy.context.scene.collection.objects.link(o) or True)]
              elif ext in ('gltf', 'glb'):
                  bpy.ops.import_scene.gltf(filepath=p)
              elif ext == 'stl':
                  return _import_stl(p)
              else:  # .obj, .ply, .fbx, etc.
                  bpy.ops.wm.obj_import(filepath=p)
              return list(bpy.context.selected_objects)
          # Extension priority: .dae (Collada) is excluded — operator removed in Blender 4.x
          EXT_ORDER = ['obj', 'gltf', 'glb', 'stl', 'ply', 'fbx', 'blend']
          if os.path.isdir(fp):
              imported = []
              # Walk recursively so subdirs (e.g. meshes/) are searched
              all_files = []
              for root, dirs, files in os.walk(fp):
                  for f in files:
                      ext = f.lower().rsplit('.', 1)[-1] if '.' in f else ''
                      if ext in EXT_ORDER:
                          all_files.append(os.path.join(root, f))
              def ext_rank(p):
                  ext = p.lower().rsplit('.', 1)[-1]
                  return EXT_ORDER.index(ext) if ext in EXT_ORDER else 99
              for mf in sorted(all_files, key=ext_rank):
                  imported.extend(_import_file(mf))
              return imported
          return _import_file(fp)
      objs = import_model('robot_model')   # returns [] if not downloaded
      if objs:
          obj = objs[0]
      else:
          # generate procedurally
          bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=1, depth=4)
          obj = bpy.context.active_object

  TEXTURE (guard with .get() — skip if not available):
      tex_path = ASSETS.get('wood_texture')
      if tex_path:
          img = bpy.data.images.load(tex_path)
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
      env.image = bpy.data.images.load(ASSETS.get('sky_hdri', ''))  # guard: only set if available
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

   Import operators — Blender 4.x renamed several:
     STL:     bpy.ops.wm.stl_import(filepath=p)      ← Blender 4.x
              NOT bpy.ops.import_mesh.stl(...)        ← removed in 4.x
     Collada: bpy.ops.wm.collada_import(filepath=p)  ← removed in 4.x; skip if not available
     OBJ:     bpy.ops.wm.obj_import(filepath=p)      ← works in 3.3+ and 4.x
     GLTF:    bpy.ops.import_scene.gltf(filepath=p)  ← works in all versions
     ALWAYS use the import_model() helper above — it handles all version differences.

Example -- "place a bunny with wood texture" (ASSETS = {'bunny_model': '...', 'wood_texture': '...'}):
## REASONING: Import the bunny (format unknown, use import_model helper).
## Apply wood texture via Principled BSDF ShaderNodeTexImage node.
def import_model(key):
    fp = ASSETS.get(key)
    if not fp: return []
    EXT_ORDER = ['obj', 'gltf', 'glb', 'stl', 'ply', 'fbx', 'blend']  # no .dae — Collada removed in Blender 4.x
    def _import_stl(p):
        if hasattr(bpy.ops.wm, 'stl_import'): bpy.ops.wm.stl_import(filepath=p)
        elif hasattr(bpy.ops.import_mesh, 'stl'): bpy.ops.import_mesh.stl(filepath=p)
        else: return []
        return list(bpy.context.selected_objects)
    def _import_file(p):
        ext = p.rsplit('.', 1)[-1].lower()
        bpy.ops.object.select_all(action='DESELECT')
        if ext == 'blend':
            with bpy.data.libraries.load(p, link=False) as (df, dt): dt.objects = list(df.objects)
            return [o for o in dt.objects if o and (bpy.context.scene.collection.objects.link(o) or True)]
        elif ext in ('gltf', 'glb'): bpy.ops.import_scene.gltf(filepath=p)
        elif ext == 'stl': return _import_stl(p)
        else: bpy.ops.wm.obj_import(filepath=p)
        return list(bpy.context.selected_objects)
    if os.path.isdir(fp):
        imported = []
        all_files = []
        for root, dirs, files in os.walk(fp):
            for f in files:
                ext = f.lower().rsplit('.', 1)[-1] if '.' in f else ''
                if ext in EXT_ORDER: all_files.append(os.path.join(root, f))
        for mf in sorted(all_files, key=lambda p: EXT_ORDER.index(p.lower().rsplit('.',1)[-1]) if p.lower().rsplit('.',1)[-1] in EXT_ORDER else 99):
            imported.extend(_import_file(mf))
        return imported
    return _import_file(fp)
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
        'Format: {"assets": [{"type": "model"|"texture"|"hdri"|"blend", "query": "<search term>", "key": "<snake_case_id>", "url": "<optional direct URL>"}]}\n\n' +
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
        '- url: REQUIRED when the user provides a specific URL to download the asset from.\n' +
        '  Examples:\n' +
        '    "Download the model from https://github.com/frankarobotics/franka_description"\n' +
        '      → {"type":"model","query":"franka panda robot","key":"robot_model","url":"https://github.com/frankarobotics/franka_description"}\n' +
        '    "Use the asset at https://example.com/model.obj"\n' +
        '      → {"type":"model","query":"model","key":"asset_model","url":"https://example.com/model.obj"}\n' +
        '    "Import https://raw.githubusercontent.com/user/repo/main/mesh.gltf"\n' +
        '      → {"type":"model","query":"mesh","key":"mesh_model","url":"https://raw.githubusercontent.com/user/repo/main/mesh.gltf"}\n' +
        '  When url is provided, omit the search — the downloader will fetch directly from that URL.\n' +
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
 * Use Copilot vision to select the best asset from multiple candidates.
 *
 * Downloads each candidate's preview thumbnail and sends all of them to the
 * model alongside scene context.  The model replies with a single number
 * identifying the best match.  Falls back to the first candidate on any error.
 *
 * @param {Array<{id:string, name:string, source:string, tags:string[], previewUrl:string|null}>} candidates
 * @param {string} query        What kind of asset we're looking for ("oak wood floor texture")
 * @param {string} sceneContext Full user prompt, so the model understands the surrounding scene
 * @returns {Promise<string|null>}  Chosen candidate id, or null
 */
async function selectAsset(candidates, query, sceneContext) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;

  const token = getGitHubToken();
  const model = await discoverModel();

  // Download all thumbnails in parallel; null means thumbnail unavailable
  const withThumbs = await Promise.all(
    candidates.map(async (c) => ({
      ...c,
      thumbBase64: c.previewUrl ? await fetchImageAsBase64(c.previewUrl) : null,
    })),
  );

  const hasAnyThumb = withThumbs.some((c) => c.thumbBase64);

  // Build multimodal or text-only message depending on thumbnail availability
  let userContent;
  if (hasAnyThumb) {
    const parts = [
      {
        type: 'text',
        text:
          `I am building a 3D scene and need to pick the most visually appropriate asset.\n\n` +
          `Scene: ${sceneContext}\n` +
          `Asset needed: ${query}\n\n` +
          `Below are ${candidates.length} candidates. For each I show its name, tags, ` +
          `and a preview thumbnail image:`,
      },
    ];
    for (let i = 0; i < withThumbs.length; i++) {
      const c = withThumbs[i];
      const tagStr = c.tags.slice(0, 6).join(', ');
      parts.push({
        type: 'text',
        text: `\n[${i + 1}] ${c.name} (source: ${c.source}${tagStr ? '; tags: ' + tagStr : ''})`,
      });
      if (c.thumbBase64) {
        parts.push({ type: 'image_url', image_url: { url: c.thumbBase64, detail: 'low' } });
      }
    }
    parts.push({
      type: 'text',
      text: `\nReply with ONLY the number (1-${candidates.length}) of the best match. No explanation.`,
    });
    userContent = parts;
  } else {
    // No thumbnails available — text-only selection
    const lines = withThumbs.map(
      (c, i) => `[${i + 1}] ${c.name} (${c.source}; tags: ${c.tags.slice(0, 6).join(', ')})`,
    );
    userContent =
      `Scene: ${sceneContext}\nAsset needed: ${query}\n\nCandidates:\n${lines.join('\n')}\n\n` +
      `Reply with ONLY the number (1-${candidates.length}) of the best match. No explanation.`;
  }

  try {
    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content: userContent }],
      max_tokens: 10,
      temperature: 0,
    });
    const headers = { ...copilotHeaders(token), 'Content-Length': Buffer.byteLength(payload) };
    const { statusCode, body } = await httpsRequest(
      { hostname: COPILOT_ENDPOINT, path: '/chat/completions', method: 'POST', headers },
      payload,
      30_000,
    );
    if (statusCode !== 200) return candidates[0].id;
    const resp = (JSON.parse(body).choices?.[0]?.message?.content ?? '1').trim();
    const idx  = parseInt(resp.match(/\d+/)?.[0] ?? '1', 10) - 1;
    const chosen = candidates[Math.max(0, Math.min(idx, candidates.length - 1))];
    return chosen.id;
  } catch {
    return candidates[0].id;
  }
}


/**
 * Generate Blender Python code with reasoning from a natural language prompt.
 * @param {string} userPrompt
 * @param {Array<{prompt: string, code: string}>} history
 * @param {{assetDict?: Record<string,string>, failedAssets?: string[]}} opts
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

  // Always inject the ASSETS ground truth so LLM never references unavailable keys.
  const assetDict = opts.assetDict ?? {};
  const listing = Object.entries(assetDict)
    .map(([k, v]) => `  '${k}': r'${v.replace(/\\/g, '/')}'`)
    .join(',\n');
  const failedNote = (opts.failedAssets ?? []).length
    ? `\n[FAILED TO DOWNLOAD — do NOT reference these keys in ASSETS: ${opts.failedAssets.join(', ')}]`
    : '';
  let userContent =
    `[PRE-DOWNLOADED ASSETS in ASSETS dict:\n${listing || '  (none)'}\n]${failedNote}\n` +
    userPrompt;

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
 * @param {Array<{userText: string, assistantRaw: string}>} history
 * @param {{assetDict?: Record<string, string>}} [opts]
 * @param {{
 *   onThinkingStart?: () => void,
 *   onThinkingLine?: (line: string) => void,
 *   onThinkingEnd?: () => void,
 * }} [callbacks]
 * @returns {Promise<{thinking: string|null, code: string, userText: string, fullRaw: string}>}
 */
async function getCopilotResponseStream(userPrompt, history = [], opts = {}, callbacks = {}) {
  const token = getGitHubToken();
  const model = await discoverModel();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  // Replay conversation history — userText includes the assets block so the model
  // remembers what was downloaded and what URLs the user mentioned.
  for (const { userText, assistantRaw } of history) {
    messages.push({ role: 'user', content: userText });
    messages.push({ role: 'assistant', content: assistantRaw });
  }

  // Always inject the ASSETS ground truth so LLM never references unavailable keys.
  const assetDict = opts.assetDict ?? {};
  const assetListing = Object.entries(assetDict)
    .map(([k, v]) => `  '${k}': r'${v.replace(/\\/g, '/')}'`)
    .join(',\n');
  const failedNote = (opts.failedAssets ?? []).length
    ? `\n[FAILED TO DOWNLOAD — do NOT reference these keys in ASSETS: ${opts.failedAssets.join(', ')}]`
    : '';
  // userText is the plain-text version (no base64 images) — stored in history so the model
  // remembers URLs, asset keys, and context across follow-up prompts.
  const userText =
    `[PRE-DOWNLOADED ASSETS in ASSETS dict:\n${assetListing || '  (none)'}\n]${failedNote}\n` +
    userPrompt;
  // For the actual API call, also embed any image URLs as base64 data URIs.
  messages.push({ role: 'user', content: await buildUserContent(userText) });

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
    const parsed = parseResponse(fullRaw);
    return { ...parsed, userText, fullRaw };
  }

  const thinking = thinkingLines.join('\n').trim() || null;
  const code = stripCodeFences(codeBuffer.trim());
  return { thinking, code, userText, fullRaw };
}

/** Reset cached model (useful for testing). */
function resetModelCache() { _cachedModel = null; }

module.exports = { getCopilotCode, getCopilotResponse, getCopilotResponseStream, planAssets, selectAsset, discoverModel, resetModelCache };
