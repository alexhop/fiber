/**
 * Local dashboard.
 *
 * Serves a single self-contained page plus a small JSON API over the sample
 * log. Everything is inlined: no CDN, no build step, no dependencies. That is
 * a requirement rather than a preference here, because the machine running
 * this is plugged directly into a modem whose internet connection is the thing
 * under investigation, and an external asset reference would leave the page
 * broken exactly when it is needed.
 */
import http from 'node:http';
import { readSamples, logPath, appendSample } from './monitor.ts';
import { takeSample, classify } from './sample.ts';
import { ModemClient } from './api.ts';
import type { Config } from './config.ts';

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fibre Monitor</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #16181d; --muted: #6b7280;
    --line: #d9dce1; --grid: #eceef1;
    --ok: #1a7f4b; --warn: #b26a00; --crit: #c0392b; --unknown: #8b94a2;
    --accent: #2b6cb0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f25; --ink: #e6e8ec; --muted: #98a1ae;
      --line: #2c313a; --grid: #23272e;
      --ok: #43c07d; --warn: #e0a03a; --crit: #ef6b5c; --unknown: #7b8494;
      --accent: #62a0ea;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 17px; margin: 0 0 2px; font-weight: 650; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px; margin-bottom: 16px;
  }
  .banner { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .badge {
    font-weight: 700; font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
    padding: 5px 11px; border-radius: 999px; color: #fff; white-space: nowrap;
  }
  .badge.ok { background: var(--ok); } .badge.warn { background: var(--warn); }
  .badge.critical { background: var(--crit); } .badge.unknown { background: var(--unknown); }
  .reasons { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13px; }
  .reasons li { margin: 2px 0; }
  .grid {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .stat { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .stat .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .stat .v { font-size: 19px; font-weight: 600; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .stat .v.dim { color: var(--muted); font-weight: 400; font-size: 15px; }
  h2 { font-size: 13px; font-weight: 650; margin: 0 0 10px; color: var(--muted);
       text-transform: uppercase; letter-spacing: .05em; }
  .chartwrap { overflow-x: auto; }
  svg { display: block; width: 100%; min-width: 460px; height: 170px; }
  .axis { fill: var(--muted); font-size: 10px; }
  .gridline { stroke: var(--grid); stroke-width: 1; }
  .series { fill: none; stroke: var(--accent); stroke-width: 1.8;
            stroke-linejoin: round; stroke-linecap: round; }
  .thresh { stroke-dasharray: 4 3; stroke-width: 1; fill: none; }
  .empty { color: var(--muted); font-size: 13px; padding: 28px 0; text-align: center; }
  footer { color: var(--muted); font-size: 11px; margin-top: 18px; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
</style>
</head>
<body>
<h1>Fibre Monitor</h1>
<div class="sub" id="sub">loading...</div>

<div class="panel banner" id="banner"></div>

<div class="panel">
  <h2>Current reading</h2>
  <div class="grid" id="stats"></div>
</div>

<div class="panel">
  <h2>Device uptime &mdash; each drop to zero is a restart</h2>
  <div class="chartwrap"><svg id="chart-uptime" viewBox="0 0 900 170" preserveAspectRatio="none"></svg></div>
</div>

<div class="panel">
  <h2>Optical power (dBm)</h2>
  <div class="chartwrap"><svg id="chart-optical" viewBox="0 0 900 170" preserveAspectRatio="none"></svg></div>
</div>

<div class="panel">
  <h2>Restarts in the last 24 hours</h2>
  <div class="chartwrap"><svg id="chart-reboots" viewBox="0 0 900 170" preserveAspectRatio="none"></svg></div>
</div>

<footer id="foot"></footer>

<script>
var SVG = "http://www.w3.org/2000/svg";
var W = 900, H = 170, PAD_L = 46, PAD_R = 12, PAD_T = 12, PAD_B = 24;

function el(name, attrs, text) {
  var n = document.createElementNS(SVG, name);
  for (var k in attrs) n.setAttribute(k, attrs[k]);
  if (text !== undefined) n.textContent = text;
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function fmtDuration(s) {
  if (s === null || s === undefined) return "--";
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h" + (m % 60) + "m";
  return Math.floor(h / 24) + "d" + (h % 24) + "h";
}
function fmtClock(iso) { return iso ? iso.slice(11, 16) : ""; }

/**
 * Draw a line chart. Null values break the line rather than being interpolated,
 * so a gap in the data reads as a gap rather than as a straight line through it.
 */
function drawChart(svg, samples, pick, opts) {
  opts = opts || {};
  clear(svg);
  if (!samples.length) {
    svg.appendChild(el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "class": "axis" },
      "no samples yet"));
    return;
  }

  var vals = samples.map(pick);
  var present = vals.filter(function (v) { return v !== null && v !== undefined; });
  if (!present.length) {
    svg.appendChild(el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "class": "axis" },
      opts.emptyText || "device reported no readings"));
    return;
  }

  var lo = Math.min.apply(null, present);
  var hi = Math.max.apply(null, present);
  if (opts.thresholds) {
    opts.thresholds.forEach(function (t) { lo = Math.min(lo, t.value); hi = Math.max(hi, t.value); });
  }
  if (opts.baseZero) lo = Math.min(lo, 0);
  if (hi === lo) { hi = lo + 1; }
  var span = hi - lo;
  lo -= span * 0.08; hi += span * 0.08;

  var x = function (i) {
    return PAD_L + (samples.length === 1 ? 0 : (i / (samples.length - 1)) * (W - PAD_L - PAD_R));
  };
  var y = function (v) { return PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B); };

  for (var g = 0; g <= 4; g++) {
    var gv = lo + (g / 4) * (hi - lo);
    var gy = y(gv);
    svg.appendChild(el("line", { x1: PAD_L, y1: gy, x2: W - PAD_R, y2: gy, "class": "gridline" }));
    svg.appendChild(el("text", { x: PAD_L - 6, y: gy + 3, "text-anchor": "end", "class": "axis" },
      opts.fmtY ? opts.fmtY(gv) : gv.toFixed(1)));
  }

  (opts.thresholds || []).forEach(function (t) {
    var ty = y(t.value);
    svg.appendChild(el("line",
      { x1: PAD_L, y1: ty, x2: W - PAD_R, y2: ty, "class": "thresh", stroke: t.color }));
  });

  var d = "", pen = false;
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (v === null || v === undefined) { pen = false; continue; }
    d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1) + " ";
    pen = true;
  }
  svg.appendChild(el("path", { d: d, "class": "series", stroke: opts.color || "var(--accent)" }));

  var ticks = Math.min(6, samples.length);
  for (var t2 = 0; t2 < ticks; t2++) {
    var idx = Math.round((t2 / Math.max(1, ticks - 1)) * (samples.length - 1));
    svg.appendChild(el("text",
      { x: x(idx), y: H - 7, "text-anchor": "middle", "class": "axis" },
      fmtClock(samples[idx].ts)));
  }
}

