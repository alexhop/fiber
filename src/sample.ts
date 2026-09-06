/**
 * Collecting one observation of the fibre link.
 *
 * Field choice is driven by what the Q1000K actually reports (discovered by
 * reading the management UI's own bundles), not by what TR-181 says it should:
 *
 *   Device.Optical.Interface.1.        Status, optical power, transceiver DDM
 *   Device.Optical.Interface.1.Stats.  error and byte counters
 *   Device.DeviceInfo                  uptime and reboot counters
 *
 * The reboot counters matter as much as the light levels. A box that restarts
 * every few minutes zeroes its own statistics, so a monitor that only watched
 * optical power would see a permanently healthy-looking set of fresh counters
 * and miss the actual fault.
 */
import { ModemClient, num, dbm, type ObjectMap } from './api.ts';
import type { Config } from './config.ts';

export interface Sample {
  /** ISO 8601, UTC. */
  ts: string;
  reachable: boolean;
  /** Round-trip time of the data query, in milliseconds. */
  latencyMs: number | null;

  // --- device ---
  uptimeSec: number | null;
  rebootCount24h: number | null;
  rebootCount7d: number | null;
  /** Certificate validFrom: this firmware mints one per factory reset. */
  certValidFrom: string | null;
  cpuUsage: number | null;
  memFreeKb: number | null;

  // --- optical ---
  /** TR-181 Status: Up, Down, Dormant, NotPresent, LowerLayerDown, Error. */
  opticalStatus: string | null;
  /** Received optical power, dBm. Null when the device reports no reading. */
  rxDbm: number | null;
  /** Transmitted optical power, dBm. */
  txDbm: number | null;
  /** Transceiver diagnostics. All null/zero implies the module is unreadable. */
  temperature: number | null;
  voltage: number | null;
  biasCurrent: number | null;
  transceiverVendor: string | null;
  transceiverModel: string | null;
  /** Populated only once an OLT has been reached. */
  oltVendor: string | null;
  oltModel: string | null;
  /** The PON identity the OLT authenticates. */
  fsan: string | null;

  // --- link ---
  lineStatus: string | null;
  linkUpTimeSec: number | null;
  connectionFailures: number | null;
  connectionFailures24h: number | null;
  downstreamRateKbps: number | null;
  upstreamRateKbps: number | null;

  // --- counters ---
  bytesReceived: number | null;
  bytesSent: number | null;
  errorsReceived: number | null;
  errorsSent: number | null;
  bipErrors: number | null;
  erroredSecs: number | null;
  severelyErroredSecs: number | null;

  /** Present when the sample could not be taken. */
  error?: string;
}

const OPTICAL = 'Device.Optical.Interface.1.';
const OPTICAL_STATS = 'Device.Optical.Interface.1.Stats.';
const TRANSCEIVER = 'Device.Optical.Interface.1.X_CTL_OpticalTransceiver.';
// Field filters keep the response small. Without them the firmware returns
// every child object of DeviceInfo, including 269 logger entries, on every poll.
const DEVICE_INFO_Q =
  'Device.DeviceInfo&UpTime=&X_CTL_RebootCount24Hours=&X_CTL_RebootCount7Days=' +
  '&SerialNumber=&ModelName=&SoftwareVersion=&HardwareVersion=&Manufacturer=';
const DEVICE_INFO = 'Device.DeviceInfo.';

