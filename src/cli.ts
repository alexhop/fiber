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
import { runMonitor } from './monitor.ts';
import { takeSample, classify } from './sample.ts';
import { ModemClient } from './api.ts';
import { serve } from './server.ts';

const USAGE = `
fiber-monitor -- direct diagnostics for a Quantum Fiber / GPON ONT

  node src/cli.ts <command> [options]

Commands
  setup             Store the modem address and admin credentials permanently
                    in fiber.config.json (gitignored, owner-readable only).
  discover          Fingerprint the modem and map every endpoint it exposes.
                    Writes a full JSON report to data/ and prints a summary.
  status            Log in and print one snapshot of the fibre link.
  monitor           Poll continuously, appending to data/samples.jsonl.
  serve             Poll and serve a live dashboard on http://localhost:8477.
  probe <path>      Fetch one path and print status, headers and body.
  help              This message.

Options
  --host <ip>       Modem address              (default 192.168.0.1)
  --user <name>     Admin username             (or env FIBER_USER)
  --pass <secret>   Admin password             (or env FIBER_PASS)
  --timeout <ms>    Per-request timeout        (default 8000)
  --interval <sec>  monitor: seconds between samples   (default 30)
  --count <n>       monitor: stop after n samples
  --port <n>        serve: dashboard port              (default 8477)
  --bind <addr>     serve: interface to listen on      (default 127.0.0.1)
  --no-poll         serve: display the existing log without contacting the modem
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

async function cmdStatus(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig(flags);
  const client = new ModemClient(cfg);
  const sample = await takeSample(client);
  const verdict = classify(sample, cfg);

  // One-shot command, so release the session rather than leaving it open on the
  // device. The long-running commands deliberately keep theirs and reuse it.
  await client.logout().catch(() => undefined);

  if (!sample.reachable) {
    console.error('Could not read the modem: ' + sample.error);
    return 1;
  }

  const rows: Array<[string, string]> = [
    ['optical status', sample.opticalStatus ?? '--'],
    ['rx power', sample.rxDbm === null ? 'no reading' : sample.rxDbm.toFixed(2) + ' dBm'],
    ['tx power', sample.txDbm === null ? 'no reading' : sample.txDbm.toFixed(2) + ' dBm'],
    ['transceiver', sample.transceiverVendor ?? 'not reporting'],
    ['temperature', sample.temperature === null ? '--' : sample.temperature + ' C'],
    ['bias current', sample.biasCurrent === null ? '--' : String(sample.biasCurrent)],
    ['OLT vendor', sample.oltVendor ?? 'not reached'],
    ['FSAN / PON id', sample.fsan ?? '--'],
    ['line status', sample.lineStatus ?? '--'],
    ['link uptime', sample.linkUpTimeSec === null ? '--' : String(sample.linkUpTimeSec) + 's'],
    ['conn failures 24h', String(sample.connectionFailures24h ?? '--')],
    ['device uptime', sample.uptimeSec === null ? '--' : String(sample.uptimeSec) + 's'],
    ['reboots 24h', String(sample.rebootCount24h ?? '--')],
    ['reboots 7d', String(sample.rebootCount7d ?? '--')],
    ['query latency', String(sample.latencyMs) + ' ms'],
  ];
  for (const [k, v] of rows) console.log('  ' + k.padEnd(20) + v);

  console.log('');
  console.log('  health: ' + verdict.health);
  for (const r of verdict.reasons) console.log('    - ' + r);
  return 0;
}

async function cmdMonitor(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig(flags);
  const count = typeof flags.count === 'string' ? Number(flags.count) : undefined;
  if (count !== undefined && (!Number.isFinite(count) || count < 1)) {
    console.error('--count must be a positive integer');
    return 2;
  }
  await runMonitor({ cfg, count });
  return 0;
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig(flags);
  const bind = typeof flags.bind === 'string' ? flags.bind : '127.0.0.1';
  serve({ cfg, bind, poll: flags['no-poll'] !== true });
  // Hold the process open; the server and its polling loop own the event loop.
  await new Promise<void>(() => {});
  return 0;
}

async function main(): Promise<void> {
  const { command, flags, rest } = parseArgs(process.argv.slice(2));

  let code = 0;
  try {
    switch (command) {
      case 'setup':
        code = await runSetup();
        break;
      case 'status':
        code = await cmdStatus(flags);
        break;
      case 'monitor':
        code = await cmdMonitor(flags);
        break;
      case 'serve':
        code = await cmdServe(flags);
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
