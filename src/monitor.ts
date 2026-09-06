/**
 * The sampling loop and its on-disk log.
 *
 * Samples are appended as JSON Lines: one self-describing object per line,
 * append-only, and readable by anything. That matters more than a compact
 * binary format here, because the log's job is to survive an intermittent
 * fault overnight and still be greppable in the morning.
 *
 * The loop is deliberately conservative about the device. An embedded web
 * server with a handful of connection slots is easy to knock over -- doing so
 * during an outage investigation would destroy the very evidence being
 * gathered -- so requests are strictly serial and back off on failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ModemClient } from './api.ts';
import { takeSample, classify, type Sample, type Verdict } from './sample.ts';
import { ensureDataDir, DATA_DIR, type Config } from './config.ts';

export function logPath(): string {
  ensureDataDir();
  return path.join(DATA_DIR, 'samples.jsonl');
}

export function appendSample(sample: Sample, verdict: Verdict): void {
  const line = JSON.stringify({ ...sample, health: verdict.health, reasons: verdict.reasons });
  // Explicit \n rather than os.EOL: the log must parse identically whether it
  // was written on Windows or on Linux.
  fs.appendFileSync(logPath(), line + '\n', 'utf8');
}

/** Read the log back. Tolerates a truncated final line from an interrupted write. */
export function readSamples(limit?: number): Array<Sample & { health?: string; reasons?: string[] }> {
  const file = logPath();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const slice = limit ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partially written last line is expected if the process was killed.
    }
  }
  return out;
}

/** Compact one-line rendering for the terminal. */
export function formatSample(s: Sample, v: Verdict): string {
  const time = s.ts.slice(11, 19);
  const badge = { ok: 'OK  ', warn: 'WARN', critical: 'CRIT', unknown: '--  ' }[v.health];

  if (!s.reachable) return time + '  ' + badge + '  unreachable: ' + (s.error ?? '');

  const rx = s.rxDbm === null ? '   --  ' : (s.rxDbm.toFixed(2) + ' dBm').padStart(11);
  const tx = s.txDbm === null ? '   --  ' : (s.txDbm.toFixed(2) + ' dBm').padStart(11);
  const up = s.uptimeSec === null ? '--' : formatDuration(s.uptimeSec);

  return (
    time + '  ' + badge +
    '  optical=' + (s.opticalStatus ?? '--').padEnd(14) +
    ' rx=' + rx +
    ' tx=' + tx +
    ' up=' + up.padStart(9) +
    ' reboots24h=' + String(s.rebootCount24h ?? '--').padStart(3) +
    (v.reasons.length ? '   ' + v.reasons[0] : '')
  );
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm' + (seconds % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd' + (h % 24) + 'h';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MonitorOptions {
  cfg: Config;
  /** Stop after this many samples. Undefined means run until interrupted. */
  count?: number;
  onSample?: (s: Sample, v: Verdict) => void;
}

/**
 * Poll until interrupted.
 *
 * On a failed sample the interval is doubled, up to a ceiling, and restored on
 * the next success. During a reboot loop the device is unreachable for much of
 * each cycle, and retrying at full rate would add load exactly when the box is
 * least able to take it.
 */
export async function runMonitor(opts: MonitorOptions): Promise<void> {
  const { cfg } = opts;
  const client = new ModemClient(cfg);
  const baseInterval = Math.max(5, cfg.intervalSec) * 1000;
  const maxInterval = Math.max(baseInterval, 5 * 60 * 1000);

  let interval = baseInterval;
  let taken = 0;
  let running = true;

  const stop = (): void => {
    if (!running) return;
    running = false;
    console.log('\nStopping. Log: ' + logPath() + '  (' + taken + ' samples this run)');
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });

  console.log('Polling ' + cfg.host + ' every ' + cfg.intervalSec + 's. Ctrl-C to stop.');
  console.log('Log: ' + logPath() + '\n');

  while (running && (opts.count === undefined || taken < opts.count)) {
    const sample = await takeSample(client, cfg);
    const verdict = classify(sample, cfg);

    appendSample(sample, verdict);
    taken += 1;
    (opts.onSample ?? ((s, v) => console.log(formatSample(s, v))))(sample, verdict);

    if (sample.reachable) {
      interval = baseInterval;
    } else {
      interval = Math.min(interval * 2, maxInterval);
    }

    if (opts.count !== undefined && taken >= opts.count) break;
    await sleep(interval);
  }
}
