# fiber-monitor

Diagnostics and optical-power monitoring for a Quantum Fiber ONT, talking
directly to the device on your LAN instead of through any vendor cloud service.

## Why this exists

The internet went down at 4pm on a Tuesday and stayed down.

The SmartNID on the wall had a blinking blue light. The support page says
blinking blue means the device is "trying to sync with the network" — which is
another way of saying *something is wrong and we are not going to tell you
what*. Power-cycling it and waiting half an hour changed nothing. The fibre
running to the house had no visible damage. Support was, to put it politely,
not much help: the script is reboot it, wait, and book an engineer.

The earliest appointment was **ten days out**.

Ten days without a connection is an inconvenience if the internet is a
luxury. It is something else entirely if you work from home. There was a
backup link to fall back on, which took the edge off, but the position was
still absurd: a service that was one hundred per cent down, an appointment
a week and a half away, and not one piece of information about what was
actually broken — or whether the visit would even be the right kind of visit.

That leaves you with a blinking light and no information, which is a
frustrating place to be when the answer is sitting inside the box.

Because it is. The ONT knows exactly how much light it is receiving, whether it
has reached the operator's OLT, how many times it has rebooted today and why.
It measures all of this continuously. It just doesn't show you, and the person
on the phone reading a script doesn't either.

So: plug a laptop straight into the modem, and go and ask it.

It turns out you can find out a great deal more than is obvious. This tool is
what came out of that — a way to get the numbers off the box, watch them over
time, and work out **which part is actually broken**.

