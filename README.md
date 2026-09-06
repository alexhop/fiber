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
node src/cli.ts discover   # map every endpoint the modem exposes
```

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

## Status

Working: device fingerprinting, endpoint discovery, single-endpoint probing.

Next: authenticated sessions, optical-power sampling to a time-series log, a
local dashboard, and threshold alerting.

## Licence

MIT. See `LICENSE`.
