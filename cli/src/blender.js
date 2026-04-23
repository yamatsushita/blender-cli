'use strict';

/**
 * Blender HTTP bridge client.
 * Communicates with the Copilot CLI Bridge addon running inside Blender.
 */

const http = require('http');

/**
 * Check if the Blender bridge is reachable.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function checkBlenderStatus(host, port) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/status', method: 'GET', timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Send Python code to the Blender bridge for execution.
 * @param {string} code - Python code to execute in Blender
 * @param {string} host
 * @param {number} port
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function executeInBlender(code, host = '127.0.0.1', port = 5123) {
  const payload = JSON.stringify({ code });

  return new Promise((resolve, reject) => {
    const options = {
      host,
      port,
      path: '/execute',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 35000,
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (_) {
          resolve({ success: res.statusCode === 200, message: 'done' });
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Cannot reach Blender bridge: ${err.message}\nMake sure the addon server is started inside Blender.`));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Blender bridge timed out (30 s). The code may still be running.'));
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { checkBlenderStatus, executeInBlender };
