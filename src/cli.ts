#!/usr/bin/env node
/**
 * fiber-monitor -- entry point.
 *
 * Runs on Node 22.6+ with no dependencies and no build step: Node strips the
 * TypeScript types at load time. Identical behaviour on Windows and Linux.
 *
 *   node src/cli.ts discover
 *   node src/cli.ts probe /api/v1/status
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadConfig, ensureDataDir, DATA_DIR } from './config.ts';
import { discover, formatReport } from './discover.ts';
import { request, CookieJar } from './net.ts';
import { runSetup } from './setup.ts';

const USAGE = `
fiber-monitor -- direct diagnostics for a Quantum Fiber / GPON ONT

  node src/cli.ts <command> [options]

Commands
  setup             Store the modem address and admin credentials permanently
                    in fiber.config.json (gitignored, owner-readable only).
  discover          Fingerprint the modem and map every endpoint it exposes.
                    Writes a full JSON report to data/ and prints a summary.
  probe <path>      Fetch one path and print status, headers and body.
  help              This message.

Options
  --host <ip>       Modem address              (default 192.168.0.1)
  --user <name>     Admin username             (or env FIBER_USER)
  --pass <secret>   Admin password             (or env FIBER_PASS)
  --timeout <ms>    Per-request timeout        (default 8000)
  --assets-only     Skip the blind wordlist; only follow the UI's asset graph
  --raw             probe: print the entire body, not a preview

Credential precedence, lowest to highest:
  fiber.config.json  <  FIBER_HOST / FIBER_USER / FIBER_PASS  <  --flags

Run 'setup' once and the credentials persist across reboots and terminals on
both Windows and Linux. Use the environment only for a one-off override.
`.trimStart();

async function cmdDiscover(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig(flags);
  ensureDataDir();

  console.log('Scanning ' + cfg.host + ' -- this takes a minute or two.\n');

  const report = await discover({
    host: cfg.host,
    timeoutMs: cfg.timeoutMs,
    assetsOnly: flags['assets-only'] === true,
    onProgress: (m) => console.log('  ' + m),
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(DATA_DIR, 'discovery-' + stamp + '.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('\n' + formatReport(report));
  console.log('\nFull report: ' + outFile);

  if (!report.reachable) return 1;
  return 0;
}

async function cmdProbe(
  flags: Record<string, string | boolean>,
  rest: string[],
): Promise<number> {
  const cfg = loadConfig(flags);
  const target = rest[0];
  if (!target) {
    console.error('probe needs a path, e.g.  node src/cli.ts probe /api/v1/status');
    return 2;
  }

  const url = /^https?:\/\//i.test(target)
    ? target
    : 'https://' + cfg.host + (target.startsWith('/') ? target : '/' + target);

  const jar = new CookieJar();
  let res = await request(url, { jar, timeoutMs: cfg.timeoutMs });

  // The modem may only speak plain HTTP; fall back rather than reporting failure.
  if (res.error && url.startsWith('https://')) {
    console.log('https failed (' + res.error + '), retrying over http\n');
    res = await request(url.replace(/^https:/, 'http:'), { jar, timeoutMs: cfg.timeoutMs });
  }

  console.log(res.status + ' ' + res.statusText + '   ' + res.elapsedMs + 'ms   ' + res.bodyBytes + ' bytes');
  console.log('url: ' + res.url);
  if (res.error) console.log('error: ' + res.error);

  console.log('\n--- headers ---');
  for (const [k, v] of Object.entries(res.headers)) {
    console.log(k + ': ' + (Array.isArray(v) ? v.join(' | ') : v));
  }

  if (res.cert) {
    console.log('\n--- tls certificate ---');
    console.log(JSON.stringify(res.cert, null, 2));
  }

  console.log('\n--- body ---');
  const body = res.body;
  if (flags.raw === true || body.length <= 4000) {
    console.log(body);
  } else {
    console.log(body.slice(0, 4000));
    console.log('\n... truncated, ' + (body.length - 4000) + ' more chars. Use --raw for all of it.');
  }
  return res.status >= 200 && res.status < 400 ? 0 : 1;
}

async function main(): Promise<void> {
  const { command, flags, rest } = parseArgs(process.argv.slice(2));

  let code = 0;
  try {
    switch (command) {
      case 'setup':
        code = await runSetup();
        break;
      case 'discover':
        code = await cmdDiscover(flags);
        break;
      case 'probe':
        code = await cmdProbe(flags, rest);
        break;
      case '':
      case 'help':
        console.log(USAGE);
        break;
      default:
        console.error('Unknown command: ' + command + '\n');
        console.log(USAGE);
        code = 2;
    }
  } catch (e) {
    console.error('Error: ' + (e as Error).message);
    code = 1;
  }
  process.exitCode = code;
}

void main();
