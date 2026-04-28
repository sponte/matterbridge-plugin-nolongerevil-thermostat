import { getStatus, listDevices, sendCommand, subscribeEvents } from '../src/nle-client.js';

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function makeJsonResponse(body: unknown, init?: { status?: number; statusText?: string; ok?: boolean }): Response {
  const ok = init?.ok ?? (init?.status === undefined || init.status < 400);
  return {
    ok,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response;
}

function makeErrorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => ({ message }),
    text: async () => message,
    body: null,
  } as unknown as Response;
}

function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('listDevices', () => {
  it('returns the devices array on success', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ devices: [{ id: 'd1', serial: 'S1', name: 'Living Room' }] }));
    const devices = await listDevices('http://host:8082');
    expect(devices).toHaveLength(1);
    expect(devices[0]?.serial).toBe('S1');
  });

  it('returns an empty array when the body has no devices key', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}));
    expect(await listDevices('http://host:8082/')).toEqual([]);
  });

  it('throws on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(500, 'boom'));
    await expect(listDevices('http://host:8082')).rejects.toThrow(/HTTP 500/);
  });

  it('throws even when the error body cannot be read', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => {
        throw new Error('read failure');
      },
      json: async () => ({}),
    } as unknown as Response);
    await expect(listDevices('http://host:8082')).rejects.toThrow(/HTTP 404/);
  });
});

describe('getStatus', () => {
  it('encodes the serial and returns parsed body', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ serial: 'S 1', mode: 'heat' }));
    const status = await getStatus('http://host:8082', 'S 1');
    expect(status.mode).toBe('heat');
  });
});

describe('sendCommand', () => {
  it('POSTs the command body', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ success: true }));
    await sendCommand('http://host:8082', 'S1', { command: 'set_mode', value: 'heat' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ serial: 'S1', command: 'set_mode', value: 'heat' });
  });

  it('throws on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(400, 'bad'));
    await expect(sendCommand('http://host:8082', 'S1', { command: 'set_away', value: true })).rejects.toThrow(/POST \/command/);
  });
});

describe('subscribeEvents', () => {
  it('parses chunked SSE events and surfaces serials', async () => {
    fetchMock.mockResolvedValueOnce(makeStreamResponse(['data: {"serial":"A"}\n', '\ndata: {"serial":"B"}\n\n']));
    const controller = new AbortController();
    const seen: string[] = [];
    const lifecycle: string[] = [];
    await subscribeEvents('http://host:8082', controller.signal, {
      onSerial: (s) => seen.push(s),
      onConnect: () => lifecycle.push('connect'),
      onDisconnect: () => {
        lifecycle.push('disconnect');
        controller.abort();
      },
      onError: () => lifecycle.push('error'),
    });
    expect(seen).toEqual(['A', 'B']);
    expect(lifecycle).toEqual(['connect', 'disconnect']);
  });

  it('parses trailing event without final blank line', async () => {
    fetchMock.mockResolvedValueOnce(makeStreamResponse(['data: {"serial":"Z"}']));
    const controller = new AbortController();
    const seen: string[] = [];
    const promise = subscribeEvents('http://host:8082', controller.signal, {
      onSerial: (s) => seen.push(s),
      onError: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await promise;
    expect(seen).toEqual(['Z']);
  });

  it('ignores malformed data lines', async () => {
    fetchMock.mockResolvedValueOnce(makeStreamResponse(['data: not-json\n\n', 'data: {"foo":1}\n\n']));
    const controller = new AbortController();
    const seen: string[] = [];
    const promise = subscribeEvents('http://host:8082', controller.signal, {
      onSerial: (s) => seen.push(s),
      onError: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await promise;
    expect(seen).toEqual([]);
  });

  it('reports errors via onError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const controller = new AbortController();
    const errors: unknown[] = [];
    await subscribeEvents('http://host:8082', controller.signal, {
      onSerial: () => {},
      onError: (e) => {
        errors.push(e);
        controller.abort();
      },
    });
    expect(errors).toHaveLength(1);
  });

  it('returns immediately when aborted before connecting', async () => {
    const controller = new AbortController();
    controller.abort();
    await subscribeEvents('http://host:8082', controller.signal, { onSerial: () => {}, onError: () => {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws inside loop when response has no body, then reconnects', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', body: null, json: async () => ({}), text: async () => '' } as unknown as Response)
      .mockResolvedValueOnce(makeStreamResponse(['data: {"serial":"X"}\n\n']));
    const controller = new AbortController();
    const seen: string[] = [];
    await subscribeEvents('http://host:8082', controller.signal, {
      onSerial: (s) => seen.push(s),
      onError: () => {
        controller.abort();
      },
    });
    expect(seen).toEqual([]);
  });

  it('actually waits the backoff before reconnecting after an error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(makeStreamResponse(['data: {"serial":"R"}\n\n']));
    const controller = new AbortController();
    const seen: string[] = [];
    const errors: unknown[] = [];
    await subscribeEvents('http://host:8082', controller.signal, {
      onSerial: (s) => {
        seen.push(s);
        controller.abort();
      },
      onError: (e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    expect(seen).toEqual(['R']);
  }, 5000);
});
