/**
 * Client for the Quantum Fiber / Adtran CPE management API.
 *
 * The web UI is a React app that queries a TR-181 data model through a CGI
 * bridge. Two endpoints matter:
 *
 *   POST /cgi/cgi_action        body: username=<u>&password=<p>   -> Session-Id cookie
 *   GET  /cgi/cgi_get?Object=<path>&<Field>=&<Field>=             -> JSON
 *
 * Several queries may be combined by joining them with commas. Omitting the
 * field filters returns every parameter of the object, which is what we want:
 * the API is generic, so it cannot hide fields merely because the UI does not
 * render them.
 *
 * HTTP 444 is this firmware's "no valid session" status, not a transport error.
 */
import { request, CookieJar, type CertInfo } from './net.ts';
import type { Config } from './config.ts';

/** TR-181 uses INT32_MIN to mean "this parameter has no valid reading". */
export const NO_VALUE = -2147483648;

/** Objects are returned as ObjName -> { ParamName: ParamValue }. */
export type ObjectMap = Record<string, Record<string, string>>;

interface CgiParam {
  ParamName: string;
  ParamValue: string;
}
interface CgiObject {
  ObjName: string;
  Param: CgiParam[];
}
interface CgiResponse {
  Objects?: CgiObject[];
}

export class AuthError extends Error {}

export class ModemClient {
  private jar = new CookieJar();
  private base: string;
  private loggedIn = false;
  /** Certificate from the most recent handshake; validFrom approximates last boot. */
  lastCert?: CertInfo;

  // Declared explicitly rather than as a constructor parameter property:
  // Node's type-stripping only erases syntax, and a parameter property emits
  // an assignment, so it is rejected in a no-build setup.
  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.base = 'https://' + cfg.host;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      // The CGI backend expects the XHR marker the UI always sends; treat it as
      // load-bearing rather than cosmetic.
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    };
  }

  async login(): Promise<void> {
    if (!this.cfg.password) {
      throw new AuthError('No password configured. Run: node src/cli.ts setup');
    }

    // Load the login page first so any pre-session cookie is captured.
    await request(this.base + '/login.html', { jar: this.jar, timeoutMs: this.cfg.timeoutMs });

    const body =
      'username=' + encodeURIComponent(this.cfg.username ?? 'admin') +
      '&password=' + encodeURIComponent(this.cfg.password);

    const res = await request(this.base + '/cgi/cgi_action', {
      jar: this.jar,
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body,
      timeoutMs: this.cfg.timeoutMs,
    });

    if (res.cert) this.lastCert = res.cert;

    if (res.error) throw new AuthError('Login request failed: ' + res.error);
    // The device answers 200 with an empty body on success and sets Session-Id.
    if (res.status !== 200 || !this.jar.get('Session-Id')) {
      throw new AuthError(
        'Login rejected (status ' + res.status + '). Check the admin password on the device label.',
      );
    }
    this.loggedIn = true;
  }

  /**
   * Query one or more TR-181 objects.
   *
   * `objects` are query fragments such as 'Device.Optical.Interface.1.' or
   * 'Device.DeviceInfo&ModelName=&SerialNumber='. Re-authenticates once on 444.
   */
  async cgiGet(objects: string[], retry = true): Promise<ObjectMap> {
    if (!this.loggedIn) await this.login();

    const query = objects.map((o) => 'Object=' + o).join(',');
    const res = await request(this.base + '/cgi/cgi_get?' + query, {
      jar: this.jar,
      headers: this.headers(),
      timeoutMs: this.cfg.timeoutMs,
    });

    if (res.cert) this.lastCert = res.cert;

    if (res.status === 444) {
      // Session expired or was never valid.
      this.loggedIn = false;
      if (!retry) throw new AuthError('Session rejected (444) after re-login.');
      await this.login();
      return this.cgiGet(objects, false);
    }

    if (res.error) throw new Error('Query failed: ' + res.error);
    if (res.status !== 200) throw new Error('Query returned HTTP ' + res.status);

    return parseCgiResponse(res.body);
  }

  /**
   * Write a setting through the CGI bridge.
   *
   * `query` is a raw, already-encoded query string, e.g.
   *   'Object=Device.X_AXON_Systemlog&Operation=Modify&State=Enabled%2dSave'
   * It is passed through untouched because the firmware expects specific
   * percent-encoding (%2d for the hyphen) that re-encoding would corrupt.
   *
   * Unlike cgi_get, this is a POST carrying the query string as the body;
   * sending it as a GET query returns 404.
   */
  async cgiSet(query: string, retry = true): Promise<string> {
    if (!this.loggedIn) await this.login();

    const res = await request(this.base + '/cgi/cgi_set', {
      jar: this.jar,
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: query,
      // Writes commit to flash and are markedly slower than reads.
      timeoutMs: Math.max(this.cfg.timeoutMs, 30000),
    });

    if (res.status === 444) {
      this.loggedIn = false;
      if (!retry) throw new AuthError('Session rejected (444) after re-login.');
      await this.login();
      return this.cgiSet(query, false);
    }
    if (res.error) throw new Error('Set failed: ' + res.error);
    if (res.status !== 200) throw new Error('Set returned HTTP ' + res.status);
    return res.body;
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    await request(this.base + '/cgi/cgi_get?Object=Action=Logout', {
      jar: this.jar,
      headers: this.headers(),
      timeoutMs: this.cfg.timeoutMs,
    }).catch(() => undefined);
    this.jar.clear();
    this.loggedIn = false;
  }
}

/** Flatten the Objects/Param envelope into ObjName -> { param: value }. */
export function parseCgiResponse(body: string): ObjectMap {
  let parsed: CgiResponse;
  try {
    parsed = JSON.parse(body) as CgiResponse;
  } catch (e) {
    throw new Error('Response was not JSON: ' + (e as Error).message);
  }

  const out: ObjectMap = {};
  for (const obj of parsed.Objects ?? []) {
    const fields: Record<string, string> = {};
    for (const p of obj.Param ?? []) fields[p.ParamName] = p.ParamValue;
    out[canonical(obj.ObjName)] = fields;
  }
  return out;
}

/**
 * Normalise an object name to a canonical trailing-dot form.
 *
 * The firmware is inconsistent: queried on its own an object is returned as
 * 'Device.DeviceInfo', but combined with a second query in the same request it
 * comes back as 'Device.DeviceInfo.'. Without normalising, a lookup silently
 * misses and every field reads as null.
 */
export function canonical(objName: string): string {
  return objName.endsWith('.') ? objName : objName + '.';
}

/**
 * Read a numeric parameter, returning null for absent values.
 *
 * Two sentinels mean "no reading": INT32_MIN, which the firmware uses for
 * unavailable optical parameters, and the empty string.
 */
export function num(fields: Record<string, string> | undefined, name: string): number | null {
  if (!fields) return null;
  const raw = fields[name];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === NO_VALUE) return null;
  return n;
}

/**
 * Optical power in dBm.
 *
 * This firmware reports thousandths of a dBm, which the UI divides by 1000.
 * That differs from the TR-181 specification's units of 0.1 dBm, so the
 * divisor is deliberately taken from the device's own UI rather than the spec.
 */
export function dbm(fields: Record<string, string> | undefined, name: string): number | null {
  const raw = num(fields, name);
  if (raw === null) return null;
  // A reading of exactly zero is the firmware's other way of saying "nothing
  // here"; 0 dBm would be a physically implausible level on a PON.
  if (raw === 0) return null;
  return raw / 1000;
}
