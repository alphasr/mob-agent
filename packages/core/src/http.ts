import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

/** A web-standard handler: mountable in Next.js, Hono, Bun, Deno, Cloudflare, or `serve()` below. */
export type RequestHandler = (request: Request) => Promise<Response>;

export interface ServeOptions {
  port: number;
  /** Default: 127.0.0.1 (reach it through a tunnel or reverse proxy). */
  host?: string;
  /** Only this path is handled; everything else gets 404. */
  path: string;
  /** Called when the handler throws; the client gets a bare 500. */
  onError?: (error: unknown) => void;
}

export interface RunningServer {
  /** Full URL of the handled path, e.g. http://127.0.0.1:3000/webhook */
  url: string;
  close(): Promise<void>;
}

/** Serve a `RequestHandler` with node:http, for when there's no framework to mount it in. */
export async function serve(handler: RequestHandler, options: ServeOptions): Promise<RunningServer> {
  const server = createServer((req, res) => void dispatch(req, res, handler, options));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo; // listen() resolved, so this is a bound TCP address
  return {
    url: `http://${address.address}:${address.port}${options.path}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  handler: RequestHandler,
  options: ServeOptions,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== options.path) {
      res.writeHead(404).end();
      return;
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(url, {
      method: req.method ?? 'GET',
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((value): [string, string] => [k, value]),
      ),
      ...(hasBody && { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' }),
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    options.onError?.(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

/** The raw bytes (signatures are over bytes, not parsed JSON), or undefined if over `limit`. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get('content-length')) > limit) return undefined;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
