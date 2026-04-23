# 🎨 Blender Copilot CLI

Edit your Blender 3D scene with natural language, powered by **GitHub Copilot**.

```
▶ add a glossy red sphere above the default cube
⠙ Asking GitHub Copilot…
✔ Code generated

📝 Generated code:
────────────────────────────────────────────────────────────
  import bpy
  bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 3))
  obj = bpy.context.active_object
  mat = bpy.data.materials.new(name="GlossyRed")
  mat.use_nodes = True
  bsdf = mat.node_tree.nodes["Principled BSDF"]
  bsdf.inputs["Base Color"].default_value = (1, 0, 0, 1)
  bsdf.inputs["Roughness"].default_value = 0.05
  obj.data.materials.append(mat)
────────────────────────────────────────────────────────────

✔ Scene updated in Blender
```

---

## How it works

```
┌─────────────────────────────────────────────────────────────────────┐
│  Your terminal                                                       │
│                                                                      │
│  $ blender-copilot                                                   │
│  ▶  "add a blue torus at (2, 0, 1)"                                  │
│           │                                                          │
│           ▼                                                          │
│   ┌───────────────────┐    GitHub Copilot API                        │
│   │  copilot.js       │ ─────────────────────►  gpt-4o               │
│   │  (auth via gh CLI)│ ◄─────────────────────  Python bpy code      │
│   └───────────────────┘                                              │
│           │  HTTP POST /execute {"code": "..."}                      │
│           ▼                                                          │
│   ┌───────────────────┐   localhost:5123                             │
│   │  blender.js       │ ──────────────────────►  Blender addon       │
│   └───────────────────┘                          (HTTP server)       │
└─────────────────────────────────────────────────────────────────────┘
                                                         │
                                              exec() on main thread
                                                         │
                                                         ▼
                                                 ┌──────────────┐
                                                 │  Blender 3D  │
                                                 │  Scene live  │
                                                 │  updates ✨  │
                                                 └──────────────┘
```

1. You type a **natural language prompt** in the terminal.
2. The CLI authenticates with your local `gh` session and calls the **GitHub Copilot Chat API**.
3. Copilot returns Python code using the `bpy` (Blender Python) API.
4. The CLI sends the code over HTTP to the **Blender Copilot Bridge addon** running inside Blender.
5. The addon executes the code on Blender's **main thread** (via a modal timer operator) and redraws all viewports.

---

## Requirements

| Tool | Version |
|------|---------|
| [Blender](https://www.blender.org/download/) | 3.0+ |
| [Node.js](https://nodejs.org/) | 18+ |
| [GitHub CLI](https://cli.github.com/) | 2.x (`gh`) |
| GitHub Copilot subscription | Individual or Business |

---

## Setup

### 1 — Install the Blender addon

1. Open Blender.
2. Go to **Edit → Preferences → Add-ons → Install…**
3. Select the `blender_addon/` **folder** (zip it first if Blender asks for a zip):

   ```bash
   # From the repo root
   cd blender_addon
   zip -r ../blender_copilot_bridge.zip .
   ```

4. Search for **"Copilot CLI Bridge"** in the add-ons list and **enable it**.
5. Open a **3D Viewport**, press **N** to open the sidebar, and click the **Copilot** tab.
6. Press **Start Server** — the bridge listens on `127.0.0.1:5123` by default.

### 2 — Install the CLI

```bash
# From the repo root
cd cli
npm install
npm link        # makes `blender-copilot` available globally
```

Or run without installing:

```bash
node cli/src/index.js
```

### 3 — Authenticate with GitHub Copilot

```bash
gh auth login   # if not already logged in
gh auth token   # verify a token is available
```

---

## Usage

```
blender-copilot [options]

OPTIONS
  --port <n>   Port the Blender addon server is listening on  (default: 5123)
  --host <h>   Hostname of the Blender instance               (default: 127.0.0.1)
  --dry-run    Generate code but do NOT send to Blender
  --help       Show help
```

### REPL commands

| Command    | Description |
|------------|-------------|
| `/undo`    | Undo the last operation in Blender |
| `/clear`   | Delete all mesh objects in the scene |
| `/history` | Show prompts used in this session |
| `/quit`    | Exit the CLI |

### Example session

```
$ blender-copilot
🎨 Blender Copilot CLI
Type a natural language prompt, /help for commands, or Ctrl+C to quit.

✔ Connected to Blender bridge at 127.0.0.1:5123

▶  delete the default cube
✔ Code generated
✔ Scene updated in Blender

▶  create a mountain landscape using a subdivided plane with displacement
✔ Code generated
✔ Scene updated in Blender

▶  add a sun lamp pointing down at 45 degrees
✔ Code generated
✔ Scene updated in Blender

▶  /undo
  [built-in command]
✔ Scene updated in Blender

▶  /quit
Goodbye! 👋
```

### Dry-run (preview only)

```bash
blender-copilot --dry-run
```

Generates and prints the code without sending it to Blender — useful for reviewing or learning Blender Python.

---

## Architecture

```
blender-cli/
├── blender_addon/
│   └── __init__.py         # Blender addon: HTTP server + modal executor + UI panel
└── cli/
    ├── package.json
    ├── bin/
    │   └── blender-copilot.js   # Executable entry point
    └── src/
        ├── index.js        # Interactive REPL, spinner, arg parsing
        ├── copilot.js      # GitHub Copilot API client (auth via `gh auth token`)
        └── blender.js      # HTTP client for the Blender addon bridge
```

### Blender addon internals

The addon registers a **modal operator** (`COPILOT_OT_RunServer`) that fires every 50 ms via a `wm.event_timer_add` timer. When the HTTP server thread receives a `/execute` request, it pushes `(code, threading.Event)` onto a `queue.Queue`. The modal operator drains the queue on the main thread, calls `exec()`, signals the event, and tags all areas for redraw. The HTTP handler blocks on `event.wait(timeout=30)` so the response includes success/error information.

---

## Security notes

- The HTTP server binds to **`127.0.0.1` only** — it is not reachable from the network.
- `exec()` runs with full Python access inside the Blender process. Only run code you trust.
- Your GitHub token is read from `gh auth token` and sent to `api.githubcopilot.com` over HTTPS; it is never stored on disk by this tool.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot reach Blender bridge` | Click **Start Server** in Blender's Copilot sidebar panel |
| `Could not get GitHub token` | Run `gh auth login` |
| `Copilot API error 401` | Your token may have expired — re-authenticate with `gh auth login` |
| Port conflict | Change the port in Blender's panel and pass `--port <n>` to the CLI |
| Code runs but scene doesn't update | Make sure you're in Object Mode; some `bpy.ops` require specific context |

---

## License

MIT
