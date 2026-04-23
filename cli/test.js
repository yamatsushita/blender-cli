'use strict';

/**
 * Smoke tests for blender-copilot CLI
 * Run: node test.js
 *
 * Tests:
 *  1. Bridge directory setup
 *  2. Blender executable detection
 *  3. Heartbeat read/write + isBlenderRunning()
 *  4. File bridge write/poll round-trip (simulated Blender)
 *  5. Copilot model discovery
 *  6. Copilot code generation (simple prompt)
 *  7. Copilot code generation (multi-turn history)
 */

const assert = require('assert');
const fs = require('fs');

const {
  findBlenderExecutable,
  isBlenderRunning,
  sessionPaths,
  BRIDGE_BASE,
} = require('./src/blender');

const { discoverModel, getCopilotCode, resetModelCache } = require('./src/copilot');

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \x1b[31m✖\x1b[0m ${name}`);
    console.log(`      \x1b[2m${e.message}\x1b[0m`);
    failed++;
  }
}

async function main() {
  console.log('\n\x1b[1m🧪 blender-cli smoke tests\x1b[0m\n');

  // ── Environment ──────────────────────────────────────────────────────────
  console.log('\x1b[1mEnvironment\x1b[0m');

  await test('Bridge base directory is created on require', () => {
    assert(fs.existsSync(BRIDGE_BASE), `Not found: ${BRIDGE_BASE}`);
    assert(fs.statSync(BRIDGE_BASE).isDirectory());
  });

  await test('Blender executable detection', () => {
    const exe = findBlenderExecutable();
    if (exe) {
      assert(fs.existsSync(exe), `Reported path does not exist: ${exe}`);
      console.log(`      \x1b[2m→ ${exe}\x1b[0m`);
    } else {
      console.log(`      \x1b[2m→ Not found (set BLENDER_PATH env var to override)\x1b[0m`);
    }
    // Absence is acceptable — not an error
  });

  // ── File bridge ──────────────────────────────────────────────────────────
  console.log('\n\x1b[1mFile bridge\x1b[0m');

  // Use a fixed test session ID so we can clean up predictably
  const TEST_SESSION = 'test-session-' + process.pid;
  const p = sessionPaths(TEST_SESSION);
  fs.mkdirSync(p.dir, { recursive: true });

  await test('sessionPaths creates correct file paths', () => {
    assert(p.dir.endsWith(TEST_SESSION), 'dir should end with session ID');
    assert(p.heartbeatFile.includes(TEST_SESSION), 'heartbeatFile should be session-scoped');
    assert(p.triggerFile.includes(TEST_SESSION), 'triggerFile should be session-scoped');
    assert(p.resultFile.includes(TEST_SESSION), 'resultFile should be session-scoped');
    // Two different sessions must have different paths
    const p2 = sessionPaths('other-session');
    assert(p.dir !== p2.dir, 'Two sessions should have different directories');
  });

  await test('Heartbeat detection (fresh)', () => {
    fs.writeFileSync(p.heartbeatFile, String(Date.now() / 1000), 'utf8');
    assert(isBlenderRunning(p.heartbeatFile), 'Fresh heartbeat should be detected as running');
    fs.unlinkSync(p.heartbeatFile);
  });

  await test('Heartbeat detection (stale)', () => {
    fs.writeFileSync(p.heartbeatFile, String(Date.now() / 1000 - 10), 'utf8');
    assert(!isBlenderRunning(p.heartbeatFile), 'Stale heartbeat should not be detected as running');
    fs.unlinkSync(p.heartbeatFile);
  });

  await test('Write code and trigger files', () => {
    const rid = 'test-write-' + Date.now();
    const code = 'import bpy\nprint("hello from test")';

    try { fs.unlinkSync(p.triggerFile); } catch (_) {}
    try { fs.unlinkSync(p.codeFile); } catch (_) {}

    fs.writeFileSync(p.codeFile, code, 'utf8');
    fs.writeFileSync(p.triggerFile, rid, 'utf8');

    assert.strictEqual(fs.readFileSync(p.codeFile, 'utf8'), code);
    assert.strictEqual(fs.readFileSync(p.triggerFile, 'utf8'), rid);

    try { fs.unlinkSync(p.triggerFile); } catch (_) {}
    try { fs.unlinkSync(p.codeFile); } catch (_) {}
  });

  await test('Full file bridge round-trip (simulated Blender)', async () => {
    const rid = 'test-roundtrip-' + Date.now();
    const code = 'import bpy\nprint("roundtrip")';

    try { fs.unlinkSync(p.resultFile); } catch (_) {}
    fs.writeFileSync(p.codeFile, code, 'utf8');
    fs.writeFileSync(p.triggerFile, rid, 'utf8');

    // Simulate Blender responding after 300 ms in the session directory
    setTimeout(() => {
      fs.writeFileSync(p.resultFile, JSON.stringify({ id: rid, success: true }), 'utf8');
    }, 300);

    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const iv = setInterval(() => {
        if (fs.existsSync(p.resultFile)) {
          clearInterval(iv);
          try {
            const r = JSON.parse(fs.readFileSync(p.resultFile, 'utf8'));
            assert.strictEqual(r.id, rid, 'Result ID mismatch');
            assert.strictEqual(r.success, true, 'Expected success:true');
            resolve();
          } catch (e) { reject(e); }
        } else if (Date.now() > deadline) {
          clearInterval(iv);
          reject(new Error('Polling timed out'));
        }
      }, 100);
    });
  });

  await test('Session isolation: two sessions do not share files', async () => {
    const pA = sessionPaths('isolation-test-A');
    const pB = sessionPaths('isolation-test-B');
    fs.mkdirSync(pA.dir, { recursive: true });
    fs.mkdirSync(pB.dir, { recursive: true });

    fs.writeFileSync(pA.codeFile, 'code for A', 'utf8');
    fs.writeFileSync(pB.codeFile, 'code for B', 'utf8');

    assert.strictEqual(fs.readFileSync(pA.codeFile, 'utf8'), 'code for A');
    assert.strictEqual(fs.readFileSync(pB.codeFile, 'utf8'), 'code for B');

    // Simulate B's Blender writing a result — A should not see it
    const ridB = 'rid-B';
    fs.writeFileSync(pB.resultFile, JSON.stringify({ id: ridB, success: true }), 'utf8');
    assert(!fs.existsSync(pA.resultFile), 'A should not see B\'s result file');

    // Clean up
    fs.rmSync(pA.dir, { recursive: true, force: true });
    fs.rmSync(pB.dir, { recursive: true, force: true });
  });

  // Clean up test session dir
  fs.rmSync(p.dir, { recursive: true, force: true });

  // ── Copilot API ──────────────────────────────────────────────────────────
  console.log('\n\x1b[1mCopilot API\x1b[0m');

  await test('Model discovery returns a string', async () => {
    resetModelCache(); // force a fresh /models query
    const model = await discoverModel();
    assert(model && typeof model === 'string', 'Expected a non-empty string model ID');
    console.log(`      \x1b[2m→ ${model}\x1b[0m`);
  });

  await test('Code generation — simple prompt', async () => {
    const code = await getCopilotCode('add a default cube at the origin');
    assert(code && code.length > 10, 'Response too short');
    assert(code.includes('bpy'), 'Generated code should use bpy');
    assert(!code.startsWith('```'), 'Code fences should be stripped');
    console.log(`      \x1b[2m→ ${code.split('\n').length} lines\x1b[0m`);
    console.log(code.split('\n').slice(0, 3).map(l => `        \x1b[2m${l}\x1b[0m`).join('\n'));
  });

  await test('Code generation — multi-turn history', async () => {
    const history = [
      { prompt: 'add a red cube', code: 'import bpy\nbpy.ops.mesh.primitive_cube_add()\nobj = bpy.context.active_object\nmat = bpy.data.materials.new("Red")\nmat.diffuse_color = (1,0,0,1)\nobj.data.materials.append(mat)' },
    ];
    const code = await getCopilotCode('now make it blue instead', history);
    assert(code && code.includes('bpy'), 'Expected bpy code');
    console.log(`      \x1b[2m→ ${code.split('\n').length} lines\x1b[0m`);
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = passed + failed;
  const color = failed === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`${color}${passed}/${total} passed\x1b[0m${failed > 0 ? `  \x1b[31m(${failed} failed)\x1b[0m` : ''}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\x1b[31mFatal: ${err.message}\x1b[0m`);
  process.exit(1);
});
