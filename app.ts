// The server: one process, one store, four surfaces — git smart HTTP, REST v3,
// GraphQL v4 and MCP — plus the health probe. main.ts owns the lifecycle
// (ephemeral port, register, wait for done); this file owns routing only.
//
// Auth: every surface except /healthz needs `Authorization: Bearer <token>`
// matching MAKEFUN_SHOP_TOKEN (or any non-empty bearer when the token is unset,
// which only happens in local development). A repo under another owner is 404,
// never 403. A request that matches no route is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN, type GitObject } from './store.ts';
import {
  applyPush,
  computeFetch,
  fetchResponse,
  lsRefsResponse,
  parseReceivePack,
  parseV2Request,
  pushReportResponse,
  readPack,
  v0Advertisement,
  v2Advertisement,
} from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathSegments, queryOf, readBody, sendBuffer, sendJson } from './util.ts';

const UPLOAD_AD_TYPE = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_TYPE = 'application/x-git-upload-pack-result';
const RECEIVE_AD_TYPE = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_TYPE = 'application/x-git-receive-pack-result';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function gitAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (token === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${token}`;
}

/** Handle the git smart-HTTP routes; true when the path was a git route. */
async function handleGit(
  forge: Forge,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<boolean> {
  const segments = pathSegments(req);
  if (segments.length !== 3 || !segments[1]!.endsWith('.git')) return false;
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -'.git'.length);
  const action = segments[2]!;
  if (action !== 'git-upload-pack' && action !== 'git-receive-pack') return false;
  if (!gitAuth(req, token)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const repo = forge.getRepo(repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const method = req.method ?? 'GET';

  if (method === 'POST' && action === 'git-upload-pack') {
    const wantsVersion2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (!wantsVersion2) {
      sendJson(res, 400, { message: 'upload-pack requires protocol version 2' });
      return true;
    }
    let request: { command: string; args: string[] };
    try {
      request = parseV2Request(body);
    } catch (error) {
      sendJson(res, 400, { message: error instanceof Error ? error.message : 'bad v2 request' });
      return true;
    }
    if (request.command === 'ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      for (const arg of request.args) {
        if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
        else if (arg === 'peel') peel = true;
        else if (arg === 'symrefs') symrefs = true;
      }
      sendBuffer(res, 200, lsRefsResponse(repo, prefixes, peel, symrefs), UPLOAD_RESULT_TYPE);
      return true;
    }
    if (request.command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowBoundaries: string[] = [];
      let depth: number | null = null;
      for (const arg of request.args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5));
        else if (arg.startsWith('have ')) haves.push(arg.slice(5));
        else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8));
        else if (arg.startsWith('deepen ')) {
          const value = Number.parseInt(arg.slice(7), 10);
          if (Number.isFinite(value) && value > 0) depth = value;
        }
      }
      const cacheKey = JSON.stringify({ wants, haves, shallowBoundaries, depth, refVersion: repo.refVersion });
      const cached = repo.packCache.get(cacheKey);
      if (cached) {
        sendBuffer(res, 200, cached.pack, UPLOAD_RESULT_TYPE);
        return true;
      }
      const plan = computeFetch(forge, repo, wants, haves, shallowBoundaries, depth);
      const response = fetchResponse(plan);
      if (repo.packCache.size >= 64) {
        const oldest = repo.packCache.keys().next().value;
        if (oldest !== undefined) repo.packCache.delete(oldest);
      }
      repo.packCache.set(cacheKey, { pack: response, shallow: plan.shallow, unshallow: plan.unshallow });
      sendBuffer(res, 200, response, UPLOAD_RESULT_TYPE);
      return true;
    }
    sendJson(res, 400, { message: `unknown v2 command ${request.command}` });
    return true;
  }

  if (method === 'POST' && action === 'git-receive-pack') {
    let parsed: ReturnType<typeof parseReceivePack>;
    try {
      parsed = parseReceivePack(body);
    } catch (error) {
      sendJson(res, 400, { message: error instanceof Error ? error.message : 'bad receive-pack request' });
      return true;
    }
    let packObjects: Map<string, GitObject> | null = null;
    if (parsed.pack !== null) {
      try {
        packObjects = readPack(parsed.pack, (oid) => repo.objects.get(oid));
      } catch (error) {
        const result = { unpackOk: false, unpackDetail: 'error', lines: [] as never[] };
        sendBuffer(res, 200, pushReportResponse(result), RECEIVE_RESULT_TYPE);
        return true;
      }
    }
    const result = applyPush(forge, repo, parsed.commands, packObjects);
    sendBuffer(res, 200, pushReportResponse(result), RECEIVE_RESULT_TYPE);
    return true;
  }

  sendJson(res, 405, { message: 'Method Not Allowed' });
  return true;
}

/** Handle GET /<owner>/<repo>.git/info/refs; true when the path was one. */
function handleInfoRefs(
  forge: Forge,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/.exec(path);
  if (!match) return false;
  const owner = match[1]!;
  const repoName = match[2]!;
  if (!gitAuth(req, token)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const repo = forge.getRepo(repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const query = queryOf(req);
  const service = query.get('service');
  if (service === 'git-upload-pack') {
    const wantsVersion2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (wantsVersion2) sendBuffer(res, 200, v2Advertisement(), UPLOAD_AD_TYPE);
    else sendBuffer(res, 200, v0Advertisement(repo, 'git-upload-pack'), UPLOAD_AD_TYPE);
    return true;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_AD_TYPE);
    return true;
  }
  sendJson(res, 400, { message: 'service is required' });
  return true;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: info/refs is a GET; upload-pack and receive-pack are POSTs.
        if (method === 'GET' && handleInfoRefs(forge, token, req, res)) return;
        if (method === 'POST' && (path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack'))) {
          const body = await readBody(req);
          if (await handleGit(forge, token, req, res, body)) return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          await handleGraphQL(forge, token, req, res);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          await handleMcp(forge, token, req, res);
          return;
        }

        // REST v3 (the root included, with its scopes header).
        if (path.startsWith('/api/v3')) {
          await handleRest({ forge, token }, req, res);
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        console.error('request error', error);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
