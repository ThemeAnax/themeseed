/** A stand-in for Ghost's Admin API that records what was sent to it. */
export interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, Array<Record<string, unknown>>>;
}

export interface SeedConfigForTest {
  platform: 'ghost';
  url: string;
  credentials: Record<string, string>;
}

export function recordingFetch(options: { failOn?: 'second' } = {}) {
  const calls: RecordedCall[] = [];
  let writes = 0;

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: RecordedCall['body'];
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as RecordedCall['body'];
      } catch {
        body = undefined;
      }
    }
    calls.push({ url, method, ...(body ? { body } : {}) });

    if (method !== 'GET') {
      writes += 1;
      if (options.failOn === 'second' && writes === 2) {
        return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 500 });
      }
    }

    // Echo the payload back with an id, which is what Ghost does.
    const key = Object.keys(body ?? {})[0];
    const sent = key ? (body![key]![0] ?? {}) : {};
    const echoed = { ...sent, id: `id-${calls.length}`, uuid: `uuid-${calls.length}` };
    return new Response(JSON.stringify({ [key ?? 'posts']: [echoed] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { fetchImpl, calls };
}
