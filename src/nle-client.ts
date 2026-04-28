/**
 * Thin HTTP + SSE client for the No Longer Evil self-hosted control server.
 *
 * Endpoints used (docs.nolongerevil.com):
 *  - GET  /api/devices               -> list registered thermostats
 *  - GET  /status?serial=<serial>    -> current state of one thermostat
 *  - POST /command                   -> mutate state ({ serial, command, value })
 *  - GET  /api/events                -> SSE stream of {"serial":"..."} change notifications
 *
 * The server has no authentication by default; users secure it with a reverse proxy.
 *
 * @file nle-client.ts
 * @license Apache-2.0
 */

import type { NleStatus } from './matter-mapping.js';

/** A device entry returned by GET /api/devices. */
export interface NleDevice {
  id: string;
  serial: string;
  name: string | null;
  accessType?: string;
}

/** Commands accepted by POST /command for thermostat control. */
export type NleCommand =
  | { command: 'set_temperature'; value: number | { high: number; low: number } }
  | { command: 'set_mode'; value: 'off' | 'heat' | 'cool' | 'heat-cool' | 'emergency' }
  | { command: 'set_away'; value: boolean };

/**
 * Initial reconnect delay for the SSE subscription in milliseconds.
 * The delay doubles on each consecutive failure up to {@link SSE_MAX_BACKOFF_MS}.
 */
const SSE_INITIAL_BACKOFF_MS = 1000;

/** Cap on the SSE reconnect delay. */
const SSE_MAX_BACKOFF_MS = 30_000;

/**
 * Trim a single trailing slash from a base URL so concatenated paths don't end up with `//`.
 *
 * @param {string} base Raw base URL string.
 * @returns {string} The base URL without a trailing slash.
 */
function trimSlash(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

/**
 * Throw a descriptive error if a fetch Response is not OK.
 *
 * @param {Response} response The fetch response to validate.
 * @param {string} context A short human-readable description of the request.
 * @returns {Promise<void>} Resolves when the response is OK.
 */
async function ensureOk(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  let body = '';
  try {
    body = await response.text();
  } catch {
    // ignore body read errors
  }
  throw new Error(`${context} failed: HTTP ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
}

/**
 * List thermostats registered with the No Longer Evil control server.
 *
 * @param {string} apiUrl Base URL of the control server (e.g. http://host:8082).
 * @param {AbortSignal} [signal] Optional abort signal.
 * @returns {Promise<NleDevice[]>} The devices array (empty when none are registered).
 */
export async function listDevices(apiUrl: string, signal?: AbortSignal): Promise<NleDevice[]> {
  const response = await fetch(`${trimSlash(apiUrl)}/api/devices`, { signal });
  await ensureOk(response, 'GET /api/devices');
  const body = (await response.json()) as { devices?: NleDevice[] };
  return Array.isArray(body.devices) ? body.devices : [];
}

/**
 * Fetch the current state of one thermostat.
 *
 * @param {string} apiUrl Base URL of the control server.
 * @param {string} serial Device serial number.
 * @param {AbortSignal} [signal] Optional abort signal.
 * @returns {Promise<NleStatus>} The status payload.
 */
export async function getStatus(apiUrl: string, serial: string, signal?: AbortSignal): Promise<NleStatus> {
  const url = `${trimSlash(apiUrl)}/status?serial=${encodeURIComponent(serial)}`;
  const response = await fetch(url, { signal });
  await ensureOk(response, `GET /status?serial=${serial}`);
  return (await response.json()) as NleStatus;
}

/**
 * Send a command to a thermostat via POST /command.
 *
 * @param {string} apiUrl Base URL of the control server.
 * @param {string} serial Device serial number.
 * @param {NleCommand} command Command name and value.
 * @param {AbortSignal} [signal] Optional abort signal.
 * @returns {Promise<void>} Resolves when the server accepts the command.
 */
export async function sendCommand(apiUrl: string, serial: string, command: NleCommand, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${trimSlash(apiUrl)}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serial, ...command }),
    signal,
  });
  await ensureOk(response, `POST /command (${command.command})`);
}

/**
 * Parse one chunk of SSE wire data, calling {@link onSerial} for each event whose data field
 * decodes to JSON containing a "serial" string.
 *
 * Edge cases:
 *  - Lines that are not valid JSON are ignored (the spec allows comments and keep-alives).
 *  - Missing "serial" fields are ignored.
 *
 * @param {string} chunk Trimmed SSE event block (everything between two blank lines).
 * @param {(serial: string) => void} onSerial Called once per parsed event.
 */
function parseEventBlock(chunk: string, onSerial: (serial: string) => void): void {
  const dataLines: string[] = [];
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as { serial?: unknown };
    if (typeof parsed.serial === 'string' && parsed.serial.length > 0) {
      onSerial(parsed.serial);
    }
  } catch {
    // Malformed event payload — ignore per SSE robustness guidelines.
  }
}

/**
 * Read one SSE response body to completion, dispatching each event.
 *
 * @param {ReadableStream<Uint8Array>} body The fetch response body stream.
 * @param {(serial: string) => void} onSerial Callback for each parsed serial.
 * @returns {Promise<void>} Resolves when the stream ends.
 */
async function consumeEventStream(body: ReadableStream<Uint8Array>, onSerial: (serial: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (block.trim().length > 0) parseEventBlock(block, onSerial);
      separator = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim().length > 0) parseEventBlock(buffer, onSerial);
}

/** Lifecycle hooks invoked by {@link subscribeEvents}. */
export interface SseHooks {
  /** Called for every parsed device-change event. */
  onSerial: (serial: string) => void;
  /** Called once each time the stream successfully establishes. */
  onConnect?: () => void;
  /** Called when the stream ends cleanly (server closed the connection without error). */
  onDisconnect?: () => void;
  /** Called when a connect or stream-read attempt fails. */
  onError: (error: unknown) => void;
}

/**
 * Subscribe to the No Longer Evil SSE event stream until the given AbortSignal aborts.
 *
 * Reconnect strategy: exponential backoff starting at 1s, doubling per failure, capped at 30s.
 * Some servers and reverse proxies close idle SSE connections every 30–60 s; this loop reconnects
 * automatically. On clean stream end the loop reconnects immediately and {@link SseHooks.onDisconnect}
 * fires; on errors {@link SseHooks.onError} fires.
 *
 * @param {string} apiUrl Base URL of the control server.
 * @param {AbortSignal} signal Caller-controlled abort signal; aborting ends the loop.
 * @param {SseHooks} hooks Lifecycle callbacks.
 * @returns {Promise<void>} Resolves once {@link signal} aborts.
 */
export async function subscribeEvents(apiUrl: string, signal: AbortSignal, hooks: SseHooks): Promise<void> {
  let backoff = SSE_INITIAL_BACKOFF_MS;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${trimSlash(apiUrl)}/api/events`, {
        signal,
        headers: { accept: 'text/event-stream' },
      });
      await ensureOk(response, 'GET /api/events');
      if (!response.body) throw new Error('GET /api/events returned no body');
      backoff = SSE_INITIAL_BACKOFF_MS;
      hooks.onConnect?.();
      await consumeEventStream(response.body, hooks.onSerial);
      hooks.onDisconnect?.();
    } catch (error) {
      if (signal.aborted) return;
      hooks.onError(error);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, SSE_MAX_BACKOFF_MS);
    }
  }
}

/**
 * Sleep for the given duration, resolving early if the signal aborts.
 *
 * @param {number} ms Duration in milliseconds.
 * @param {AbortSignal} signal Abort signal.
 * @returns {Promise<void>} Resolves after the delay or when aborted.
 */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
