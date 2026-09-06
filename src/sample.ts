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

/**
 * Decide how healthy a sample is.
 *
 * TODO(user): implement this. See the discussion in the conversation --
 * the interesting judgement calls are:
 *
 *   - A short `uptimeSec` combined with a high `rebootCount24h` is the reboot
 *     loop. How short, and how many, before it is critical rather than warn?
 *   - `opticalStatus === 'NotPresent'` with all of temperature/voltage/
 *     biasCurrent at zero means the transceiver is unreadable. Is that its own
 *     category, distinct from "fibre is dark"?
 *   - `rxDbm` below cfg.warnRxDbm / cfg.critRxDbm is the classic signal-level
 *     check, but it only applies when there IS a reading.
 *   - Rising `connectionFailures24h` indicates flapping even while the link
 *     currently reads as up.
 *
 * Return the worst applicable health, and push a reason string for each
 * condition that fired so the dashboard and the log can explain themselves.
 */
export function classify(sample: Sample, cfg: Config): Verdict {
  const reasons: string[] = [];

  if (!sample.reachable) {
    return { health: 'critical', reasons: ['modem unreachable: ' + (sample.error ?? 'unknown')] };
  }

  // TODO(user): replace this placeholder with the real rules.
  return { health: 'unknown', reasons };
}