/**
 * Escape text before it goes anywhere near innerHTML.
 *
 * Most values shown here are strings the modem supplied -- transceiver vendor,
 * OLT vendor, optical status. A misbehaving or spoofed device could return
 * markup in those fields, and this page is pointed at devices that are by
 * definition not behaving correctly, so device output is treated as untrusted.
 */
function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function statCard(k, v, dim) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v' +
    (dim ? " dim" : "") + '">' + esc(v) + "</div></div>";
}

function render(data) {
  var samples = data.samples || [];
  var cur = data.current || samples[samples.length - 1] || null;

  // textContent, so no escaping needed on this one.
  document.getElementById("sub").textContent =
    data.host + " · " + samples.length + " samples · updated " +
    new Date().toLocaleTimeString();

  var banner = document.getElementById("banner");
  if (cur) {
    var health = cur.health || "unknown";
    var reasons = cur.reasons || [];
    // The health value also selects a CSS class, so constrain it to known
    // values rather than interpolating whatever arrived.
    var cls = ["ok", "warn", "critical", "unknown"].indexOf(health) >= 0 ? health : "unknown";
    banner.innerHTML =
      '<span class="badge ' + cls + '">' + esc(health) + "</span>" +
      (reasons.length
        ? '<ul class="reasons">' +
          reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>"
        : '<span class="reasons">no faults detected</span>');
  }

  if (cur) {
    document.getElementById("stats").innerHTML =
      statCard("Optical status", cur.opticalStatus || "--") +
      statCard("Rx power", cur.rxDbm === null || cur.rxDbm === undefined
        ? "no reading" : cur.rxDbm.toFixed(2) + " dBm", cur.rxDbm === null) +
      statCard("Tx power", cur.txDbm === null || cur.txDbm === undefined
        ? "no reading" : cur.txDbm.toFixed(2) + " dBm", cur.txDbm === null) +
      statCard("Device uptime", fmtDuration(cur.uptimeSec)) +
      statCard("Restarts 24h", cur.rebootCount24h === null ? "--" : cur.rebootCount24h) +
      statCard("Transceiver", cur.transceiverVendor || "not reporting", !cur.transceiverVendor) +
      statCard("OLT", cur.oltVendor || "not reached", !cur.oltVendor) +
      statCard("Conn failures 24h", cur.connectionFailures24h === null
        ? "--" : cur.connectionFailures24h);
  }

  drawChart(document.getElementById("chart-uptime"), samples,
    function (s) { return s.uptimeSec; },
    { baseZero: true, fmtY: function (v) { return fmtDuration(Math.round(v)); } });

  drawChart(document.getElementById("chart-optical"), samples,
    function (s) { return s.rxDbm; },
    {
      emptyText: "no optical power reported — transceiver is not responding",
      thresholds: [
        { value: data.warnRxDbm, color: "var(--warn)" },
        { value: data.critRxDbm, color: "var(--crit)" }
      ],
      fmtY: function (v) { return v.toFixed(1); }
    });

  drawChart(document.getElementById("chart-reboots"), samples,
    function (s) { return s.rebootCount24h; },
    { baseZero: true, color: "var(--crit)", fmtY: function (v) { return Math.round(v); } });

  document.getElementById("foot").textContent = "Log: " + data.logPath;
}

