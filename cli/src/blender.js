'use strict';

/**
 * Blender file-based bridge + auto-launch.
 *
 * Shared directory: ~/.blender-copilot/
 *   startup.py   – written by CLI; loaded by Blender on launch via --python
 *   run.py       – Python code to execute
 *   run.trigger  – writing this signals Blender to execute run.py
 *   result.json  – Blender writes execution result here
 *   heartbeat    – Blender writes current Unix timestamp every 0.25 s
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const BRIDGE_DIR      = path.join(os.homedir(), '.blender-copilot');
const STARTUP_FILE    = path.join(BRIDGE_DIR, 'startup.py');
const TRIGGER_FILE    = path.join(BRIDGE_DIR, 'run.trigger');
const CODE_FILE       = path.join(BRIDGE_DIR, 'run.py');
const RESULT_FILE     = path.join(BRIDGE_DIR, 'result.json');
const HEARTBEAT_FILE  = path.join(BRIDGE_DIR, 'heartbeat');

fs.mkdirSync(BRIDGE_DIR, { recursive: true });

/**
 * Minimal Blender startup script — written to disk, passed via --python.
 * No addon installation required; registers the polling timer directly.
 */
const STARTUP_SCRIPT = `\
import bpy, json, textwrap, time
from pathlib import Path

BRIDGE_DIR     = Path.home() / ".blender-copilot"
TRIGGER_FILE   = BRIDGE_DIR / "run.trigger"
CODE_FILE      = BRIDGE_DIR / "run.py"
RESULT_FILE    = BRIDGE_DIR / "result.json"
HEARTBEAT_FILE = BRIDGE_DIR / "heartbeat"

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
        exec(textwrap.dedent(code), {"bpy": bpy})
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
    print("[Copilot Bridge] Active, watching", BRIDGE_DIR)
`;

/**
 * Find the Blender executable on the current platform.
 * Priority: BLENDER_PATH env → system PATH → common install locations.
 * @returns {string|null}
 */
function findBlenderExecutable() {
  if (process.env.BLENDER_PATH && fs.existsSync(process.env.BLENDER_PATH))
    return process.env.BLENDER_PATH;

  // System PATH
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
        .sort().reverse(); // highest version first
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
 * Returns true if Blender wrote a heartbeat within the last 3 seconds.
 * @returns {boolean}
 */
function isBlenderRunning() {
  try {
    const ts = parseFloat(fs.readFileSync(HEARTBEAT_FILE, 'utf8').trim());
    return !isNaN(ts) && (Date.now() / 1000 - ts) < 3.0;
  } catch (_) {
    return false;
  }
}

/**
 * Write the startup script and spawn Blender with --python pointing to it.
 * The process is detached so it outlives this CLI session.
 * @param {string} blenderPath
 */
function launchBlender(blenderPath) {
  fs.writeFileSync(STARTUP_FILE, STARTUP_SCRIPT, 'utf8');
  const child = spawn(blenderPath, ['--python', STARTUP_FILE], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

/**
 * Poll until Blender's heartbeat appears or timeout expires.
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForBlender(timeoutMs = 45000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (isBlenderRunning()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start >= timeoutMs) { clearInterval(iv); resolve(false); }
    }, 300);
  });
}

/**
 * Write code to Blender via the shared file bridge and wait for the result.
 * @param {string} code
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function executeInBlender(code) {
  const requestId = crypto.randomUUID();
  try { fs.unlinkSync(RESULT_FILE); } catch (_) {}

  fs.writeFileSync(CODE_FILE, code, 'utf8');
  fs.writeFileSync(TRIGGER_FILE, requestId, 'utf8');

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const iv = setInterval(() => {
      if (!fs.existsSync(RESULT_FILE)) {
        if (Date.now() > deadline) {
          clearInterval(iv);
          reject(new Error(
            'Timeout: Blender did not respond within 30 s.\n' +
            'Is Blender running with the Copilot Bridge active?'
          ));
        }
        return;
      }
      clearInterval(iv);
      try {
        const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
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
  BRIDGE_DIR,
  TRIGGER_FILE,
  CODE_FILE,
  RESULT_FILE,
  HEARTBEAT_FILE,
};
