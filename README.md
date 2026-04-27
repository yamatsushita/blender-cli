# 🎨 Blender Copilot CLI

Edit your Blender 3D scene with natural language, powered by **GitHub Copilot**.  
No server to start, no ports to configure — communication happens through a shared local directory.

```
▶ create a scene that looks like this: https://example.com/photo.jpg
⠙ Searching models for "winged angel statue"...
⠙ Found 7 candidates, AI selecting best for "winged angel statue"...
⠙ Selected model: Stanford Lucy (Angel) (common3d)
⠙ Downloading Stanford Lucy (Angel)...
⠙ Searching HDRIs for "museum interior soft light"...
⠙ Found 8 candidates, AI selecting best HDRI for "museum interior soft light"...
⠙ Selected HDRI: studio_small_09
⠙ Downloading HDRI: studio_small_09_1k.exr...
⠙ Asking GitHub Copilot...
✔ Code generated

💭 Reasoning:
────────────────────────────────────────────────────────────
  REASONING: Importing lucy.obj, scaling to ~4 units, placing on a dark
  pedestal, applying marble material. Studio HDRI loaded for soft ambient
  lighting. Camera set to front-elevated view at 50 mm.
────────────────────────────────────────────────────────────

📝 Generated code:
────────────────────────────────────────────────────────────
  def import_model(key):
      fp = ASSETS.get(key)
      if not fp: return []
      ...
────────────────────────────────────────────────────────────

✔ Scene updated
```

---

## How it works

```
Your terminal
─────────────
$ blender-cli
▶  "place a stanford bunny with a marble texture"
        │
        ├─► planAssets() → needs [bunny model, marble texture]
        │         │
        │         ▼  search Poly Haven + ambientCG for candidates
        │   searchPolyHavenCandidates("stanford bunny") → 7 candidates
        │         │
        │         ▼  download candidate thumbnails → Copilot vision
        │   selectAsset(candidates, query, scene context)
        │         │
        │         ▼  download AI-chosen asset
        │   ~/.blender-copilot/assets/
        │     models/stanford-bunny.obj
        │     textures/marble_01_diff_1k.jpg
        │
        ▼  GitHub Copilot Chat API (e.g. Claude Opus 4.6)
   code generated with ASSETS dict injected
        │
        ▼  write files
   ~/.blender-copilot/<session>/
     run.py       ← preamble + generated Python code
     run.trigger  ← signals Blender to execute

                          Blender (addon timer, every 0.25 s)
                          ────────────────────────────────────
                          sees run.trigger
                              │
                              ▼  exec() on main thread
                          bpy scene updates live ✨
                              │
                              ▼  write
                          result.json  ← success / error

   CLI reads result.json, shows outcome
```

1. You type a **natural language prompt** (text or image URL).
2. Copilot decides which 3D assets are needed (models, textures, HDRIs).
3. The CLI searches Poly Haven and ambientCG for multiple candidates, downloads their **preview thumbnails**, and asks Copilot to **visually select** the best match for your scene.
4. The chosen asset is downloaded and cached locally.
5. Copilot generates Python `bpy` code with `ASSET_DIR`, `ASSETS`, `os`, `math`, and `mathutils` pre-injected.
6. The code is sent to Blender via the file bridge and executed on Blender's main thread.

---

## Requirements

