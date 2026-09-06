/**
 * Interactive credential setup.
 *
 * Writes fiber.config.json, which is gitignored. This is preferred over
 * environment variables for three reasons:
 *   - it survives reboots and new terminals without shell-profile edits;
 *   - it is identical on Windows and Linux, so the NUC deployment matches;
 *   - the password never appears in shell history or in `ps` output.
 *
 * The prompt masks input rather than echoing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, DEFAULTS, assertPrivateHost, type Config } from './config.ts';

const CONFIG_FILE = path.join(ROOT, 'fiber.config.json');

/** Prompt for a line of input, optionally masking each keystroke. */
function ask(question: string, opts: { mask?: boolean; fallback?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (opts.mask) {
      // readline writes the prompt itself; after that we suppress echo of the
      // typed characters by overriding the output stream's write for this
      // interface only. Backspace and Enter still need to pass through.
      const iface = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      let promptShown = false;
      iface._writeToOutput = (chunk: string) => {
        if (!promptShown) {
          iface.output.write(chunk);
          promptShown = true;
          return;
        }
        if (chunk.includes('\n') || chunk.includes('\r')) {
          iface.output.write('\n');
          return;
        }
        iface.output.write('*');
      };
    }

    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === '' && opts.fallback !== undefined ? opts.fallback : trimmed);
    });
  });
}

export async function runSetup(): Promise<number> {
  let existing: Partial<Config> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
      console.log('Updating existing ' + CONFIG_FILE + '\n');
    } catch {
      console.log('Existing config is unreadable; starting fresh.\n');
    }
  } else {
    console.log('Creating ' + CONFIG_FILE + '\n');
  }
  console.log('Press Enter to keep the value in [brackets].\n');

  const hostDefault = existing.host ?? DEFAULTS.host;
  const host = await ask('Modem address [' + hostDefault + ']: ', { fallback: hostDefault });
  try {
    assertPrivateHost(host);
  } catch (e) {
    console.error('\n' + (e as Error).message);
    return 1;
  }

  const userDefault = existing.username ?? 'admin';
  const username = await ask('Admin username [' + userDefault + ']: ', { fallback: userDefault });

  const hasPassword = typeof existing.password === 'string' && existing.password.length > 0;
  const password = await ask(
    'Admin password' + (hasPassword ? ' [unchanged]' : '') + ': ',
    { mask: true, fallback: hasPassword ? (existing.password as string) : '' },
  );

  const intervalDefault = String(existing.intervalSec ?? DEFAULTS.intervalSec);
  const intervalRaw = await ask('Sample interval in seconds [' + intervalDefault + ']: ', {
    fallback: intervalDefault,
  });
  const intervalSec = Number(intervalRaw);
  if (!Number.isFinite(intervalSec) || intervalSec < 1) {
    console.error('\nInterval must be a positive number of seconds.');
    return 1;
  }

  const config: Config = {
    ...DEFAULTS,
    ...existing,
    host,
    username,
    password,
    intervalSec,
  };

  // Write with owner-only permissions. This is enforced on Linux (the NUC) and
  // is a harmless no-op on Windows, where NTFS inheritance governs instead.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best effort; Windows may reject the mode */
  }

  console.log('\nSaved ' + CONFIG_FILE);
  console.log('This file is listed in .gitignore and will not be committed.');
  if (!password) {
    console.log('\nNote: no password was set. Endpoints behind the login will return 401/403.');
  }
  return 0;
}
