# 🎨 Blender Copilot CLI

Edit your Blender 3D scene with natural language, powered by **GitHub Copilot**.  
No server to start, no ports to configure — communication happens through a shared directory.

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
Your terminal
─────────────
$ blender-cli
▶  "add a blue torus at (2, 0, 1)"
        │
        ▼  gh auth token + Copilot Chat API
   copilot.js ──────────────────────────► gpt-4o
                ◄──────────────────────── Python bpy code
        │
        ▼  write files
   ~/.blender-cli/
     run.py       ← generated Python code
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

1. You type a **natural language prompt** in the terminal.
2. The CLI authenticates via `gh auth token` and calls the **GitHub Copilot Chat API**.
3. Copilot returns Python code using the `bpy` (Blender Python) API.
4. The CLI writes the code to `~/.blender-cli/run.py` and creates `run.trigger`.
5. The Blender addon's background timer picks up the trigger, **executes the code on the main thread**, and writes `result.json`.
6. The CLI reads the result and shows success or error.

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
2. Zip the `blender_addon/` folder:
   ```bash
   # From the repo root
   Compress-Archive blender_addon blender_copilot_bridge.zip   # PowerShell
   # or:  zip -r blender_copilot_bridge.zip blender_addon/     # macOS/Linux
   ```
3. **Edit → Preferences → Add-ons → Install…** and select the zip.
4. Search for **"Copilot CLI Bridge"** and enable it with the checkbox.

That's it — no server to start. The addon begins watching `~/.blender-cli/` immediately.  
A status panel is available at **View3D → Sidebar (N) → Copilot** for reference.

### 2 — Install the CLI

```bash
cd cli
npm install
npm link          # makes `blender-cli` available globally
```

Or run without installing:

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
blender-cli [--dry-run] [--help]

OPTIONS
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
$ blender-cli
🎨 Blender Copilot CLI
  Bridge directory: /Users/you/.blender-cli
  Make sure the "Copilot CLI Bridge" addon is enabled in Blender.

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
blender-cli --dry-run
```

Generates and prints the code without touching Blender — useful for reviewing or learning Blender Python.

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
        ├── index.js         # Interactive REPL, spinner, session history
        ├── copilot.js       # GitHub Copilot Chat API client
        └── blender.js       # File-based bridge (~/.blender-cli/)
```

### Blender addon internals

`bpy.app.timers.register(_poll_and_execute, persistent=True)` registers a callback that fires every **0.25 s** on Blender's main thread.  
When `run.trigger` appears, the callback reads `run.py`, calls `exec()`, redraws all viewports, and writes `result.json`.  
The CLI polls `result.json` every 150 ms (matching the request ID) for up to 30 s.

---

## Security notes

- All file I/O stays in `~/.blender-cli/` on your local machine — no network port is opened.
- `exec()` runs with full Python access inside the Blender process. Only run code you trust.
- Your GitHub token is read from `gh auth token` and sent to `api.githubcopilot.com` over HTTPS; it is never stored on disk by this tool.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Timeout after 30 s | Enable the **Copilot CLI Bridge** addon in Blender (Edit → Preferences → Add-ons) |
| `Could not get GitHub token` | Run `gh auth login` |
| `Copilot API error 401` | Token expired — re-authenticate with `gh auth login` |
| Code runs but scene doesn't update visually | Make sure you're in Object Mode; some `bpy.ops` require specific context |

---

## License

MIT
