// The forge's HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4
// and MCP, all served from one in-memory store. main.ts owns the lifecycle;
// this file owns the routes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import {
  handleInfoRefs,
  handleReceivePack,
  handleUploadPackV0Stream,
  handleUploadPackV2,
} from './src/gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The token the suite presents; unset in local dev means "any bearer". */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(auth.trim());
  return m ? m[1] : undefined;
}

function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return token === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204 || body === null) {
    res.writeHead(status, { 'content-length': 0, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams; rawPath: string } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams, rawPath: url.pathname + url.search };
  } catch {
    return { pathname: '/', query: new URLSearchParams(), rawPath: '/' };
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(): Server {
  const forge = new Forge();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(forge, req, res);
      } catch (err) {
        process.stderr.write(`[forge] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else {
          try {
            res.end();
          } catch {
            // The response is already gone.
          }
        }
      }
    })();
  });
  return server;
}

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname, query, rawPath } = pathOf(req);
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}`;

  // The env's boot probe: no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else requires the suite's bearer token.
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': forge.nextRequestId() });
    return;
  }

  // Model Context Protocol over Streamable HTTP.
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    const out = handleMcp(forge, parsed.value, sessionId);
    if (out.status === 202 || out.json === null) {
      res.writeHead(202, { 'content-length': 0, ...(out.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, out.status, out.json, out.headers ?? {});
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, { 'x-github-request-id': forge.nextRequestId() });
      return;
    }
    const result = handleGraphQL(forge, parsed.value);
    sendJson(res, 200, result, { 'x-github-request-id': forge.nextRequestId() });
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': forge.nextRequestId() });
        return;
      }
      body = parsed.value;
    }
    const out = handleRest({
      forge,
      method,
      segments,
      query,
      body,
      base,
      rawPath,
    });
    if (out === null) {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': forge.nextRequestId() });
      return;
    }
    const headers: Record<string, string> = {
      'x-github-request-id': forge.nextRequestId(),
      'x-oauth-scopes': 'repo, read:org',
      ...(out.headers ?? {}),
    };
    if (out.status === 204) {
      sendJson(res, 204, null, headers);
      return;
    }
    sendJson(res, out.status, out.json, headers);
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
  if (gitMatch) {
    const [, owner, repoName, action] = gitMatch;
    const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) : undefined;
    if (action === 'info/refs') {
      if (method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const service = query.get('service') ?? undefined;
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : undefined;
      const out = handleInfoRefs(repo, service, gitProtocol);
      sendBuffer(res, out.status, out.contentType, out.body);
      return;
    }
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : undefined;
      if (gitProtocol === 'version=2') {
        const raw = await readBody(req);
        const body = handleUploadPackV2(repo, raw);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
      } else {
        // v0 negotiates in rounds: stream the request, answer as it arrives.
        handleUploadPackV0Stream(repo, req, res);
      }
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      const body = handleReceivePack(repo, raw);
      sendBuffer(res, 200, 'application/x-git-receive-pack-result', body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': forge.nextRequestId() });
}
