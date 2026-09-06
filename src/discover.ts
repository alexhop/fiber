/**
 * Endpoint discovery for an unknown modem/ONT web interface.
 *
 * Strategy, in order of yield:
 *   1. Fingerprint the device (headers, TLS cert, page titles). Adtran/Calix
 *      boxes leak model and serial in the self-signed cert with no auth at all.
 *   2. Harvest URLs from the UI's own assets. A single-page app must name every
 *      endpoint it calls, so its JS bundles are a far better source of truth
 *      than any wordlist. This is the step that usually wins.
 *   3. Probe a curated wordlist of PON/optical paths as a backstop.
 *   4. Score every response for optical-diagnostic keywords and rank them.
 *
 * The output is a JSON report plus a human-readable summary; nothing here
 * assumes a particular firmware.
 */
import { request, CookieJar, type Response } from './net.ts';

/** Paths worth trying blind on a GPON/XGS-PON ONT. Ordered roughly by likelihood. */
const WORDLIST: string[] = [
  // Adtran SmartOS / SDX-family REST shapes
  '/api/v1/status', '/api/v1/system', '/api/v1/wan', '/api/v1/pon', '/api/v1/optical',
  '/api/status', '/api/system', '/api/wan', '/api/pon', '/api/optics', '/api/gpon',
  '/api/device', '/api/info', '/api/summary', '/api/dashboard', '/api/diagnostics',
  '/rest/v1/status', '/rest/status', '/restconf/data', '/restconf/data/ietf-interfaces:interfaces-state',
  // Calix GigaCenter heritage
  '/cgi-bin/status.cgi', '/cgi-bin/pon.cgi', '/cgi-bin/optical.cgi', '/cgi-bin/webcm',
  '/cgi/status', '/cgi/pon', '/cgi/gpon',
  // CenturyLink / Quantum UI page names seen across their modem line
  '/modemstatus_ponstatus.html', '/modemstatus_fiber.html', '/modemstatus_status.html',
  '/modemstatus_pon.html', '/modemstatus_ont.html', '/modemstatus_gpon.html',
  '/advancedsetup_pon.html', '/utilities_logs.html', '/utilities_eventlog.html',
  // Generic
  '/status', '/status.json', '/status.xml', '/pon', '/ponstatus', '/pon_status',
  '/optical', '/optics', '/gpon', '/xgspon', '/ont', '/onu', '/wan', '/wanstatus',
  '/system', '/sysinfo', '/deviceinfo', '/device_info', '/info', '/info.json',
  '/summary', '/dashboard', '/diagnostics', '/diag', '/log', '/logs', '/syslog',
  '/eventlog', '/event_log', '/messages', '/alarms', '/statistics', '/stats',
  // TR-069 / TR-181 data model exposed over HTTP by some firmware
  '/tr069', '/data/Device.Optical.Interface.', '/data/InternetGatewayDevice',
  '/getdata', '/data.json', '/state.json', '/config.json',
  // Common SPA manifests that reveal the asset graph
  '/manifest.json', '/asset-manifest.json', '/index.html', '/login', '/login.html',
];

/**
 * Terms that indicate a response carries optical / PON diagnostics.
 * Weighted: a hit on `rxpower` is far more meaningful than a hit on `status`.
 */
const SIGNALS: Array<[RegExp, number, string]> = [
  [/\brx[_\s-]?power\b|\breceive[_\s-]?power\b|\brxopticalpower\b/i, 10, 'rx power'],
  [/\btx[_\s-]?power\b|\btransmit[_\s-]?power\b|\btxopticalpower\b/i, 10, 'tx power'],
  [/\bdbm\b/i, 9, 'dBm units'],
  [/\bploam\b|\bo5\b|\bo1\b|\branging\b/i, 9, 'PLOAM state'],
  [/\blos\b|\bloss[_\s-]?of[_\s-]?signal\b|\blof\b/i, 8, 'LOS/LOF alarm'],
  [/\bolt\b|\bonu[_\s-]?id\b|\bonu\b/i, 7, 'OLT/ONU'],
  [/\bbias[_\s-]?current\b|\blaser[_\s-]?bias\b/i, 7, 'laser bias'],
  [/\bxgs[_\s-]?pon\b|\bxgspon\b/i, 7, 'XGS-PON'],
  [/\bgpon\b|\bpon[_\s-]?(status|state|mode)\b/i, 6, 'PON'],
  [/\boptical\b|\boptics\b/i, 6, 'optical'],
  [/\bserial[_\s-]?number\b|\bont[_\s-]?serial\b|\bequipment[_\s-]?id\b/i, 5, 'ONT identity'],
  [/\bvendor[_\s-]?id\b/i, 5, 'vendor id'],
  [/\btemperature\b|\bvoltage\b/i, 3, 'transceiver env'],
  [/\bwan\b/i, 2, 'wan'],
];

