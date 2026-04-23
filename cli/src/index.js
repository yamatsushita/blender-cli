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
const { getCopilotCode, discoverModel } = require('./copilot');
const {
  executeInBlender,
  isBlenderRunning,
  findBlenderExecutable,
  launchBlender,
  waitForBlender,
  BRIDGE_DIR,
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
`);
}

const BUILTIN_COMMANDS = {
  '/undo':  'import bpy\nbpy.ops.ed.undo()',
  '/clear': `import bpy
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.object.select_by_type(type='MESH')
bpy.ops.object.delete()`,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  console.log(`\n${fmt(c.bold + c.cyan, '🎨 Blender Copilot CLI')}`);
  console.log(fmt(c.dim, 'Type a natural language prompt, /help for commands, or Ctrl+C to quit.\n'));

  // ── Blender auto-launch ────────────────────────────────────────────────
  if (!args.dryRun) {
    if (isBlenderRunning()) {
      console.log(fmt(c.green, '✔ Blender bridge is already active\n'));
    } else if (!args.noLaunch) {
      const blenderPath = findBlenderExecutable();
      if (!blenderPath) {
        console.log(fmt(c.yellow, '⚠ Blender not found automatically.'));
        console.log(fmt(c.dim,   '  Set the BLENDER_PATH environment variable to the blender executable, then re-run.'));
        console.log(fmt(c.dim,   '  Example: $env:BLENDER_PATH = "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe"\n'));
      } else {
        const blenderName = path.basename(path.dirname(blenderPath));
        console.log(fmt(c.dim, `  Found: ${blenderPath}`));
        launchBlender(blenderPath);
        const spin = spinner(`Launching ${blenderName}…`);
        const ready = await waitForBlender(45000);
        spin.stop(ready
          ? fmt(c.green, `✔ Blender is ready`)
          : fmt(c.yellow, '⚠ Blender is taking longer than expected — proceeding anyway')
        );
        console.log('');
      }
    } else {
      console.log(fmt(c.dim, `  Bridge dir: ${BRIDGE_DIR}`));
      console.log(fmt(c.dim, '  Waiting for Blender with the "Copilot CLI Bridge" addon enabled.\n'));
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
    if (BUILTIN_COMMANDS[line]) {
      code = BUILTIN_COMMANDS[line];
      console.log(fmt(c.dim, '  [built-in command]'));
    } else {
      const spin = spinner('Asking GitHub Copilot…');
      try {
        code = await getCopilotCode(line, history);
        spin.stop(fmt(c.green, '✔ Code generated'));
      } catch (err) {
        spin.stop(fmt(c.red, `✖ Copilot error: ${err.message}`));
        rl.resume(); rl.prompt(); return;
      }
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

    const spin2 = spinner('Updating Blender scene…');
    try {
      const result = await executeInBlender(code);
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
