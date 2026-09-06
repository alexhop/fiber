/**
 * Minimal HTTP(S) client for talking to consumer modems.
 *
 * Uses node:http / node:https directly rather than global fetch because we need
 * three things fetch will not give us:
 *   1. Per-request acceptance of self-signed certificates (the modem's cert is
 *      never trusted) without poisoning the whole process with
 *      NODE_TLS_REJECT_UNAUTHORIZED=0.
 *   2. The peer certificate itself -- Adtran/Calix ONTs frequently encode the
 *      model and serial number in the Subject CN, which is free identity data.
 *   3. Raw Set-Cookie headers, for the session cookies these UIs hand out.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { TLSSocket, PeerCertificate } from 'node:tls';

export interface CertInfo {
  subject?: Record<string, string>;
  issuer?: Record<string, string>;
  validFrom?: string;
  validTo?: string;
  fingerprint?: string;
  serialNumber?: string;
  subjectAltName?: string;
}

export interface Response {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: string;
  bodyBytes: number;
  contentType: string;
  elapsedMs: number;
  cert?: CertInfo;
  error?: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Milliseconds before the socket is torn down. Modems are slow; default 8s. */
  timeoutMs?: number;
  /** Cap on stored body so a firmware image download cannot exhaust memory. */
  maxBytes?: number;
  /** Follow 3xx responses. Modem UIs bounce http to https and / to /login constantly. */
  followRedirects?: number;
  jar?: CookieJar;
  /** Pin the outbound interface. Relevant here: this host has two default routes. */
  localAddress?: string;
}

/**
 * Cookie storage scoped to a single host. Deliberately not RFC 6265 compliant:
 * we ignore Domain and Path because we only ever talk to one device, and modem
 * firmware sets cookies with paths that do not match the endpoints needing them.
 */
export class CookieJar {
  private cookies = new Map<string, string>();

  absorb(headers: Record<string, string | string[]>): void {
    const raw = headers['set-cookie'];
    if (!raw) return;
    for (const line of Array.isArray(raw) ? raw : [raw]) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An empty value, or an expiry in the past, means the server is deleting it.
      if (value === '' || /expires=\w+,\s*\d+[-\s]\w+[-\s]19\d\d/i.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => k + '=' + v).join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }

  clear(): void {
    this.cookies.clear();
  }
}

function describeCert(socket: TLSSocket): CertInfo | undefined {
  let cert: PeerCertificate;
  try {
    cert = socket.getPeerCertificate();
  } catch {
    return undefined;
  }
  if (!cert || Object.keys(cert).length === 0) return undefined;
  return {
    subject: cert.subject as unknown as Record<string, string>,
    issuer: cert.issuer as unknown as Record<string, string>,
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    fingerprint: cert.fingerprint,
    serialNumber: cert.serialNumber,
    subjectAltName: cert.subjectaltname,
  };
}

function errorResponse(url: string, message: string, elapsedMs: number): Response {
  return {
    url,
    status: 0,
    statusText: '',
    headers: {},
    body: '',
    bodyBytes: 0,
    contentType: '',
    elapsedMs,
    error: message,
  };
}

/** Single request, no redirect following. Never throws; failures come back as `error`. */
function requestOnce(url: string, opts: RequestOptions): Promise<Response> {
  return new Promise((resolve) => {
    const started = Date.now();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(errorResponse(url, 'invalid url', 0));
      return;
    }

    const secure = parsed.protocol === 'https:';
    const timeoutMs = opts.timeoutMs ?? 8000;
    const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;

    const headers: Record<string, string> = {
      // Some firmware serves a stripped-down page to unknown agents, so we
      // present as an ordinary browser.
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      connection: 'close',
      ...(opts.headers ?? {}),
    };

    const cookie = opts.jar?.header();
    if (cookie && !headers.cookie) headers.cookie = cookie;
    if (opts.body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }

    const transport = secure ? https : http;
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (secure ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? 'GET',
        headers,
        localAddress: opts.localAddress,
        // The modem's certificate is self-signed and always will be. We accept it
        // knowingly; this client only ever speaks to a device on the local LAN.
        rejectUnauthorized: false,
        // Old firmware negotiates ciphers modern Node refuses by default.
        minVersion: 'TLSv1',
        ciphers: 'DEFAULT:@SECLEVEL=0',
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (!truncated && total <= maxBytes) {
            chunks.push(chunk);
          } else {
            truncated = true;
          }
        });
        res.on('end', () => {
          const socket = req.socket as TLSSocket | undefined;
          resolve({
            url,
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString('utf8'),
            bodyBytes: total,
            contentType: String(res.headers['content-type'] ?? ''),
            elapsedMs: Date.now() - started,
            cert: secure && socket ? describeCert(socket) : undefined,
          });
        });
        res.on('error', (e: Error) =>
          resolve(errorResponse(url, e.message, Date.now() - started)),
        );
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout after ' + timeoutMs + 'ms'));
    });
    req.on('error', (e: Error) => resolve(errorResponse(url, e.message, Date.now() - started)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Request with redirect following and cookie persistence. */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const maxHops = opts.followRedirects ?? 5;
  let current = url;
  let hops = 0;
  let method = opts.method ?? 'GET';
  let body = opts.body;

  for (;;) {
    const res = await requestOnce(current, { ...opts, method, body });
    opts.jar?.absorb(res.headers);

    const location = res.headers['location'];
    if (!(res.status >= 300 && res.status < 400 && location) || hops >= maxHops) {
      return { ...res, url: current };
    }

    const target = Array.isArray(location) ? location[0] : location;
    try {
      current = new URL(target, current).toString();
    } catch {
      return { ...res, url: current };
    }
    hops += 1;
    // 303, and 301/302 by universal convention, degrade to GET.
    if (res.status !== 307 && res.status !== 308) {
      method = 'GET';
      body = undefined;
    }
  }
}