export interface Probe {
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  elapsedMs: number;
  score: number;
  matched: string[];
  /** First 600 chars, for eyeballing without dumping whole pages. */
  preview: string;
  error?: string;
  /** True when the body looks like a login wall rather than real data. */
  looksLikeLogin: boolean;
}

export interface DiscoveryReport {
  host: string;
  startedAt: string;
  reachable: boolean;
  fingerprint: {
    schemes: string[];
    server?: string;
    title?: string;
    poweredBy?: string;
    cert?: unknown;
    /** Anything that looks like an ONT serial, pulled from cert or page text. */
    identityHints: Record<string, string>;
  };
  assetsScraped: number;
  candidatesProbed: number;
  probes: Probe[];
}

/** Score a body for optical relevance. Returns total weight plus matched labels. */
function scoreBody(body: string): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];
  for (const [re, weight, label] of SIGNALS) {
    if (re.test(body)) {
      score += weight;
      matched.push(label);
    }
  }
  return { score, matched };
}

function looksLikeLoginPage(body: string): boolean {
  const b = body.toLowerCase();
  const hasPasswordField = /type\s*=\s*["']?password/.test(b);
  const hasLoginWords = /(sign in|log ?in|admin password|authentication required)/.test(b);
  return hasPasswordField || (hasLoginWords && b.length < 60000);
}

/** Pull every plausible URL out of an HTML or JS body. */
export function extractUrls(body: string, baseUrl: string): string[] {
  const found = new Set<string>();

  const patterns: RegExp[] = [
    // HTML attributes
    /(?:src|href|action|data-src)\s*=\s*["']([^"'>]+)["']/gi,
    // Explicit calls in JS
    /(?:fetch|axios\.(?:get|post|put)|\$\.(?:get|post|ajax)|open)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    // url:, endpoint:, api:, path: object properties
    /(?:url|uri|endpoint|api|apiUrl|basePath|path)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi,
    // Bare path-looking string literals: "/api/foo", "/status.cgi"
    /["'`](\/[A-Za-z0-9_\-./]{2,120}(?:\.(?:json|cgi|php|asp|html|xml|do|action))?)["'`]/g,
  ];

  for (const re of patterns) {
    for (const m of body.matchAll(re)) {
      const raw = m[1];
      if (!raw) continue;
      // Reject data URIs, protocol-relative externals, templating placeholders,
      // and obvious non-endpoints.
      if (/^(data:|blob:|mailto:|javascript:|tel:|#)/i.test(raw)) continue;
      if (/[{}$<>\\]/.test(raw)) continue;
      if (/\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|webp|mp4)(\?|$)/i.test(raw)) continue;
      try {
        const abs = new URL(raw, baseUrl);
        // Stay on the device. An external CDN reference tells us nothing.
        if (abs.hostname !== new URL(baseUrl).hostname) continue;
        abs.hash = '';
        found.add(abs.toString());
      } catch {
        /* not a usable URL */
      }
    }
  }
  return [...found];
}

/** Run `tasks` with bounded concurrency; modem web servers are single-threaded and fragile. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function toProbe(res: Response): Probe {
  const { score, matched } = scoreBody(res.body);
  return {
    url: res.url,
    status: res.status,
    contentType: res.contentType,
    bytes: res.bodyBytes,
    elapsedMs: res.elapsedMs,
    score,
    matched,
    preview: res.body.slice(0, 600).replace(/\s+/g, ' ').trim(),
    error: res.error,
    looksLikeLogin: looksLikeLoginPage(res.body),
  };
}

/** Scrape identity strings (serials, model names) out of a cert subject or page text. */
function harvestIdentity(text: string, cert: unknown): Record<string, string> {
  const hints: Record<string, string> = {};

  if (cert && typeof cert === 'object') {
    const c = cert as { subject?: Record<string, string>; issuer?: Record<string, string> };
    for (const [k, v] of Object.entries(c.subject ?? {})) hints['cert.subject.' + k] = String(v);
    for (const [k, v] of Object.entries(c.issuer ?? {})) hints['cert.issuer.' + k] = String(v);
  }

  // Quantum/Adtran ONT serials are typically 4 alpha vendor chars + 8 hex.
  const serial = text.match(/\b([A-Z]{4}[0-9A-Fa-f]{8})\b/);
  if (serial) hints['serialCandidate'] = serial[1];

  const model = text.match(/\b(Q1000K|C\d{4}[A-Z]{0,2}|SDX\s?\d{3}\w*|GS\d{4}\w*)\b/i);
  if (model) hints['modelCandidate'] = model[1];

  const mac = text.match(/\b([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\b/);
  if (mac) hints['macCandidate'] = mac[1];

  return hints;
}

export interface DiscoverOptions {
  host: string;
  jar?: CookieJar;
  timeoutMs?: number;
  concurrency?: number;
  /** Skip the blind wordlist and only follow the UI's own asset graph. */
  assetsOnly?: boolean;
  onProgress?: (message: string) => void;
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveryReport> {
  const { host, onProgress = () => {} } = opts;
  const jar = opts.jar ?? new CookieJar();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const concurrency = opts.concurrency ?? 3;

  const report: DiscoveryReport = {
    host,
    startedAt: new Date().toISOString(),
    reachable: false,
    fingerprint: { schemes: [], identityHints: {} },
    assetsScraped: 0,
    candidatesProbed: 0,
    probes: [],
  };

  // --- Step 1: fingerprint both schemes -------------------------------------
  const roots: Response[] = [];
  for (const scheme of ['https', 'http'] as const) {
    const base = scheme + '://' + host + '/';
    onProgress('fingerprint ' + base);
    const res = await request(base, { jar, timeoutMs });
    if (res.error) continue;
    report.reachable = true;
    report.fingerprint.schemes.push(scheme);
    roots.push(res);

    if (!report.fingerprint.server && res.headers['server']) {
      report.fingerprint.server = String(res.headers['server']);
    }
    if (!report.fingerprint.poweredBy && res.headers['x-powered-by']) {
      report.fingerprint.poweredBy = String(res.headers['x-powered-by']);
    }
    const title = res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (title && !report.fingerprint.title) {
      report.fingerprint.title = title[1].trim();
    }
    if (res.cert && !report.fingerprint.cert) report.fingerprint.cert = res.cert;

    Object.assign(
      report.fingerprint.identityHints,
      harvestIdentity(res.body, res.cert),
    );
  }

  if (!report.reachable) return report;

  // Prefer whichever scheme actually answered; https first if both did.
  const baseUrl = (report.fingerprint.schemes.includes('https') ? 'https' : 'http') + '://' + host;

  // --- Step 2: harvest the UI's own asset graph -----------------------------
  const seedUrls = new Set<string>();
  for (const root of roots) {
    for (const u of extractUrls(root.body, root.url)) seedUrls.add(u);
  }

  // Fetch the JS/CSS assets themselves and mine them for endpoint strings.
  const assetUrls = [...seedUrls].filter((u) => /\.(js|mjs|cjs|json|txt)(\?|$)/i.test(u));
  onProgress('scraping ' + assetUrls.length + ' assets for endpoint strings');

  const assetBodies = await pooled(assetUrls.slice(0, 60), concurrency, async (u) => {
    const res = await request(u, { jar, timeoutMs, maxBytes: 8 * 1024 * 1024 });
    return res;
  });

  const mined = new Set<string>();
  for (const res of assetBodies) {
    if (res.error || res.status !== 200) continue;
    report.assetsScraped += 1;
    for (const u of extractUrls(res.body, res.url)) mined.add(u);
    Object.assign(report.fingerprint.identityHints, harvestIdentity(res.body, undefined));
  }
  onProgress('mined ' + mined.size + ' candidate URLs from assets');

  // --- Step 3: assemble the probe set ---------------------------------------
  const candidates = new Set<string>();
  for (const u of [...seedUrls, ...mined]) {
    // Do not re-fetch the static assets themselves; we want endpoints.
    if (/\.(js|mjs|cjs|css|map)(\?|$)/i.test(u)) continue;
    candidates.add(u);
  }
  if (!opts.assetsOnly) {
    for (const path of WORDLIST) candidates.add(baseUrl + path);
  }

  const list = [...candidates];
  onProgress('probing ' + list.length + ' candidate endpoints');

  const probeResults = await pooled(list, concurrency, async (u, i) => {
    if (i > 0 && i % 25 === 0) onProgress('  ...' + i + '/' + list.length);
    const res = await request(u, { jar, timeoutMs, followRedirects: 2 });
    return toProbe(res);
  });

  report.candidatesProbed = list.length;
  report.probes = probeResults
    .filter((p) => p.status !== 0 || p.error !== undefined)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  return report;
}

/** Render a report as a terminal-friendly summary. */
export function formatReport(report: DiscoveryReport): string {
  const out: string[] = [];
  const fp = report.fingerprint;

  out.push('=== Device fingerprint =========================================');
  out.push('host:      ' + report.host);
  out.push('reachable: ' + report.reachable + (fp.schemes.length ? '  via ' + fp.schemes.join(', ') : ''));
  if (fp.server) out.push('server:    ' + fp.server);
  if (fp.poweredBy) out.push('powered:   ' + fp.poweredBy);
  if (fp.title) out.push('title:     ' + fp.title);

  const hints = Object.entries(fp.identityHints);
  if (hints.length) {
    out.push('');
    out.push('identity hints (no auth required):');
    for (const [k, v] of hints) out.push('  ' + k.padEnd(28) + v);
  }

  if (!report.reachable) {
    out.push('');
    out.push('Device did not answer on http or https. Check the cable, the NIC,');
    out.push('and that this machine still has an address on the modem subnet.');
    return out.join('\n');
  }

  out.push('');
  out.push('=== Interesting endpoints ======================================');
  out.push('assets scraped: ' + report.assetsScraped + '   endpoints probed: ' + report.candidatesProbed);
  out.push('');

  const interesting = report.probes.filter((p) => p.score > 0 && p.status === 200);
  if (interesting.length === 0) {
    out.push('Nothing scored above zero. Everything is probably behind the login;');
    out.push('re-run with credentials, or capture a browser session cookie.');
  }
  for (const p of interesting.slice(0, 25)) {
    const flag = p.looksLikeLogin ? ' [LOGIN WALL]' : '';
    out.push(
      'score ' + String(p.score).padStart(3) + '  ' + String(p.status) + '  ' +
      p.bytes.toString().padStart(7) + 'B  ' + p.url + flag,
    );
    out.push('        matched: ' + p.matched.join(', '));
  }

  out.push('');
  out.push('=== Reachable but unscored (200 OK, no optical keywords) =======');
  const others = report.probes.filter((p) => p.status === 200 && p.score === 0);
  for (const p of others.slice(0, 30)) {
    out.push('  ' + String(p.status) + '  ' + p.bytes.toString().padStart(7) + 'B  ' + p.url);
  }

  const authWalled = report.probes.filter((p) => p.status === 401 || p.status === 403);
  if (authWalled.length) {
    out.push('');
    out.push('=== Auth-protected (401/403) -- these are the good ones ========');
    for (const p of authWalled.slice(0, 30)) {
      out.push('  ' + String(p.status) + '  ' + p.url);
    }
  }

  return out.join('\n');
}
