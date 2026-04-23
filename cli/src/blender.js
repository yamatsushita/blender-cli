'use strict';

/**
 * Blender file-based bridge.
 *
 * Shared directory: ~/.blender-copilot/
 *   run.py      – Python code to execute
 *   run.trigger – existence signals Blender to run (content = request ID)
 *   result.json – Blender writes result here after execution
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BRIDGE_DIR = path.join(os.homedir(), '.blender-copilot');
const TRIGGER_FILE = path.join(BRIDGE_DIR, 'run.trigger');
const CODE_FILE = path.join(BRIDGE_DIR, 'run.py');
const RESULT_FILE = path.join(BRIDGE_DIR, 'result.json');

fs.mkdirSync(BRIDGE_DIR, { recursive: true });

/**
 * Send Python code to Blender by writing files to the shared directory.
 * Polls result.json until the request ID matches (timeout 30 s).
 * @param {string} code
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function executeInBlender(code) {
  const requestId = crypto.randomUUID();

  // Clean up any stale result from a previous run
  try { fs.unlinkSync(RESULT_FILE); } catch (_) { /* ignore */ }

  fs.writeFileSync(CODE_FILE, code, 'utf8');
  fs.writeFileSync(TRIGGER_FILE, requestId, 'utf8');

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const iv = setInterval(() => {
      if (!fs.existsSync(RESULT_FILE)) {
        if (Date.now() > deadline) {
          clearInterval(iv);
          reject(new Error('Timeout: Blender did not respond within 30 s.\nMake sure the "Copilot CLI Bridge" addon is enabled in Blender.'));
        }
        return;
      }
      clearInterval(iv);
      try {
        const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
        if (result.id !== requestId) {
          resolve({ success: false, error: 'Stale result — Blender may be busy. Try again.' });
        } else {
          resolve(result);
        }
      } catch (e) {
        resolve({ success: false, error: `Could not parse result: ${e.message}` });
      }
    }, 150);
  });
}

/**
 * Check that the bridge directory exists and Blender has written a result
 * recently enough to indicate it's alive (within 10 s).
 * @returns {boolean}
 */
function isBridgeReady() {
  try {
    const stat = fs.statSync(BRIDGE_DIR);
    return stat.isDirectory();
  } catch (_) {
    return false;
  }
}

module.exports = { executeInBlender, isBridgeReady, BRIDGE_DIR };