function refresh() {
  fetch("/api/state")
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function (e) {
      document.getElementById("sub").textContent = "cannot reach the monitor: " + e.message;
    });
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export interface ServeOptions {
  cfg: Config;
  /** Interface to listen on. Loopback by default. */
  bind?: string;
  /** Also poll the modem from inside this process. */
  poll?: boolean;
}

/**
 * Addresses to listen on for a given --bind value.
 *
 * Loopback needs both families. On Windows, `localhost` normally resolves to
 * ::1 before 127.0.0.1, so a server bound only to the IPv4 address is
 * unreachable from a browser typing http://localhost:<port> even though curl
 * to 127.0.0.1 works. Binding 0.0.0.0 would paper over that by exposing the
 * page to the whole network, which is the wrong trade for a page showing
 * modem telemetry, so we open one listener per loopback address instead.
 */
function bindAddresses(bind: string): string[] {
  if (bind === '127.0.0.1' || bind === 'localhost' || bind === '::1') {
    return ['127.0.0.1', '::1'];
  }
  if (bind === '0.0.0.0' || bind === '::') return [bind];
  return [bind];
}

export function serve(opts: ServeOptions): http.Server[] {
  const { cfg } = opts;
  const bind = opts.bind ?? '127.0.0.1';

  // A single client is shared across requests so the session cookie is reused;
  // logging in on every poll would be needless load on a fragile device.
  const client = new ModemClient(cfg);
  let live: Record<string, unknown> | null = null;

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/state') {
      const limit = Number(url.searchParams.get('limit') ?? '500');
      const samples = readSamples(Number.isFinite(limit) ? limit : 500);
      json(res, 200, {
        host: cfg.host,
        warnRxDbm: cfg.warnRxDbm,
        critRxDbm: cfg.critRxDbm,
        logPath: logPath(),
        current: live ?? samples[samples.length - 1] ?? null,
        samples,
      });
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(PAGE);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  };

  const servers: http.Server[] = [];
  const addresses = bindAddresses(bind);
  let announced = false;

  for (const address of addresses) {
    const server = http.createServer(handler);

    // A machine with IPv6 disabled will refuse the ::1 listener. That is not a
    // failure worth aborting on when the IPv4 listener is already serving.
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (addresses.length > 1 && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')) {
        return;
      }
      if (e.code === 'EADDRINUSE') {
        console.error(
          'Port ' + cfg.port + ' is already in use on ' + address + '. ' +
          'Another copy may be running; use --port to pick a different one.',
        );
        process.exit(1);
      }
      console.error('Listen failed on ' + address + ': ' + e.message);
    });

    server.listen(cfg.port, address, () => {
      if (!announced) {
        announced = true;
        const shown = addresses.includes('127.0.0.1') ? 'localhost' : address;
        console.log('Dashboard: http://' + shown + ':' + cfg.port);
        if (bind === '0.0.0.0' || bind === '::') {
          console.log('Listening on all interfaces. The page exposes modem telemetry,');
          console.log('so only do this on a network you trust.');
        }
      }
    });
    servers.push(server);
  }

  if (opts.poll !== false) {
    void (async () => {
      for (;;) {
        // takeSample never throws, but appending to disk can (a full or
        // read-only volume). Without this guard the rejection would kill the
        // polling loop while the web server carried on serving a frozen page,
        // which is the worst possible failure for a monitoring tool.
        try {
          const sample = await takeSample(client);
          const verdict = classify(sample, cfg);
          live = { ...sample, health: verdict.health, reasons: verdict.reasons };
          appendSample(sample, verdict);
        } catch (e) {
          console.error('sampling failed: ' + (e as Error).message);
        }
        await new Promise((r) => setTimeout(r, Math.max(5, cfg.intervalSec) * 1000));
      }
    })();
  }

  return servers;
}