None of this is new ground. People have been scraping diagnostics out of
consumer modems for as long as consumer modems have had web interfaces, and
there are several good projects doing exactly that, listed under
[Related projects](#related-projects) below — including one that already
supports this specific device. This was written because I had a problem at
9pm on a weeknight and wanted a very small thing that would run right then, on
the laptop I had just plugged into the modem. If one of those others fits your
situation better, use it.

## What it can tell apart

That last part is the point. "The internet is down" has several very different
causes that look identical from the outside, and they need completely different
responses:

| The real problem | What the data looks like | What you do about it |
| --- | --- | --- |
| **The fibre itself** — a cut, a bend, a dirty connector, a dark port at the exchange | No light at all, or received power below about −28 dBm. No OLT ever seen. | A technician has to come out. Now you can say so with a number. |
| **The ONT's firmware or CPU** | Healthy light, OLT visible, but the box keeps restarting itself, or reports `Global Software Reset`, or the link never holds | Replacement hardware. No truck roll needed for the line. |
| **The optical module inside the ONT** | Transceiver reports no vendor, no model, no temperature, no voltage, no bias current | The ONT can't talk to its own optics. Replacement. |
| **Provisioning or the operator's side** | Good light, OLT reached, session established, then dropped — or never authorised at all | An account or configuration problem. No amount of rebooting fixes it. |
| **Everything downstream of the ONT** | ONT healthy and stable throughout | The fault is in your own router, cabling or Wi-Fi. |

Walking into a support call with *"my ONT is receiving −19.7 dBm from a Calix
OLT, so the line is fine, but it has logged 38 `Global Software Reset` events
in the last 24 hours"* is a categorically different conversation from *"my
light is blinking."* The first one is very hard to deflect.

## How it turned out, in that first case

Worth recording, because it is a good illustration of how the data can mislead
you if you read it in the wrong order.

The first readings looked like dead hardware. The optical interface reported
`NotPresent`. Received power: nothing. Transmitted power: `INT32_MIN`.
Transceiver temperature, voltage and bias current all zero. Every sign of an
optical module that had failed outright.

That was wrong. The modem was restarting every few minutes, and every sample
had landed in a boot window before the PON subsystem had finished initialising.
Once it stayed up long enough to be caught in a good moment, the same fields
read **−19.71 dBm received**, 2.61 dBm transmitted, 53 °C, and a healthy link
to a Calix E7 OLT.

The fibre was fine the whole time. The box was crashing.

That is the useful answer, and it arrived in an evening rather than in ten
days. Not a cut in the ground, not a dirty connector, not a dark port at the
exchange — the ONT itself, restarting on its own thirty-eight times in
twenty-four hours with zero power-loss and zero watchdog resets to explain it.
The fix is a replacement unit and a re-provision onto the new PON serial, which
is a very different job from digging up a driveway, and a much easier one to
argue for when you can hand over the numbers.

Whether that actually shortens a ten-day wait is up to the operator. But
"please replace my SmartNID, here is its reboot log and its optical power" is a
far better opening than "my light is blinking", and it at least removes the
risk of an engineer arriving to test a line that was never the problem.

Two lessons are baked into the tool as a result. **Read the reboot counters
before you trust anything else** — a device that restarts every few minutes
resets all of its own statistics, so every other number looks reassuringly
fresh while the service is entirely down. And **take more than one sample**,
which is what the monitoring mode is for.

---

Developed against a **Quantum Fiber Q1000K SmartNID** (Adtran / Axon Networks,
firmware `QKX002-06.01.25.00`). It should work on related CenturyLink,
Brightspeed and Lumen CPE sharing the same management UI, and the `discover`
command exists to re-map the API if yours differs.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Keeping the diagnostic link off the internet](#keeping-the-diagnostic-link-off-the-internet)
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
- [Related projects](#related-projects)
- [Acknowledgements](#acknowledgements)
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

You need to be on the modem's own network. Run an Ethernet cable from your
machine into one of the modem's LAN ports; it will hand you an address on
`192.168.0.x`. This works even when the internet is completely down, which is
rather the point.

```sh
node src/cli.ts setup      # store modem address + credentials, once
node src/cli.ts status     # one snapshot of the link
node src/cli.ts serve      # live dashboard on http://localhost:8477
```

The admin password is on the sticker on the device, labelled `Admin Password`
(not the Wi-Fi password). `setup` prompts for it with the input masked and
writes `fiber.config.json`, which is gitignored and created mode `0600`.

If the link is intermittent, leave `serve` running. A single reading during a
flap tells you very little; a night of them tells you almost everything.

## Keeping the diagnostic link off the internet

Cabling a machine into the ONT gives the operating system a second path to the
internet, and it may well prefer it. On the machine this was developed on,
Windows gave the Ethernet adapter an interface metric of 25 against the Wi-Fi
adapter's 30, so general traffic and DNS were both routed through the modem
under investigation — an unwanted path, and an intermittent one given that the
modem was rebooting every few minutes.

Raising the interface metric is not enough on its own. It only deprioritises
the route; the default gateway still exists and Windows can still select it,
for instance when the preferred adapter briefly drops. The fix is to remove the
gateway from that adapter entirely, leaving only the on-link route to the
modem's subnet.

`scripts/Set-ModemNic.ps1` does this. Run it from an **elevated** PowerShell:

```powershell
cd D:\source\fiber\scripts
.\Set-ModemNic.ps1
```

It saves the current configuration to `nic-backup-<adapter>.json`, then
switches the adapter to a static address with **no default gateway and no DNS
servers**, sets a high interface metric as a second line of defence, and takes
the connection out of DNS registration. It finishes by checking that the modem
is still reachable and that internet traffic now resolves to a different
adapter.

To undo it:

```powershell
.\Set-ModemNic.ps1 -Revert
```

Two things worth knowing:

- The default static address is `192.168.0.250`. The modem's DHCP pool usually
  spans the whole subnet, so any static address technically overlaps it; these
  servers allocate from the bottom of the range, which makes a high address the
  safer pick once this machine stops renewing a lease. Override with
  `-IPAddress` if your subnet differs.
- Because the adapter becomes static, it will not work on a different network
  until you run `-Revert`. If you move the machine around, prefer reverting
  first.

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

It is deliberately cautious: strictly one request at a time with a delay, it
detects a catch-all page before wasting probes on a wordlist, and it refuses to
request any path that looks destructive — reboot, restore-defaults,
firmware-upgrade and similar — because the candidate list is harvested from the
device's own UI and therefore names every route the device knows.

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
and readable by anything.

```json
{
  "ts": "2026-09-06T21:08:56.089Z",
  "reachable": true,
  "latencyMs": 26,
  "uptimeSec": 1502,
  "rebootCount24h": 38,
  "opticalStatus": "Up",
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

Reboot behaviour is checked **first**, deliberately, for the reason described
at the top of this file.

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

I could not find this interface documented publicly, so it had to be worked out
from the device. If there is a better reference somewhere, I would rather point
at it than at this.

The management UI is a React single-page app that queries a TR-181 data model
through a CGI bridge. Guessing endpoints got nowhere — every path returned the
same 347-byte application shell. What worked was reading the UI's own
JavaScript: the app is code-split, and the entry bundle embeds the complete
webpack chunk manifest, so all 170 chunks of post-login code can be fetched and
read **without authenticating**. A single-page app has to name every URL it
calls, which makes its bundles a far better source of truth than any wordlist.

```text
POST /cgi/cgi_action   body: username=<u>&password=<p>          -> Session-Id cookie
GET  /cgi/cgi_get?Object=<path>&<Field>=&<Field>=               -> JSON
POST /cgi/cgi_set      body: Object=<path>&Operation=Modify&..  -> JSON
GET  /cgi/cgi_action?Action=Logout
```

Notes:

- Every request carries `X-Requested-With: XMLHttpRequest`. Treat it as
  load-bearing; it is a CSRF guard, not decoration.
- Omitting the `&Field=` filters returns every parameter of an object. The API
  is generic, so it cannot hide fields merely because the UI does not show them.
- Several queries can be combined by joining them with commas.
- `cgi_set` is a POST carrying the query string as the **body**. Sending the
  same thing as a GET query returns 404.
- Logout must go to `cgi_action`. Sending it to `cgi_get` returns 200 and
  leaves the session completely valid.
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

Each of these will silently corrupt readings if you do not handle it.

- **Optical power is in thousandths of a dBm**, not the 0.1 dBm units TR-181
  specifies. The divisor here is taken from the device's own UI, not the spec.
  Using the documented one would put every reading out by a factor of 100.
- **`-2147483648` (INT32_MIN) means "no reading"**, not a value. Dividing it
  by 1000 would print `-2147483.6 dBm`. A reported `0` is also a sentinel; 0 dBm
  is not a physically plausible level on a PON.
- **Object names are inconsistent.** Queried alone an object returns as
  `Device.DeviceInfo`; combined with a second query in the same request it
  returns as `Device.DeviceInfo.` with a trailing dot. Names are normalised to
  a canonical trailing-dot form before lookup.
- **`Status` is not always truthful.** This firmware has reported `NotPresent`
  while simultaneously returning a healthy received level, a real transceiver
  temperature and a reachable OLT. Corroborate it against the power readings.
- **Field filters matter.** An unfiltered `Object=Device.DeviceInfo` drags back
  every child object including 269 logger entries. Adding filters took a poll
  from 323 ms to 24 ms.
- **The web server is fragile.** Embedded lighttpd with very few connection
  slots. Three concurrent requests were enough to wedge it during development,
  after which it accepted TCP connections but answered nothing until it
  restarted. Everything here is strictly serial with backoff.

## Interpreting readings

### Read the reboot counters first

If the device is restarting repeatedly, treat every other counter with
suspicion. A modem sampled mid-boot reports its optical interface as
`NotPresent` with zero temperature, voltage and bias current — indistinguishable
from genuinely dead optics.

### Received optical power

For GPON class B+, roughly:

| Reading | Meaning |
| --- | --- |
| −8 to −27 dBm | Within spec. |
| −28 to −33 dBm | Marginal. Expect flapping. |
| Below −35, or no reading | No usable light: a cut, a dirty connector, or a dark OLT port. |

Light with no session is a different fault from no light at all. Good rx power
plus `linkUpTimeSec: 0` points at ranging, OMCI or provisioning, not at the
glass. A handheld optical power meter measures only the first of these; the ONT
tells you both, for free.

### PON generation

The WAN log reports the negotiated rates. `downlink:2488000 uplink:1244000` is
2.488G/1.244G, which is **GPON**. XGS-PON would be roughly 9.95G symmetric.
This matters if you are considering a third-party SFP+ ONT stick, since the
common WAS-110 class modules are XGS-PON only and would be the wrong hardware.

### Reboot reason

`Device.DeviceInfo.X_AXON_SystemRebootInfo.` separates the causes, and the
distinction is the diagnosis:

| Counter | Means |
| --- | --- |
| `PowerOnResetCount` | Actual power loss. |
| `WatchdogResetCount` | The CPU hung and the watchdog fired. |
| `GlobalSoftwareResetCount` | The firmware chose to restart itself. |
| `FactoryResetCount` | Configuration was wiped. |

A box with zero power-on and zero watchdog resets but dozens of software resets
is not suffering a power problem or a hung CPU. It is deciding to restart, over
and over, which is a firmware fault and an argument for replacement hardware.

### Enabling the device system log

The system log ships disabled and records WAN state transitions with
timestamps, which is exactly what you want when chasing a flap. To turn it on
with save-on-reboot:

```text
POST /cgi/cgi_set
Object=Device.X_AXON_Systemlog&Operation=Modify&State=Enabled%2dSave
Object=Device.X_AXON_Systemlog&Operation=Modify&Enable=1
```

Both are needed; setting `State` alone leaves `Enable` at `0` and the log stays
empty. Read it back with `Object=SystemLog`; the response shape differs from
other objects. This writes a setting to the modem's flash and is reversible
from the UI under Utilities.

The log is worth the trouble. It is what showed the WAN reaching `Status
Connected` with a real public address and full line rates, then dropping again
about a minute later — proof the line worked and the box did not.

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
does not belong in a public repository. The example values above use a
placeholder FSAN for the same reason.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Dashboard unreachable at `localhost` but fine at `127.0.0.1` | An older build bound IPv4 only. Current code binds both loopback families. |
| `Login rejected` | Wrong password. Use the `Admin Password` from the device label, not the Wi-Fi key. |
| Every query returns 444 | The session was not established. Check credentials; the client retries once automatically. |
| Requests time out, but ping and TCP connect succeed | The modem's web server is wedged. Stop polling and give it a few minutes. |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node is too old, or code used non-erasable TypeScript syntax. |
| Optical fields all null or zero | Probably sampled during boot. Check `uptimeSec` before concluding anything. |

## Related projects

Plenty of people have solved parts of this already, and several of these are
more capable than this one. Depending on what you need, start here rather than
with this.

**The closest overlap** is
[Ozark-Connect/NetworkOptimizer](https://github.com/Ozark-Connect/NetworkOptimizer),
a self-hosted monitoring and audit suite for UniFi networks. It lists the
Q1000K SmartNID by name and polls RX/TX optical power, temperature, voltage and
bias current from the ONT directly, charting them in InfluxDB alongside
everything else on the network. If you already run UniFi and want fibre
readings folded into a single pane of glass with history, look there first. It
is .NET and Blazor, expects a UniFi Console, and brings a time-series database
with it — which is exactly right for continuous operations and rather more than
you want to stand up at 9pm on the night your connection died.

Others, by category:

- **SFP/SFP+ DOM on your own machine** —
  [aleksander0m/fiberstat](https://github.com/aleksander0m/fiberstat) reads
  RX/TX levels from optical modules in local interfaces. Useful if the fibre
  terminates in your own hardware rather than an operator-supplied ONT.
- **ONT sticks** — [Strykar/GPON](https://github.com/Strykar/GPON) pulls
  DDM-grade telemetry from HSGQ/ODI GPON SFP ONUs over SSH into Prometheus and
  Grafana. Relevant if you have replaced the operator's box with a module.
- **Same technique, different device** —
  [mcbyte-it/fiberhome_exporter](https://github.com/mcbyte-it/fiberhome_exporter)
  is a Prometheus exporter for the FiberHome HG6145F that logs into the web UI
  and reads its JSON API. The approach here is the same; only the firmware
  differs.
- **Reverse-engineering ONT firmware** —
  [Anime4000/RTL960x](https://github.com/Anime4000/RTL960x) and the
  [hack-gpon](https://github.com/hack-gpon/hack-gpon.github.io) documentation
  project are the places to go for getting inside the hardware itself.
- **Cable modems** — [tc4400_exporter](https://github.com/markuslindenberg/tc4400_exporter),
  [hitron_coda_exporter](https://github.com/hairyhenderson/hitron_coda_exporter)
  and similar apply the same scrape-the-admin-page pattern to DOCSIS.
- **Outage evidence without device telemetry** —
  [FutureSolutionDev/internet-monitor](https://github.com/FutureSolutionDev/internet-monitor)
  and [gitbls/internet-monitor](https://github.com/gitbls/internet-monitor)
  record connectivity loss with timestamps for ISP tickets. They tell you
  *that* you were down, not *why*.
- **Operator side** — [bartekkois/GPONMonitor](https://github.com/bartekkois/GPONMonitor)
  monitors Dasan OLTs. That is the other end of the fibre, and needs access
  most subscribers do not have.

### Why this one exists anyway

Not because the others are lacking. Mostly because of when and how it was
needed:

- **It had to run immediately, with nothing else installed.** No database, no
  container, no controller, no dependencies. That is a constraint born of the
  situation rather than a design philosophy, and it is the main reason this
  is a separate thing rather than a patch to something better.
- **What mattered turned out not to be optical power.** Most tools in this
  space graph light levels, sensibly, because that is usually the fault. Here
  the line was healthy the whole time and the answer was in the reboot
  counters, the reboot *reason*, and the device log. So the health rules are
  built around distinguishing causes rather than charting one number.
- **The device's API had to be worked out from scratch.** `discover` derives
  endpoints from the UI's own JavaScript instead of hard-coding them, which is
  what made this box supportable at all.

If the CGI/TR-181 details in this README are useful to any of the projects
below, please take them — I could not find this interface documented publicly,
and I would genuinely rather it lived somewhere more established than here. If
it *is* already documented somewhere, tell me and I will link to it instead.

## Acknowledgements

The approach here is not original, and several projects and communities made it
much easier:

- **[Ozark-Connect/NetworkOptimizer](https://github.com/Ozark-Connect/NetworkOptimizer)**
  for demonstrating that the Q1000K's optical fields are reachable at all, and
  for covering this device properly inside a real monitoring system.
- **[hack-gpon](https://github.com/hack-gpon/hack-gpon.github.io)** and
  **[Anime4000/RTL960x](https://github.com/Anime4000/RTL960x)**, whose
  documentation of ONT internals, PON identity attributes and vendor quirks is
  the reference material for this entire area.
- **[mcbyte-it/fiberhome_exporter](https://github.com/mcbyte-it/fiberhome_exporter)**,
  **[markuslindenberg/tc4400_exporter](https://github.com/markuslindenberg/tc4400_exporter)**
  and **[hairyhenderson/hitron_coda_exporter](https://github.com/hairyhenderson/hitron_coda_exporter)**
  for the log-in-and-read-the-admin-API pattern that this follows.
- **[aleksander0m/fiberstat](https://github.com/aleksander0m/fiberstat)** and
  **[Strykar/GPON](https://github.com/Strykar/GPON)** for showing what good
  optical telemetry looks like when you own the module.
- The Broadband Forum's TR-181 data model, which is why an unfamiliar device
  could be interrogated with standard object paths at all.

## Licence

MIT. See [LICENSE](LICENSE).