/** Empty strings are how this firmware says "unknown"; normalise them to null. */
function str(fields: Record<string, string> | undefined, name: string): string | null {
  const v = fields?.[name];
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function emptySample(ts: string, error: string): Sample {
  return {
    ts, reachable: false, latencyMs: null,
    uptimeSec: null, rebootCount24h: null, rebootCount7d: null,
    certValidFrom: null, cpuUsage: null, memFreeKb: null,
    opticalStatus: null, rxDbm: null, txDbm: null,
    temperature: null, voltage: null, biasCurrent: null,
    transceiverVendor: null, transceiverModel: null,
    oltVendor: null, oltModel: null, fsan: null,
    lineStatus: null, linkUpTimeSec: null,
    connectionFailures: null, connectionFailures24h: null,
    downstreamRateKbps: null, upstreamRateKbps: null,
    bytesReceived: null, bytesSent: null,
    errorsReceived: null, errorsSent: null,
    bipErrors: null, erroredSecs: null, severelyErroredSecs: null,
    error,
  };
}

export function buildSample(ts: string, data: ObjectMap, latencyMs: number, certValidFrom: string | null): Sample {
  const o = data[OPTICAL];
  const s = data[OPTICAL_STATS];
  const t = data[TRANSCEIVER];
  const d = data[DEVICE_INFO];
  const mem = data['Device.DeviceInfo.MemoryStatus.'];
  const proc = data['Device.DeviceInfo.ProcessStatus.'];

  return {
    ts,
    reachable: true,
    latencyMs,

    uptimeSec: num(d, 'UpTime'),
    rebootCount24h: num(d, 'X_CTL_RebootCount24Hours'),
    rebootCount7d: num(d, 'X_CTL_RebootCount7Days'),
    certValidFrom,
    cpuUsage: num(proc, 'CPUUsage'),
    memFreeKb: num(mem, 'Free'),

    opticalStatus: str(o, 'Status'),
    rxDbm: dbm(o, 'OpticalSignalLevel'),
    txDbm: dbm(o, 'TransmitOpticalLevel'),
    temperature: num(o, 'X_CTL_Temperature'),
    voltage: num(o, 'X_CTL_Voltage'),
    biasCurrent: num(o, 'X_CTL_BiasCurrent'),
    transceiverVendor: str(t, 'Vendor'),
    transceiverModel: str(t, 'Model'),
    oltVendor: str(o, 'X_CTL_OLTVendor'),
    oltModel: str(o, 'X_CTL_OLTModel'),
    fsan: str(o, 'X_CTL_FSAN'),

    lineStatus: str(o, 'X_AXON_LineStatus'),
    linkUpTimeSec: num(o, 'X_AXON_LinkUpTime'),
    connectionFailures: num(o, 'X_AXON_ConnectionFailures'),
    connectionFailures24h: num(o, 'X_AXON_ConnectionFailures24Hours'),
    downstreamRateKbps: num(o, 'X_AXON_DownstreamRate'),
    upstreamRateKbps: num(o, 'X_AXON_UpstreamRate'),

    bytesReceived: num(s, 'BytesReceived'),
    bytesSent: num(s, 'BytesSent'),
    errorsReceived: num(s, 'ErrorsReceived'),
    errorsSent: num(s, 'ErrorsSent'),
    bipErrors: num(s, 'X_CTL_BIPErrorsReceived'),
    erroredSecs: num(s, 'X_CTL_ErroredSecs'),
    severelyErroredSecs: num(s, 'X_CTL_SeverelyErroredSecs'),
  };
}

/** Take one sample. Never throws: an unreachable device is itself an observation. */
export async function takeSample(client: ModemClient, _cfg: Config): Promise<Sample> {
  const ts = new Date().toISOString();
  const started = Date.now();
  try {
    const data = await client.cgiGet([OPTICAL, DEVICE_INFO_Q]);
    const latency = Date.now() - started;
    return buildSample(ts, data, latency, client.lastCert?.validFrom ?? null);
  } catch (e) {
    return emptySample(ts, (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Health classification
// ---------------------------------------------------------------------------

export type Health = 'ok' | 'warn' | 'critical' | 'unknown';

export interface Verdict {
  health: Health;
  /** Short human-readable reasons, most important first. */
  reasons: string[];
}

const RANK: Record<Health, number> = { ok: 0, unknown: 1, warn: 2, critical: 3 };

function worst(a: Health, b: Health): Health {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * True when the transceiver reports no diagnostics whatsoever.
 *
 * A module that merely has no light still reports its own vendor and model
 * from EEPROM, plus a real temperature, supply voltage and laser bias current,
 * because those are read over I2C and do not depend on incoming photons. All
 * of them being blank or zero means the ONT cannot reach its own optics, which
 * is a different and more serious fault than a dark fibre.
 */
export function transceiverSilent(s: Sample): boolean {
  const quiet = (v: number | null): boolean => v === null || v === 0;
  return (
    quiet(s.temperature) &&
    quiet(s.voltage) &&
    quiet(s.biasCurrent) &&
    s.transceiverVendor === null &&
    s.transceiverModel === null
  );
}

/**
 * Decide how healthy a sample is.
 *
 * Ordering reflects which fault would mislead you if missed. The reboot check
 * comes first because a box that restarts every few minutes zeroes its own
 * statistics: every other counter would read as reassuringly fresh while the
 * service is entirely down.
 */
export function classify(sample: Sample, cfg: Config): Verdict {
  const reasons: string[] = [];
  let health: Health = 'ok';
  const flag = (h: Health, reason: string): void => {
    health = worst(health, h);
    reasons.push(reason);
  };

  if (!sample.reachable) {
    return { health: 'critical', reasons: ['modem unreachable: ' + (sample.error ?? 'unknown')] };
  }

  // --- reboot behaviour ----------------------------------------------------
  const reboots = sample.rebootCount24h;
  const uptime = sample.uptimeSec;

  if (reboots !== null && reboots >= 5) {
    flag('critical', 'reboot loop: ' + reboots + ' restarts in 24h');
  } else if (reboots !== null && reboots >= 2) {
    flag('warn', reboots + ' restarts in 24h');
  }
  // A very young uptime is only meaningful alongside evidence of repetition;
  // on its own it just means someone power-cycled the box.
  if (uptime !== null && uptime < 1800 && reboots !== null && reboots >= 2) {
    flag('critical', 'up only ' + Math.round(uptime / 60) + 'm; restarting repeatedly');
  }

  // --- optical subsystem ---------------------------------------------------
  const status = sample.opticalStatus;

  if (status === 'NotPresent' && transceiverSilent(sample)) {
    flag(
      'critical',
      'optical subsystem not responding: status NotPresent, no transceiver telemetry',
    );
  } else if (status === 'NotPresent') {
    flag('critical', 'optical interface reports NotPresent');
  } else if (status === 'Down' || status === 'LowerLayerDown') {
    flag('critical', 'optical link down (' + status + ')');
  } else if (status === 'Dormant' || status === 'Unknown') {
    flag('warn', 'optical link ' + status.toLowerCase());
  } else if (status === 'Error') {
    flag('critical', 'optical interface in Error state');
  }

  // --- received power ------------------------------------------------------
  // Only meaningful when the device actually produced a reading.
  if (sample.rxDbm !== null) {
    if (sample.rxDbm < cfg.critRxDbm) {
      flag('critical', 'rx power ' + sample.rxDbm.toFixed(2) + ' dBm below ' + cfg.critRxDbm);
    } else if (sample.rxDbm < cfg.warnRxDbm) {
      flag('warn', 'rx power ' + sample.rxDbm.toFixed(2) + ' dBm below ' + cfg.warnRxDbm);
    }
  } else if (status === 'Up') {
    // Up with no measurement is contradictory and worth surfacing.
    flag('warn', 'link reports Up but no optical power reading');
  }

  // --- flapping ------------------------------------------------------------
  if (sample.connectionFailures24h !== null && sample.connectionFailures24h > 0) {
    flag('warn', sample.connectionFailures24h + ' connection failures in 24h');
  }
  if (sample.severelyErroredSecs !== null && sample.severelyErroredSecs > 0) {
    flag('warn', sample.severelyErroredSecs + ' severely errored seconds');
  }

  return { health, reasons };
}
