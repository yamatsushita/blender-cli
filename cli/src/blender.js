'use strict';

/**
 * Blender file-based bridge + auto-launch.
 *
 * Each blender-cli session gets its own isolated subdirectory:
 *   ~/.blender-copilot/<sessionId>/
 *     startup.py   – written by CLI; loaded by Blender via --python
 *     run.py       – Python code to execute
 *     run.trigger  – writing this signals Blender to execute run.py
 *     result.json  – Blender writes execution result here
 *     heartbeat    – Blender writes Unix timestamp every 0.25 s
 *
 * This ensures that if multiple Blender instances are open (launched by
 * separate blender-cli invocations or manually), each CLI only drives
 * its own paired Blender.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const BRIDGE_BASE = path.join(os.homedir(), '.blender-copilot');
fs.mkdirSync(BRIDGE_BASE, { recursive: true });

/**
 * Create an object with all paths scoped to a specific session directory.
 * @param {string} sessionId
 */
function sessionPaths(sessionId) {
  const dir = path.join(BRIDGE_BASE, sessionId);
  return {
    dir,
    startupFile:   path.join(dir, 'startup.py'),
    triggerFile:   path.join(dir, 'run.trigger'),
    codeFile:      path.join(dir, 'run.py'),
    resultFile:    path.join(dir, 'result.json'),
    heartbeatFile: path.join(dir, 'heartbeat'),
  };
}

/**
 * Build the startup Python script for a specific session directory.
 * The session path is embedded so this Blender only watches that directory.
 * @param {string} sessionDir  Absolute path to the session directory
 * @returns {string}
 */
function buildStartupScript(sessionDir) {
  const pyPath = sessionDir.replace(/\\/g, '/');
  return `import bpy, json, textwrap, time
from pathlib import Path

SESSION_DIR    = Path(r"${pyPath}")
TRIGGER_FILE   = SESSION_DIR / "run.trigger"
CODE_FILE      = SESSION_DIR / "run.py"
RESULT_FILE    = SESSION_DIR / "result.json"
HEARTBEAT_FILE = SESSION_DIR / "heartbeat"


def _find_view3d_context():
    """Return kwargs for bpy.context.temp_override() using the first VIEW_3D."""
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type != 'VIEW_3D':
                continue
            # Prefer the WINDOW region (the main 3D viewport, not toolbars)
            region = next(
                (r for r in area.regions if r.type == 'WINDOW'),
                area.regions[-1],
            )
            return {
                'window': window,
                'screen': window.screen,
                'area': area,
                'region': region,
                'space_data': area.spaces.active,
            }
    return {}


def _get_all_view3d_areas():
    """Return list of all VIEW_3D areas across all windows."""
    areas = []
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                areas.append(area)
    return areas


def _is_window_op_only(code):
    """Return True when code consists solely of ed.undo / ed.redo calls.
    These operators need a window context, not a VIEW_3D area context."""
    import re
    stripped = re.sub(r'#[^\\n]*', '', code)   # remove comments
    lines = [l.strip() for l in stripped.splitlines() if l.strip()]
    return lines and all(
        re.fullmatch(r'bpy\\.ops\\.ed\\.(undo|redo)\\(\\)', l) for l in lines
    )


def _copilot_poll():
    HEARTBEAT_FILE.write_text(str(time.time()), encoding="utf-8")
    if not TRIGGER_FILE.exists():
        return 0.25
    try:
        rid  = TRIGGER_FILE.read_text(encoding="utf-8").strip()
        code = CODE_FILE.read_text(encoding="utf-8") if CODE_FILE.exists() else ""
        TRIGGER_FILE.unlink(missing_ok=True)
    except OSError:
        return 0.25
    try:
        view3d_areas = _get_all_view3d_areas()
        import mathutils as _mathutils
        ns = {"bpy": bpy, "_view3d_areas": view3d_areas, "mathutils": _mathutils}
        # undo/redo need a plain window context; VIEW_3D override breaks their poll.
        if _is_window_op_only(code):
            win = bpy.context.window_manager.windows[0]
            with bpy.context.temp_override(window=win):
                exec(textwrap.dedent(code), ns)
        else:
            ctx = _find_view3d_context()
            if ctx:
                with bpy.context.temp_override(**ctx):
                    exec(textwrap.dedent(code), ns)
            else:
                exec(textwrap.dedent(code), ns)
        res = {"id": rid, "success": True}
        for w in bpy.context.window_manager.windows:
            for a in w.screen.areas:
                a.tag_redraw()
    except Exception as exc:
        res = {"id": rid, "success": False, "error": str(exc)}
        print(f"[Copilot Bridge] Error: {exc}")
    RESULT_FILE.write_text(json.dumps(res), encoding="utf-8")
    return 0.25

if not bpy.app.timers.is_registered(_copilot_poll):
    bpy.app.timers.register(_copilot_poll, persistent=True)
    print(f"[Copilot Bridge] Session {SESSION_DIR.name!r} active")
`;
}