| Tool | Version |
|------|---------|
| [Blender](https://www.blender.org/download/) | 3.6+ |
| [Node.js](https://nodejs.org/) | 18+ |
| [GitHub CLI](https://cli.github.com/) | 2.x (`gh`) |
| GitHub Copilot subscription | Individual or Business |

---

## Setup

### 1 — Install the Blender addon

1. Open Blender.
2. Zip the `blender_addon/` folder:
   ```bash
   # macOS/Linux
   zip -r blender_copilot_bridge.zip blender_addon/
   # PowerShell
   Compress-Archive blender_addon blender_copilot_bridge.zip
   ```
3. **Edit → Preferences → Add-ons → Install…** and select the zip.
4. Search for **"Copilot CLI Bridge"** and enable it with the checkbox.

> The addon watches the session directory and executes code every 0.25 s on Blender's main thread.  
> A status panel is available at **View3D → Sidebar (N) → Copilot**.

### 2 — Install the CLI

```bash
cd cli
npm install
npm install -g .   # makes `blender-cli` available globally
```

Or run directly without installing:

```bash
node cli/src/index.js
```

### 3 — Authenticate with GitHub Copilot

```bash
gh auth login     # if not already logged in
```

---

## Usage

```
blender-cli [--dry-run] [--no-launch] [--help]

OPTIONS
  --dry-run    Generate code but do NOT send to Blender
  --no-launch  Skip auto-launching Blender (use if Blender is already open)
  --help       Show help

ENV VARS
  BLENDER_PATH  Full path to the Blender executable (auto-detected if omitted)
  ASSET_PATH    Asset cache folder (default: ~/.blender-copilot/assets/)
                  models/    ← downloaded OBJ/GLTF/blend meshes
                  textures/  ← downloaded PNG/JPG PBR texture maps
                  hdris/     ← downloaded EXR/HDR environment maps
                  blends/    ← downloaded native .blend files
```

`ASSET_PATH` is optional — the default location works fine for most users.

### Always-available Python variables

Every generated code block has these pre-injected before execution:

```python
import os, math, mathutils
ASSET_DIR  = '/Users/you/.blender-copilot/assets'   # root cache folder
ASSET_PATH = ASSET_DIR                               # backward-compat alias
ASSETS = {                                           # files downloaded for this request
    'bunny_model':   '.../models/stanford-bunny.obj',
    'marble_texture': '.../textures/marble_01_diff_1k.jpg',
    'sky_hdri':      '.../hdris/studio_small_09_1k.exr',
}
```

`ASSETS` is empty (`{}`) when no download was needed. **Always use `ASSETS.get('key')`** — if a download failed, the key will be absent and the generated code falls back to procedural geometry.

### Asset sources

| Source | Types | Notes |
|--------|-------|-------|
| [Poly Haven](https://polyhaven.com/) | Models, Textures, HDRIs, .blend | CC0; selected by AI visual inspection of thumbnails |
| [ambientCG](https://ambientcg.com/) | Textures | CC0 PBR texture sets; selected by AI visual inspection |
| Built-in mesh collection | Models | Stanford bunny/dragon/armadillo/lucy, Utah teapot, Spot (cow), etc. |

All sources are **completely free and CC0-licensed** (no attribution required).

**Asset selection is AI-driven**: for each needed asset, the CLI fetches up to 8 candidates from live APIs, downloads their preview thumbnails, and sends the thumbnails to Copilot as images. Copilot picks the candidate that visually best matches your scene — not by filename, but by looking at the actual content.

### REPL commands

| Command    | Description |
|------------|-------------|
| `/undo`    | Undo the last operation in Blender |
| `/clear`   | Delete all mesh objects in the scene |
| `/history` | Show prompts used in this session |
| `/quit`    | Exit the CLI |

### Example session

```
$ ASSET_PATH=~/my-assets blender-cli
🎨 Blender CLI
  Asset library: /Users/you/my-assets
  (Override with env: ASSET_PATH)

  Found: /Applications/Blender.app/Contents/MacOS/Blender
  Session: abc123...
✔ Blender is ready

  Copilot model: claude-opus-4.6

▶ add a stanford bunny with a marble texture on a dark background
⠙ Searching models for "stanford bunny"...
⠙ Found 4 candidates, AI selecting best for "stanford bunny"...
⠙ Selected model: Stanford Bunny (common3d)
⠙ Downloading Stanford Bunny...
⠙ Searching textures for "marble"...
⠙ Found 10 candidates, AI selecting best texture for "marble"...
⠙ Selected texture: marble_01 (polyhaven)
⠙ Downloading texture: marble_01_diff_1k.jpg...
⠙ Asking GitHub Copilot...
✔ Code generated

💭 Reasoning:
────────────────────────────────────────────────────────────
  REASONING: Import bunny OBJ, apply marble texture via ShaderNodeTexImage,
  set dark world background, camera at front-elevated position.
────────────────────────────────────────────────────────────

📝 Generated code:
────────────────────────────────────────────────────────────
  def import_model(key):
      fp = ASSETS.get(key)
      if not fp: return []
      ...
────────────────────────────────────────────────────────────

✔ Scene updated

▶ describe this and recreate it: https://example.com/scene.jpg
⠙ Searching models for ...
...
✔ Scene updated

▶ /undo
  [built-in command]
✔ Scene updated
```

---

## Architecture

```
blender-cli/
├── blender_addon/
│   └── __init__.py          # Blender addon: bpy.app.timers watcher + UI panel
└── cli/
    ├── package.json
    ├── bin/
    │   └── blender-cli.js    # Executable entry point
    └── src/
        ├── index.js          # Interactive REPL, spinner, session orchestration
        ├── copilot.js        # Copilot API client: planAssets(), selectAsset(),
        │                     #   getCopilotResponseStream()
        ├── assets.js         # Multi-candidate search + AI-driven download:
        │                     #   Poly Haven, ambientCG, common-3d-test-models
        └── blender.js        # File-based bridge + Blender auto-launch
```

### Asset pipeline detail

```
planAssets(prompt)
    │  Copilot reads the prompt, returns [{type, query, key}]
    │
    ▼
For each asset:
    searchPolyHavenCandidates(query, category, limit=8)
    searchAmbientCGCandidates(query, limit=5)         [textures only]
    WELL_KNOWN_MODELS filter                           [models only]
    │
    ▼  download thumbnails in parallel
    selectAsset(candidates, query, sceneContext)
    │  → Copilot sees actual thumbnail images, picks best index
    │
    ▼
    downloadPolyHavenBundle / common3d download / ambientCG zip extract
```

### Session isolation

Each `blender-cli` invocation creates a unique session directory under `~/.blender-copilot/<uuid>/`.  
Blender is launched with `--python startup.py` which watches only that directory.  
Multiple Blender instances can run simultaneously — each CLI only talks to its own paired instance.

Previously downloaded assets persist across prompts within a session. If an asset download fails, the LLM is told explicitly and generates procedural geometry instead of raising a `KeyError`.

### Blender addon internals

`bpy.app.timers.register(_poll_and_execute, persistent=True)` fires every **0.25 s** on Blender's main thread.  
When `run.trigger` appears, the callback reads `run.py`, calls `exec()`, redraws all viewports, and writes `result.json`.  
`undo/redo` are detected and run under a window-only `temp_override` instead of a `VIEW_3D` override.

---

## Security notes

- All file I/O stays in `~/.blender-copilot/` on your local machine — no network port is opened.
- `exec()` runs with full Python access inside the Blender process. Only run code you trust.
- Your GitHub token is read from `gh auth token` and sent to `api.githubcopilot.com` over HTTPS; it is never stored on disk by this tool.
- Asset downloads come from Poly Haven, ambientCG, and GitHub — all HTTPS, no third-party accounts needed.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Timeout after 45 s on first launch | Blender may be slow to start; check the log file shown in the terminal |
| `Could not get GitHub token` | Run `gh auth login` |
| `Copilot API error 401` | Token expired — re-authenticate with `gh auth login` |
| `name 'ASSETS' is not defined` | Reinstall the CLI: `cd cli && npm install -g .` |
| Asset not found / wrong asset | The AI visual selector picks from real thumbnails; rephrase the query with more specific descriptors |
| Code runs but scene doesn't update | Make sure you're in Object Mode; restart Blender if the addon timer stopped |

---

## License

MIT

