# fiber-monitor

Direct diagnostics and optical-power monitoring for a Quantum Fiber ONT
(Q1000K SmartNID and relatives), talking to the device on the LAN rather than
through any vendor cloud service.

Built for the case where the link is down or flapping and the ISP cannot tell
you why: connect a machine straight to the modem, find out what the box
actually reports, and log it over time so intermittent faults leave a trace.

## Requirements

- Node.js 22.6 or newer. Nothing else.

There are no dependencies and no build step. Node strips the TypeScript types
at load time, so `src/` runs as-is on Windows and on Linux.

## Quick start

```sh
node src/cli.ts setup      # store modem address + credentials, once
node src/cli.ts status     # one snapshot of the link
node src/cli.ts serve      # live dashboard on http://localhost:8477
```

`serve` polls and serves a dashboard in one process. `monitor` does the same
polling without the web server, and `discover` maps the device's endpoints
from scratch if you point this at different hardware.

`discover` fingerprints the device, scrapes the management UI's own JavaScript
for the endpoints it calls, probes a wordlist of PON and optical paths as a
backstop, and ranks everything it finds by how much optical-diagnostic content
it contains. The full result lands in `data/discovery-<timestamp>.json`.

To look at a single endpoint:

```sh
node src/cli.ts probe /api/v1/status
node src/cli.ts probe /modemstatus_ponstatus.html --raw
```

## Configuration

Settings are merged from three sources, each overriding the one before it:

| Source | Use for |
| --- | --- |
| `fiber.config.json` | Permanent local settings. Gitignored. Written by `setup`. |
| `FIBER_HOST`, `FIBER_USER`, `FIBER_PASS` | One-off overrides. |
| `--host`, `--user`, `--pass`, `--interval`, `--port`, `--timeout` | Single invocation. |

See `fiber.config.example.json` for the full shape.

## What is not in this repository

`.gitignore` excludes `fiber.config.json` and the whole `data/` directory.

That is deliberate and matters more than usual here. Discovery reports contain
the ONT serial number and WAN MAC address, and on a PON network the serial
*is* the subscriber identity the OLT authenticates against. It is not a
password, but it does not belong in a public repository.

## Security note

The HTTP client accepts the modem's self-signed certificate. There is no CA to
trust: the device signs its own certificate, and it will never be valid. The
bypass is applied per request rather than through the process-wide
`NODE_TLS_REJECT_UNAUTHORIZED`, and `assertPrivateHost()` refuses to target any
address outside RFC 1918, loopback, link-local or CGNAT space, so the relaxed
verification cannot be pointed at the public internet.

## What it reads

The management UI is a React app that queries a TR-181 data model through a CGI
bridge. Reading the UI's own JavaScript revealed the interface:

```
POST /cgi/cgi_action   username=<u>&password=<p>        -> Session-Id cookie
GET  /cgi/cgi_get?Object=<path>&<Field>=&<Field>=       -> JSON
POST /cgi/cgi_set      body: Object=<path>&Operation=.. -> JSON
```

HTTP 444 is this firmware's "no session" status rather than a transport error.

Three firmware quirks are handled explicitly, each of which silently corrupts
readings otherwise:

- Optical power is reported in thousandths of a dBm, not the 0.1 dBm units
  TR-181 specifies. The divisor is taken from the device's own UI.
- `-2147483648` (INT32_MIN) means "no reading", not a value.
- An object queried alone returns as `Device.DeviceInfo`, but combined with a
  second query it returns as `Device.DeviceInfo.` with a trailing dot.

## Reading the output during a reboot loop

If the device is restarting repeatedly, treat every counter with suspicion.
A modem sampled mid-boot reports its optical interface as `NotPresent` with
zero temperature, voltage and bias current, which is indistinguishable from
genuinely dead optics. The same device, once it stays up, may report a
perfectly healthy received level. `classify()` checks reboot behaviour first
for this reason, and the uptime chart exists to make the pattern obvious.

## Status

Working: endpoint discovery, authenticated TR-181 queries, sampling to a
JSON Lines log, health classification, and a live dashboard.

Not done: alert delivery (email/webhook), and parsing the device system log
into the sample stream.

## Licence

MIT. See `LICENSE`.