/**
 * Find the Blender executable on the current platform.
 * Priority: BLENDER_PATH env -> system PATH -> common install locations.
 * @returns {string|null}
 */
function findBlenderExecutable() {
  if (process.env.BLENDER_PATH && fs.existsSync(process.env.BLENDER_PATH))
    return process.env.BLENDER_PATH;

  try {
    const cmd = process.platform === 'win32' ? 'where.exe blender' : 'which blender';
    const line = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' })
      .trim().split(/\r?\n/)[0].trim();
    if (line && fs.existsSync(line)) return line;
  } catch (_) { /* not in PATH */ }

  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs'),
    ].filter(Boolean);
    for (const root of roots) {
      const base = path.join(root, 'Blender Foundation');
      if (!fs.existsSync(base)) continue;
      const dirs = fs.readdirSync(base)
        .filter(d => /blender/i.test(d))
        .sort().reverse();
      for (const d of dirs) {
        const exe = path.join(base, d, 'blender.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }

  if (process.platform === 'darwin') {
    for (const p of [
      '/Applications/Blender.app/Contents/MacOS/Blender',
      path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'),
    ]) if (fs.existsSync(p)) return p;
  }

  if (process.platform === 'linux') {
    for (const p of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender'])
      if (fs.existsSync(p)) return p;
  }

  return null;
}

/**
 * Returns true if the Blender instance for the given session wrote a
 * heartbeat within the last 3 seconds.
 * @param {string} heartbeatFile
 * @returns {boolean}
 */
function isBlenderRunning(heartbeatFile) {
  try {
    const ts = parseFloat(fs.readFileSync(heartbeatFile, 'utf8').trim());
    return !isNaN(ts) && (Date.now() / 1000 - ts) < 3.0;
  } catch (_) {
    return false;
  }
}

/**
 * Create a new session directory, write the startup script, and spawn
 * Blender pointing to it. Returns the session ID and paths.
 * @param {string} blenderPath
 * @returns {{ sessionId: string, paths: ReturnType<typeof sessionPaths> }}
 */
function launchBlender(blenderPath) {
  const sessionId = crypto.randomUUID();
  const p = sessionPaths(sessionId);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.startupFile, buildStartupScript(p.dir), 'utf8');

  const child = spawn(blenderPath, ['--python', p.startupFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { sessionId, paths: p };
}

/**
 * Poll until the session-specific heartbeat appears or timeout expires.
 * @param {string} heartbeatFile
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForBlender(heartbeatFile, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (isBlenderRunning(heartbeatFile)) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start >= timeoutMs) { clearInterval(iv); resolve(false); }
    }, 300);
  });
}

/**
 * Write code to a specific Blender session's bridge and wait for the result.
 * @param {string} code
 * @param {ReturnType<typeof sessionPaths>} paths
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function executeInBlender(code, paths) {
  const requestId = crypto.randomUUID();
  try { fs.unlinkSync(paths.resultFile); } catch (_) {}

  fs.writeFileSync(paths.codeFile, code, 'utf8');
  fs.writeFileSync(paths.triggerFile, requestId, 'utf8');

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const iv = setInterval(() => {
      if (!fs.existsSync(paths.resultFile)) {
        if (Date.now() > deadline) {
          clearInterval(iv);
          reject(new Error(
            'Timeout: Blender did not respond within 30 s.\n' +
            'Is the paired Blender still running?'
          ));
        }
        return;
      }
      clearInterval(iv);
      try {
        const result = JSON.parse(fs.readFileSync(paths.resultFile, 'utf8'));
        resolve(result.id === requestId
          ? result
          : { success: false, error: 'Stale result — please try again' });
      } catch (e) {
        resolve({ success: false, error: `Could not parse result: ${e.message}` });
      }
    }, 150);
  });
}

module.exports = {
  executeInBlender,
  isBlenderRunning,
  findBlenderExecutable,
  launchBlender,
  waitForBlender,
  sessionPaths,
  BRIDGE_BASE,
};
