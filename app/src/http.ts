export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly restarting: boolean;
  constructor(status: number, message: string, code?: string, restarting = false) {
    super(message); this.status = status; this.code = code; this.restarting = restarting;
  }
}

export class ConnectionError extends Error {}

export const isReconnecting = (error: unknown) =>
  error instanceof ConnectionError || error instanceof HttpError && error.restarting;

export async function readJson<T>(response: Response, fallback = `HTTP ${response.status}`): Promise<T> {
  const text = await response.text().catch(error => {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ConnectionError('Minarbot connection lost. Try again.');
  });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if ([502, 503, 504].includes(response.status)) {
      throw new HttpError(response.status, 'Minarbot is restarting. Try again in a moment.', undefined, true);
    }
    if (response.ok) throw new Error('Minarbot returned an invalid response. Try again.');
    throw new HttpError(response.status, fallback);
  }
  if (!response.ok) {
    const value = body as { error?: string | { message?: unknown; code?: unknown }; code?: unknown } | null;
    const error = value?.error;
    const message = typeof error === 'string' ? error : error?.message;
    const code = typeof error === 'object' ? error?.code : value?.code;
    throw new HttpError(
      response.status,
      typeof message === 'string' ? message : fallback,
      typeof code === 'string' ? code : undefined,
    );
  }
  return body as T;
}
