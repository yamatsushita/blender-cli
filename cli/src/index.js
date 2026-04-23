'use strict';

/**
 * blender-copilot – interactive CLI entry point.
 *
 * Usage:
 *   blender-copilot [--port 5123] [--host 127.0.0.1] [--dry-run]
 *
 * Flags:
 *   --port   Port where the Blender Copilot Bridge addon is listening (default: 5123)
 *   --host   Host of the Blender instance (default: 127.0.0.1)
 *   --dry-run  Print generated code but do NOT send it to Blender
 *   --help   Show help
 */

const readline = require('readline');
const { getCopilotCode } = require('./copilot');
const { checkBlenderStatus, executeInBlender } = require('./blender');

// ---------------------------------------------------------------------------
// Simple arg parsing (no extra deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { port: 5123, host: '127.0.0.1', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port':    args.port = parseInt(argv[++i], 10); break;
      case '--host':    args.host = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help':    args.help = true; break;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// ANSI colours (no chalk dependency required)
// ---------------------------------------------------------------------------
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
};
const fmt = (color, text) => `${color}${text}${c.reset}`;

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function spinner(label) {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${fmt(c.cyan, FRAMES[i++ % FRAMES.length])} ${label}  `);
  }, 80);
  return { stop: (suffix = '') => { clearInterval(id); process.stdout.write(`\r${suffix}\n`); } };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`
${fmt(c.bold + c.cyan, 'blender-copilot')} — edit your Blender scene with natural language

${fmt(c.bold, 'USAGE')}
  blender-copilot [options]

${fmt(c.bold, 'OPTIONS')}
  --port <n>   Port the Blender addon server is listening on  (default: 5123)
  --host <h>   Hostname of the Blender instance               (default: 127.0.0.1)
  --dry-run    Generate code but do NOT send to Blender
  --help       Show this help

${fmt(c.bold, 'REPL COMMANDS')}
  /undo        Run bpy.ops.ed.undo() in Blender
  /clear       Clear all mesh objects in the scene
  /history     Show the current session's prompt history
  /quit        Exit

${fmt(c.bold, 'EXAMPLE PROMPTS')}
  add a blue torus at position (2, 0, 1)
  rotate the selected object 45 degrees on the Z axis
  set the background color to a dark navy blue
  add three point lighting setup for product rendering
  apply a glossy red material to every object in the scene
`);
}

// ---------------------------------------------------------------------------
// Built-in REPL commands
// ---------------------------------------------------------------------------
const BUILTIN_COMMANDS = {
  '/undo':    'import bpy\nbpy.ops.ed.undo()',
  '/clear':   `import bpy
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.object.select_by_type(type='MESH')
bpy.ops.object.delete()`,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { printHelp(); process.exit(0); }

  console.log(`\n${fmt(c.bold + c.cyan, '🎨 Blender Copilot CLI')}`);
  console.log(fmt(c.dim, 'Type a natural language prompt, /help for commands, or Ctrl+C to quit.\n'));

  // Check Blender bridge connectivity
  if (!args.dryRun) {
    const spin = spinner(`Connecting to Blender bridge on ${args.host}:${args.port}…`);
    const ok = await checkBlenderStatus(args.host, args.port);
    if (ok) {
      spin.stop(fmt(c.green, `✔ Connected to Blender bridge at ${args.host}:${args.port}`));
    } else {
      spin.stop(fmt(c.yellow, `⚠ Blender bridge not found at ${args.host}:${args.port}`));
      console.log(fmt(c.dim,   '  Start the addon server inside Blender: View3D → Sidebar → Copilot → Start Server'));
      console.log(fmt(c.dim,   '  Continuing in offline mode (use --dry-run to suppress this warning)\n'));
    }
  } else {
    console.log(fmt(c.yellow, '  [dry-run mode] Code will be printed but not sent to Blender.\n'));
  }

  /** @type {Array<{prompt: string, code: string}>} */
  const history = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt(c.bold + c.blue, '▶ ') + fmt(c.bold, ''),
  });

  rl.prompt();

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    rl.pause();

    if (!line) { rl.resume(); rl.prompt(); return; }

    // Built-in REPL commands
    if (line === '/help') { printHelp(); rl.resume(); rl.prompt(); return; }
    if (line === '/history') {
      if (history.length === 0) {
        console.log(fmt(c.dim, '  (no history yet)'));
      } else {
        history.forEach(({ prompt }, i) =>
          console.log(`  ${fmt(c.dim, String(i + 1) + '.')} ${prompt}`)
        );
      }
      rl.resume(); rl.prompt(); return;
    }
    if (line === '/quit' || line === '/exit') { rl.close(); return; }

    let code;

    if (BUILTIN_COMMANDS[line]) {
      code = BUILTIN_COMMANDS[line];
      console.log(fmt(c.dim, `  [built-in command]`));
    } else {
      // Call Copilot to generate code
      const spin = spinner('Asking GitHub Copilot…');
      try {
        code = await getCopilotCode(line, history);
        spin.stop(fmt(c.green, '✔ Code generated'));
      } catch (err) {
        spin.stop(fmt(c.red, `✖ Copilot error: ${err.message}`));
        rl.resume(); rl.prompt(); return;
      }
    }

    // Always show the generated code
    console.log(`\n${fmt(c.bold, '📝 Generated code:')}`);
    const border = fmt(c.dim, '─'.repeat(60));
    console.log(border);
    code.split('\n').forEach((l) => console.log('  ' + fmt(c.magenta, l)));
    console.log(border + '\n');

    if (args.dryRun) {
      console.log(fmt(c.yellow, '  [dry-run] Skipping Blender execution.\n'));
      history.push({ prompt: line, code });
      rl.resume(); rl.prompt(); return;
    }

    // Send to Blender
    const spin2 = spinner('Sending to Blender…');
    try {
      const result = await executeInBlender(code, args.host, args.port);
      if (result.success) {
        spin2.stop(fmt(c.green, '✔ Scene updated in Blender'));
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

main().catch((err) => {
  console.error(fmt('\x1b[31m', `Fatal: ${err.message}`));
  process.exit(1);
});
