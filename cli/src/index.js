'use strict';

/**
 * blender-cli interactive REPL
 *
 * Usage: blender-cli [--dry-run] [--no-launch] [--help]
 *
 * --dry-run    Generate code but do NOT send it to Blender
 * --no-launch  Skip auto-launching Blender (use if Blender is already open)
 * --help       Show help
 *
 * ENV: BLENDER_PATH – full path to blender executable
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { getCopilotResponse, getCopilotResponseStream, planAssets, discoverModel } = require('./copilot');
const { ASSET_ROOT, downloadAssets } = require('./assets');
const {
  executeInBlender,
  isBlenderRunning,
  findBlenderExecutable,
  launchBlender,
  waitForBlender,
  sessionPaths,
  BRIDGE_BASE,
} = require('./blender');

function parseArgs(argv) {
  const args = { dryRun: false, noLaunch: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run')   args.dryRun = true;
    if (a === '--no-launch') args.noLaunch = true;
    if (a === '--help')      args.help = true;
  }
  return args;
}

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
};
const fmt = (color, text) => `${color}${text}${c.reset}`;

const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function spinner(label) {
  let i = 0, cur = label;
  const id = setInterval(() => {
    process.stdout.write(`\r${fmt(c.cyan, FRAMES[i++ % FRAMES.length])} ${cur}  `);
  }, 80);
  return {
    update: (l) => { cur = l; },
    stop: (suffix = '') => { clearInterval(id); process.stdout.write(`\r${' '.repeat(cur.length + 4)}\r${suffix}\n`); },
  };
}

function printHelp() {
  console.log(`
${fmt(c.bold + c.cyan, 'blender-cli')} — edit your Blender scene with natural language

${fmt(c.bold, 'USAGE')}
  blender-cli [--dry-run] [--no-launch] [--help]

${fmt(c.bold, 'OPTIONS')}
  --dry-run    Generate code but do NOT send to Blender
  --no-launch  Skip auto-launching Blender
  --help       Show this help

${fmt(c.bold, 'ENV VARS')}
  BLENDER_PATH  Full path to the Blender executable (if not auto-detected)
  ASSET_PATH    Asset library folder (default: ~/.blender-copilot/assets/)
                Models stored in <ASSET_PATH>/models/
                Textures stored in <ASSET_PATH>/textures/

${fmt(c.bold, 'REPL COMMANDS')}
  /undo        Undo the last operation in Blender
  /clear       Delete all mesh objects in the scene
  /history     Show prompts used in this session
  /quit        Exit

${fmt(c.bold, 'EXAMPLE PROMPTS')}
  delete the default cube
  add a blue torus at position (2, 0, 1)
  rotate the active object 45 degrees on the Z axis
  set the world background to dark navy blue
  add a three-point lighting setup for product rendering
  apply a glossy red material to every mesh in the scene
  put a Stanford bunny on a table. Download the 3D .obj if necessary.
  create an outdoor scene with a sunny sky HDRI and marble floor texture
`);
}

const BUILTIN_COMMANDS = {
  '/undo': `bpy.ops.ed.undo()`,
  '/clear': `bpy.ops.object.select_all(action='DESELECT')
bpy.ops.object.select_by_type(type='MESH')
bpy.ops.object.delete()`,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  console.log(`\n${fmt(c.bold + c.cyan, '🎨 Blender CLI')}`);
  console.log(fmt(c.dim, 'Type a natural language prompt, /help for commands, or Ctrl+C to quit.\n'));
  console.log(fmt(c.dim, `  Asset library: ${ASSET_ROOT}`));
  console.log(fmt(c.dim, `  (Override with env: ASSET_PATH)\n`));

  // ── Blender auto-launch ────────────────────────────────────────────────
  // sessionPaths is set when Blender is launched by this CLI invocation.
  // It is null in dry-run or --no-launch mode.
  let blenderPaths = null;

  if (!args.dryRun) {
    if (!args.noLaunch) {
      const blenderPath = findBlenderExecutable();
      if (!blenderPath) {
        console.log(fmt(c.yellow, '⚠ Blender not found automatically.'));
        console.log(fmt(c.dim,   '  Set BLENDER_PATH to the blender executable, then re-run.'));
        console.log(fmt(c.dim,   '  Example: $env:BLENDER_PATH = "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe"\n'));
      } else {
        const blenderName = path.basename(path.dirname(blenderPath));
        console.log(fmt(c.dim, `  Found: ${blenderPath}`));
        const launched = launchBlender(blenderPath);
        blenderPaths = launched.paths;
        console.log(fmt(c.dim, `  Session: ${launched.sessionId}`));
        console.log(fmt(c.dim, `  Log: ${launched.paths.logFile}`));
        const spin = spinner(`Launching ${blenderName}…`);

        // Race: either heartbeat appears (success) or Blender exits early (crash)
        const [ready, exitCode] = await Promise.all([
          waitForBlender(blenderPaths.heartbeatFile, 45000),
          launched.earlyExit,
        ]);

        if (exitCode !== null && exitCode !== 0) {
          // Blender exited within 5 s — read the log for clues
          let logSnippet = '';
          try {
            const log = fs.readFileSync(blenderPaths.logFile, 'utf8').trim();
            const lines = log.split('\n');
            logSnippet = '\n' + lines.slice(-10).map((l) => '    ' + l).join('\n');
          } catch (_) {}
          spin.stop(fmt(c.red, `✖ Blender exited immediately (code ${exitCode})`));
          console.log(fmt(c.dim, `  Check the log for details: ${blenderPaths.logFile}`));
          if (logSnippet) console.log(fmt(c.dim, logSnippet));
          blenderPaths = null;
        } else if (!ready) {
          spin.stop(fmt(c.yellow, '⚠ Blender is taking longer than expected — proceeding anyway'));
          console.log(fmt(c.dim, `  If Blender never opens, check: ${blenderPaths.logFile}`));
        } else {
          spin.stop(fmt(c.green, '✔ Blender is ready'));
        }
        console.log('');
      }
    } else {
      console.log(fmt(c.dim, `  --no-launch: send commands to any Blender with the addon enabled.`));
      console.log(fmt(c.dim, `  Session directory: ${BRIDGE_BASE}\n`));
    }

    // Pre-warm model discovery so the first prompt is fast
    try {
      const model = await discoverModel();
      console.log(fmt(c.dim, `  Copilot model: ${model}\n`));
    } catch (e) {
      console.log(fmt(c.yellow, `  ⚠ Copilot auth warning: ${e.message}\n`));
    }
  } else {
    console.log(fmt(c.yellow, '  [dry-run] Code will be printed but not sent to Blender.\n'));
  }

  // ── REPL ──────────────────────────────────────────────────────────────
  const history = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt(c.bold + c.blue, '▶ '),
  });

  rl.prompt();

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    rl.pause();

    if (!line) { rl.resume(); rl.prompt(); return; }

    if (line === '/help')    { printHelp(); rl.resume(); rl.prompt(); return; }
    if (line === '/history') {
      if (!history.length) console.log(fmt(c.dim, '  (no history yet)'));
      else history.forEach(({ prompt }, i) => console.log(`  ${fmt(c.dim, `${i + 1}.`)} ${prompt}`));
      rl.resume(); rl.prompt(); return;
    }
    if (line === '/quit' || line === '/exit') { rl.close(); return; }

    let code;
    let thinking = null;
    let assetDict = {};

    if (BUILTIN_COMMANDS[line]) {
      code = BUILTIN_COMMANDS[line];
      console.log(fmt(c.dim, '  [built-in command]'));
    } else {
      // ── Step 1: detect & download assets ──────────────────────────────────
      const spin = spinner('Thinking...');
      try {
        const assetList = await planAssets(line);
        if (assetList.length > 0) {
          const labels = assetList.map((a) => `${a.key}(${a.type})`).join(', ');
          spin.update(`Downloading assets: ${labels}...`);
          assetDict = await downloadAssets(assetList, (msg) => spin.update(msg));
        }

        // ── Step 2: generate code with streaming thinking ──────────────────
        spin.update('Asking GitHub Copilot...');

        // Set up live thinking display.
        // We stop the spinner just before printing thinking lines so the
        // animated cursor doesn't interleave with streaming text.
        const border = fmt(c.dim, '─'.repeat(60));
        let thinkingHeaderPrinted = false;

        const response = await getCopilotResponseStream(line, history, { assetDict }, {
          onThinkingStart() {
            spin.stop(fmt(c.green, '✔ Code generated'));
            process.stdout.write(`\n${fmt(c.bold, '💭 Reasoning:')}\n${border}\n`);
            thinkingHeaderPrinted = true;
          },
          onThinkingLine(thinkLine) {
            process.stdout.write('  ' + fmt(c.dim, thinkLine) + '\n');
          },
          onThinkingEnd() {
            process.stdout.write(border + '\n');
          },
        });
        thinking = response.thinking;
        code = response.code;
        // If no thinking was streamed, stop the spinner now
        if (!thinkingHeaderPrinted) {
          spin.stop(fmt(c.green, '✔ Code generated'));
        }
      } catch (err) {
        spin.stop(fmt(c.red, `✖ Copilot error: ${err.message}`));
        rl.resume(); rl.prompt(); return;
      }
    }

    // ── Detect non-Python prose response ─────────────────────────────────────
    // If the model returned a plain-language response instead of Python code
    // (e.g. because it couldn't see an image), display it and skip execution.
    const looksLikePython = /^\s*(import |from |bpy\.|#|def |class |\w+ *=)/m.test(code);
    if (!looksLikePython) {
      console.log(`\n${fmt(c.bold, '💬 Copilot response:')}`);
      const border = fmt(c.dim, '─'.repeat(60));
      console.log(border);
      code.split('\n').forEach(l => console.log('  ' + fmt(c.cyan, l)));
      console.log(border + '\n');
      rl.resume(); rl.prompt(); return;
    }

    console.log(`\n${fmt(c.bold, '📝 Generated code:')}`);
    const border = fmt(c.dim, '─'.repeat(60));
    console.log(border);
    code.split('\n').forEach(l => console.log('  ' + fmt(c.magenta, l)));
    console.log(border + '\n');

    if (args.dryRun) {
      console.log(fmt(c.yellow, '  [dry-run] Skipping Blender execution.\n'));
      history.push({ prompt: line, code });
      rl.resume(); rl.prompt(); return;
    }

    if (!blenderPaths) {
      console.log(fmt(c.yellow, '  ⚠ No paired Blender session — use --no-launch only when\n' +
        '    Blender with the addon is already open and you want to target it manually.\n'));
      rl.resume(); rl.prompt(); return;
    }

    const spin2 = spinner('Updating Blender scene...');
    try {
      // Inject ASSET_DIR (the folder root) and ASSETS (key→absPath dict) into
      // every execution.  ASSET_DIR is intentionally named "DIR" so Copilot
      // never mistakes it for a single-file path.  ASSET_PATH is kept as a
      // backward-compat alias pointing to the same directory.
      const assetPathEsc = ASSET_ROOT.replace(/\\/g, '/');
      const assetsLiteral = Object.entries(assetDict)
        .map(([k, v]) => `  '${k}': r'${v.replace(/\\/g, '/')}'`)
        .join(',\n');
      const preamble =
        `import os, math, mathutils\n` +
        `ASSET_DIR = r'${assetPathEsc}'\n` +
        `ASSET_PATH = ASSET_DIR  # alias kept for compatibility\n` +
        `ASSETS = {\n${assetsLiteral}\n}\n`;
      const execCode = preamble + code;
      const result = await executeInBlender(execCode, blenderPaths);
      if (result.success) {
        spin2.stop(fmt(c.green, '✔ Scene updated'));
        history.push({ prompt: line, code });
      } else {
        spin2.stop(fmt(c.red, `✖ Blender error: ${result.error ?? 'unknown'}`));
      }
    } catch (err) {
      spin2.stop(fmt(c.red, `✖ ${err.message}`));
    }

    console.log('');
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${fmt(c.dim, 'Goodbye! 👋')}\n`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error(fmt('\x1b[31m', `Fatal: ${err.message}`));
  process.exit(1);
});
