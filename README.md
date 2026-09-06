# fiber-monitor

Diagnostics and optical-power monitoring for a Quantum Fiber ONT, talking
directly to the device on your LAN instead of through any vendor cloud service.

Built for the situation where the link is down or flapping, the ISP can't tell
you why, and you need evidence: connect a machine straight to the modem, find
out what the box actually reports, and log it over time so an intermittent
fault leaves a trace you can hand to support.

Developed against a **Quantum Fiber Q1000K SmartNID** (Adtran / Axon Networks,
firmware `QKX002-06.01.25.00`). It should work on related CenturyLink,
Brightspeed and Lumen CPE that share the same management UI, and the `discover`
command exists to re-map the API if yours differs.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Options](#options)
- [Configuration](#configuration)
- [The dashboard](#the-dashboard)
- [Sample log](#sample-log)
- [Health classification](#health-classification)
- [The device API](#the-device-api)
- [Firmware quirks](#firmware-quirks)
- [Interpreting readings](#interpreting-readings)
- [Running unattended](#running-unattended)
- [Security](#security)
- [What is not in this repository](#what-is-not-in-this-repository)
- [Troubleshooting](#troubleshooting)
- [Licence](#licence)

## Requirements

Node.js 22.18 or newer (24.x is fine). Nothing else.

There are no dependencies, no `npm install`, and no build step. Node strips the
TypeScript types at load time, so `src/` runs as-is and identically on Windows
and Linux. On Node 22.6 to 22.17 you need `node --experimental-strip-types`.

Because the type stripping only *erases* syntax, the code avoids TypeScript
constructs that emit code: no `enum`, no `namespace`, no constructor parameter
properties.

## Quick start

You need to be on the modem's network. Plug an Ethernet cable from your machine
into one of the modem's LAN ports; it will hand you an address on `192.168.0.x`.

```sh
node src/cli.ts setup      # store modem address + credentials, once
node src/cli.ts status     # one snapshot of the link
node src/cli.ts serve      # live dashboard on http://localhost:8477
```

The admin password is on the sticker on the device, labelled `Admin Password`
(not the Wi-Fi password). `setup` prompts for it with the input masked and
writes `fiber.config.json`, which is gitignored and created mode `0600`.

## Commands

| Command | What it does |
| --- | --- |
| `setup` | Store modem address and credentials permanently. Masked prompt. |
| `status` | Log in and print one snapshot: optical power, link state, uptime, reboot counts. |
| `serve` | Poll continuously **and** serve the live dashboard. The usual way to run it. |
| `monitor` | Poll continuously with no web server. Prints one line per sample. |
| `discover` | Fingerprint the device and map every endpoint it exposes. Use on unknown hardware. |
| `probe <path>` | Fetch a single path and dump status, headers, TLS certificate and body. |
| `help` | Usage summary. |

`discover` fingerprints the device, harvests URLs from the management UI's own
JavaScript, probes a wordlist of PON and optical paths as a backstop, and ranks
what it finds by how much optical-diagnostic content each response contains.
The full result is written to `data/discovery-<timestamp>.json`.

## Options

| Flag | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `--host <ip>` | all | `192.168.0.1` | Modem address. |
| `--user <name>` | all | `admin` | Admin username. |
| `--pass <secret>` | all | — | Admin password. Prefer `setup` or the environment. |
| `--timeout <ms>` | all | `8000` | Per-request timeout. |
| `--interval <sec>` | `serve`, `monitor` | `30` | Seconds between samples. |
| `--count <n>` | `monitor` | — | Stop after n samples. |
| `--port <n>` | `serve` | `8477` | Dashboard port. |
| `--bind <addr>` | `serve` | `127.0.0.1` | Interface to listen on. |
| `--no-poll` | `serve` | — | Serve the existing log without contacting the modem. |
| `--assets-only` | `discover` | — | Skip the blind wordlist; follow only the UI's asset graph. |
| `--raw` | `probe` | — | Print the whole body rather than a preview. |

## Configuration

Settings merge from three sources, each overriding the one before it.

| Source | Use it for |
| --- | --- |
| `fiber.config.json` | Permanent local settings. Gitignored. Written by `setup`. |
| `FIBER_HOST`, `FIBER_USER`, `FIBER_PASS` | One-off overrides. |
| `--host`, `--user`, `--pass`, `--interval`, `--port`, `--timeout` | A single invocation. |

`fiber.config.example.json` shows the full shape:

```json
{
  "host": "192.168.0.1",
  "username": "admin",
  "password": "",
  "intervalSec": 30,
  "port": 8477,
  "timeoutMs": 8000,
  "warnRxDbm": -25,
  "critRxDbm": -28
}
```

A config file is preferred over environment variables for credentials. It
survives reboots and new terminals without shell-profile edits, behaves the
same on both operating systems, and keeps the password out of shell history
and out of `ps` output.

## The dashboard

`serve` runs the poller and the web UI in one process.

The page is entirely self-contained: no CDN, no external stylesheets, no chart
library. That is a requirement rather than a preference, because the machine
running this is plugged into the modem whose internet connection is the subject
of the investigation, and an external asset reference would leave the page
broken exactly when it is needed. Charts are inline SVG drawn in about a
hundred lines of plain JavaScript.

It shows:

- a health banner with the reasons any fault fired
- current readings: optical status, rx/tx power, uptime, restart count, OLT
- **device uptime over time** — each drop to zero is a restart, which makes a
  reboot loop obvious at a glance
- received optical power, with the warn and critical thresholds drawn in
- restarts in the last 24 hours

Null readings break the line rather than being interpolated, so a gap in the
data reads as a gap instead of a straight line drawn through it.

By default it binds to **both** loopback addresses, `127.0.0.1` and `::1`.
Binding only to the IPv4 address is a trap on Windows, where `localhost`
usually resolves to `::1` first: the browser reports the site as unreachable
while `curl http://127.0.0.1:<port>` works fine.

To reach the dashboard from another machine, `--bind 0.0.0.0`. The page exposes
modem telemetry including your PON serial, so only do that on a trusted
network.

## Sample log

Every sample is appended to `data/samples.jsonl` as one JSON object per line.
Append-only and self-describing, so it is greppable, resumable after a crash,
and readable by anything. A truncated final line from an interrupted write is
tolerated on read.

```json
{
  "ts": "2026-09-06T21:08:56.089Z",
  "reachable": true,
  "latencyMs": 26,
  "uptimeSec": 1502,
  "rebootCount24h": 38,
  "opticalStatus": "NotPresent",
  "rxDbm": -19.829,
  "txDbm": 2.864,
  "temperature": 53,
  "voltage": 3320,
  "biasCurrent": 12308,
  "oltVendor": "CALX",
  "oltModel": "E7",
  "fsan": "AXON0000DEAD",
  "bipErrors": 257,
  "health": "critical",
  "reasons": ["reboot loop: 38 restarts in 24h"]
}
```

Selected fields:

| Field | Meaning |
| --- | --- |
| `opticalStatus` | TR-181 state: `Up`, `Down`, `Dormant`, `NotPresent`, `LowerLayerDown`, `Error`. |
| `rxDbm` / `txDbm` | Received and transmitted optical power in dBm. `null` when the device reports no reading. |
| `temperature`, `voltage`, `biasCurrent` | Transceiver diagnostics. Readable from the module regardless of incoming light. |
| `oltVendor`, `oltModel` | Populated only once an OLT has actually been reached. |
| `fsan` | The PON identity the OLT authenticates. Needed if the unit is ever replaced. |
| `bipErrors` | Bit-interleaved-parity errors received. Rising values indicate a marginal downstream. |
| `uptimeSec`, `rebootCount24h` | Device restart behaviour. Read these before trusting anything else. |
| `certValidFrom` | The device mints a TLS certificate on factory reset, so this approximates its last reset. |
| `health`, `reasons` | Output of `classify()`. |

## Health classification

`classify()` in `src/sample.ts` grades each sample `ok`, `warn`, `critical` or
`unknown`, and returns a reason for every rule that fired.

Reboot behaviour is checked **first**, deliberately. A device that restarts
every few minutes zeroes its own statistics, so every other counter reads as
reassuringly fresh while the service is entirely down.

Roughly:

- unreachable, or 5+ restarts in 24h, or a short uptime alongside repeated
  restarts — `critical`
- optical status `NotPresent`, `Down`, `LowerLayerDown` or `Error` — `critical`
- optical status `Dormant` or `Unknown` — `warn`
- `rxDbm` below `critRxDbm` — `critical`; below `warnRxDbm` — `warn`
- link reporting `Up` with no power reading at all — `warn`
- any connection failures or severely errored seconds in 24h — `warn`

`transceiverSilent()` separates a genuinely dead optical module from a merely
dark fibre: a module with no light still reports its vendor, model, temperature,
supply voltage and laser bias current, because those come from EEPROM and DDM
over I²C and do not depend on incoming photons.

## The device API

The management UI is a React single-page app that queries a TR-181 data model
through a CGI bridge. The interface was recovered by reading the UI's own
JavaScript rather than by guessing: the app is code-split, and the entry bundle
embeds the complete webpack chunk manifest, so all of the post-login code can be
fetched and read without authenticating.

```text
POST /cgi/cgi_action   body: username=<u>&password=<p>          -> Session-Id cookie
GET  /cgi/cgi_get?Object=<path>&<Field>=&<Field>=               -> JSON
POST /cgi/cgi_set      body: Object=<path>&Operation=Modify&..  -> JSON
POST /cgi/cgi_action   body: Action=Logout
```

Notes:

- Every request carries `X-Requested-With: XMLHttpRequest`. Treat it as
  load-bearing; it is a CSRF guard, not decoration.
- Omitting the `&Field=` filters returns every parameter of an object. The API
  is generic, so it cannot hide fields merely because the UI does not show them.
- Several queries can be combined by joining them with commas.
- `cgi_set` is a POST carrying the query string as the **body**. Sending the
  same thing as a GET query returns 404.
- **HTTP 444 means "no valid session"**, not a transport error. The client
  re-authenticates once and retries.

Useful objects:

| Object | Contains |
| --- | --- |
| `Device.Optical.Interface.1.` | Optical status, rx/tx power, transceiver DDM, FSAN, OLT vendor. |
| `Device.Optical.Interface.1.Stats.` | Byte and error counters, BIP errors, errored seconds. |
| `Device.DeviceInfo` | Model, serial, firmware, uptime, reboot counts. |
| `Device.DeviceInfo.X_AXON_SystemRebootInfo.` | **Reboot reason** and per-cause counters. |
| `Device.X_AXON_Systemlog.` | System log enable/state. |
| `SystemLog` | The log itself, once enabled. |

There is also a second authentication realm, `supportconsole_username=`, which
unlocks `/supportconsole_*` pages including TR-069 settings and an OAM ping
test.

## Firmware quirks

Three of these will silently corrupt readings if you do not handle them.

- **Optical power is in thousandths of a dBm**, not the 0.1 dBm units TR-181
  specifies. The divisor here is taken from the device's own UI, not the spec.
- **`-2147483648` (INT32_MIN) means "no reading"**, not a value. Dividing it
  by 1000 would print `-2147483.6 dBm`. A reported `0` is also a sentinel; 0 dBm
  is not a physically plausible level on a PON.
- **Object names are inconsistent.** Queried alone an object returns as
  `Device.DeviceInfo`; combined with a second query in the same request it
  returns as `Device.DeviceInfo.` with a trailing dot. Names are normalised to
  a canonical trailing-dot form before lookup.
- **Field filters matter.** An unfiltered `Object=Device.DeviceInfo` drags back
  every child object including 269 logger entries. Adding filters took a poll
  from 323 ms to 24 ms.
- **The web server is fragile.** Embedded lighttpd with very few connection
  slots; three concurrent requests wedged it during development, after which it
  accepted TCP connections but answered nothing until it restarted. All
  requests here are strictly serial, with backoff on failure.

## Interpreting readings

### Read the reboot counters first

If the device is restarting repeatedly, treat every other counter with
suspicion. A modem sampled mid-boot reports its optical interface as
`NotPresent` with zero temperature, voltage and bias current — indistinguishable
from genuinely dead optics. The same device, once it stays up, may report a
perfectly healthy received level.

This is not hypothetical; it produced a confidently wrong diagnosis during
development. `classify()` checks restarts first and the uptime chart exists
specifically to make the pattern visible.

### Received optical power

For GPON class B+, roughly:

| Reading | Meaning |
| --- | --- |
| −8 to −27 dBm | Within spec. |
| −28 to −33 dBm | Marginal. Expect flapping. |
| Below −35, or no reading | No usable light: a cut, a dirty connector, or a dark OLT port. |

Light with no session is a different fault from no light at all. Good rx power
plus `linkUpTimeSec: 0` points at ranging, OMCI or provisioning, not at the
glass.

### PON generation

The WAN log line reports the negotiated rates. `downlink:2488000
uplink:1244000` is 2.488G/1.244G, which is **GPON**. XGS-PON would be roughly
9.95G symmetric. This matters if you are considering a third-party SFP+ ONT
stick, since the common WAS-110 class modules are XGS-PON only.

### Reboot reason

`Device.DeviceInfo.X_AXON_SystemRebootInfo.` separates the causes, and the
distinction is the diagnosis:

| Counter | Means |
| --- | --- |
| `PowerOnResetCount` | Actual power loss. |
| `WatchdogResetCount` | The CPU hung and the watchdog fired. |
| `GlobalSoftwareResetCount` | The firmware chose to restart itself. |
| `FactoryResetCount` | Configuration was wiped. |

### Enabling the device system log

The system log ships disabled and shows WAN state transitions with timestamps,
which is what you want when chasing a flap. To turn it on with save-on-reboot:

```text
POST /cgi/cgi_set
Object=Device.X_AXON_Systemlog&Operation=Modify&State=Enabled%2dSave
Object=Device.X_AXON_Systemlog&Operation=Modify&Enable=1
```

Both are needed; setting `State` alone leaves `Enable` at `0` and the log stays
empty. Read it back with `Object=SystemLog`. Note the response shape differs
from other objects. This writes a setting to the modem's flash and is
reversible from the UI under Utilities.

## Running unattended

### Linux (systemd)

```ini
[Unit]
Description=fiber-monitor
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/fiber/src/cli.ts serve --interval 120
WorkingDirectory=/opt/fiber
Restart=always
RestartSec=10
User=fiber

[Install]
WantedBy=multi-user.target
```

Credentials come from `fiber.config.json` in `WorkingDirectory`, so the unit
file holds no secrets. Point the data directory elsewhere with `FIBER_DATA_DIR`
if you want the log outside the checkout.

### Windows

Create a Scheduled Task that runs at logon:

```text
Program:   node
Arguments: src\cli.ts serve --interval 120
Start in:  D:\source\fiber
```

## Security

The HTTP client accepts the modem's self-signed certificate. There is no CA to
trust: the device signs its own certificate and it will never validate. The
bypass is applied **per request** rather than through the process-wide
`NODE_TLS_REJECT_UNAUTHORIZED`, and `assertPrivateHost()` refuses any address
outside RFC 1918, loopback, link-local or CGNAT space, so the relaxed
verification cannot be aimed at the public internet.

TLS session caching is disabled. Resumed sessions perform an abbreviated
handshake in which the server does not retransmit its certificate, and this
tool reads the certificate's `validFrom` as a proxy for the device's last
reset, so a stale certificate would be actively misleading.

Values the modem supplies — transceiver vendor, OLT vendor, optical status —
are escaped before reaching the dashboard's DOM. This tool exists to be pointed
at devices that are misbehaving, so their output is treated as untrusted.

The dashboard has no authentication. It binds to loopback by default for that
reason.

## What is not in this repository

`.gitignore` excludes `fiber.config.json` and the whole `data/` directory.

That matters more than usual here. Sample logs and discovery reports contain
the ONT serial and WAN MAC, and on a PON network the serial **is** the
subscriber identity the OLT authenticates against. It is not a password, but it
does not belong in a public repository.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Dashboard unreachable at `localhost` but fine at `127.0.0.1` | An older build bound IPv4 only. Current code binds both loopback families. |
| `Login rejected (status 200)` | Wrong password. Use the `Admin Password` from the device label, not the Wi-Fi key. |
| Every query returns 444 | The session was not established. Check credentials; the client retries once automatically. |
| Requests time out, but ping and TCP connect succeed | The modem's web server is wedged. Stop polling and give it a few minutes. |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node is too old, or code used non-erasable TypeScript syntax. |
| Optical fields all null or zero | Probably sampled during boot. Check `uptimeSec` before concluding anything. |

## Licence

MIT. See [LICENSE](LICENSE).
