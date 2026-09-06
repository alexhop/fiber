/**
 * Configuration, path resolution and safety rails.
 *
 * Everything is platform-neutral: paths go through node:path, and the data
 * directory is resolved relative to the repo rather than to any OS-specific
 * location, so the same checkout behaves identically on Windows and Linux.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.FIBER_DATA_DIR
  ? path.resolve(process.env.FIBER_DATA_DIR)
  : path.join(ROOT, 'data');

export function ensureDataDir(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export interface Config {
  /** Modem address, e.g. 192.168.0.1 */
  host: string;
  username?: string;
  password?: string;
  /** Seconds between samples in monitor mode. */
  intervalSec: number;
  /** Port for the local dashboard. */
  port: number;
  timeoutMs: number;
  /** Warn below this received-power level (dBm). */
  warnRxDbm: number;
  /** Treat as failure below this received-power level (dBm). */
  critRxDbm: number;
}

export const DEFAULTS: Config = {
  host: '192.168.0.1',
  intervalSec: 30,
  port: 8477,
  timeoutMs: 8000,
  // GPON receivers are typically specified down to about -27 dBm; below -28 a
  // link is marginal, and below -30 it will not stay up. These are the
  // thresholds the earlier diagnosis used, expressed as config rather than
  // hardcoded, since XGS-PON budgets differ.
  warnRxDbm: -25,
  critRxDbm: -28,
};

const CONFIG_FILE = path.join(ROOT, 'fiber.config.json');

/**
 * Refuse to point this tool at anything outside the local network.
 *
 * The HTTP client deliberately accepts self-signed certificates, which is safe
 * against a modem on a cable in front of you and unsafe against anything else.
 * Enforcing a private-address rule here means that decision cannot leak.
 */
export function assertPrivateHost(host: string): void {
  const bare = host.replace(/^\[|\]$/g, '').split(':')[0];
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127); // CGNAT, where some ONT mgmt lives
    if (!isPrivate) {
      throw new Error(
        'Refusing to target ' + host + ': not a private address. This client ' +
        'accepts self-signed certificates and is only safe on the local network.',
      );
    }
    return;
  }
  if (bare === 'localhost' || bare.endsWith('.local') || /^fe80:/i.test(bare) || /^fd[0-9a-f]{2}:/i.test(bare)) {
    return;
  }
  throw new Error('Refusing to target ' + host + ': expected a private IPv4 address or .local name.');
}

/** Merge defaults, an optional fiber.config.json, env vars, then CLI flags. */
export function loadConfig(flags: Record<string, string | boolean> = {}): Config {
  let fromFile: Partial<Config> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    } catch (e) {
      throw new Error('fiber.config.json is not valid JSON: ' + (e as Error).message);
    }
  }

  const fromEnv: Partial<Config> = {};
  if (process.env.FIBER_HOST) fromEnv.host = process.env.FIBER_HOST;
  // Credentials belong in the environment, not in a file that could be committed.
  if (process.env.FIBER_USER) fromEnv.username = process.env.FIBER_USER;
  if (process.env.FIBER_PASS) fromEnv.password = process.env.FIBER_PASS;

  const fromFlags: Partial<Config> = {};
  if (typeof flags.host === 'string') fromFlags.host = flags.host;
  if (typeof flags.user === 'string') fromFlags.username = flags.user;
  if (typeof flags.pass === 'string') fromFlags.password = flags.pass;
  if (typeof flags.interval === 'string') fromFlags.intervalSec = Number(flags.interval);
  if (typeof flags.port === 'string') fromFlags.port = Number(flags.port);
  if (typeof flags.timeout === 'string') fromFlags.timeoutMs = Number(flags.timeout);

  const cfg: Config = { ...DEFAULTS, ...fromFile, ...fromEnv, ...fromFlags };
  assertPrivateHost(cfg.host);
  return cfg;
}

/** Tiny argv parser: supports --key value, --key=value, and bare --flag. */
export function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (!command) {
      command = arg;
    } else {
      rest.push(arg);
    }
  }
  return { command, flags, rest };
}
