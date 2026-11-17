// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, plain JSON answers (no SSE).
// Speaks the modern 2026-07-28 era: `server/discover` first, with the legacy
// `initialize` + `notifications/initialized` handshake as a fallback. Six tools
// act on the same Forge store as REST and GraphQL, so a repository or an issue
// created over MCP is the same object over REST.
//
// Wire rules the suite relies on:
// - two `tools/list` calls are byte-identical (the tool list is one fixed array);
// - a non-JSON body is HTTP 400 with JSON-RPC -32700; an unknown tool is
//   -32602 or -32601, never HTTP 500; missing required arguments are isError:true
//   or -32602; no Authorization is 401; request ids round-trip verbatim.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN } from './store.ts';
import { mergePull, repoJson, issueJson, pullJson } from './rest.ts';
import { readBody, sendJson } from './util.ts';

const SERVER_NAME = 'gaia-git-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** One fixed tool list, built once so two tools/list answers are byte-identical. */
function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: { type: 'string', description: 'The name of the repository.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The owner of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The owner of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    title: { type: 'string', description: 'The title of the issue.' },
    body: { type: 'string', description: 'The body of the issue.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: { type: 'string', description: 'The owner of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    state: { type: 'string', description: 'open, closed or all; defaults to open.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'The owner of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    title: { type: 'string', description: 'The title of the pull request.' },
    body: { type: 'string', description: 'The body of the pull request.' },
    head: { type: 'string', description: 'The head branch.' },
    base: { type: 'string', description: 'The base branch.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request.', {
    owner: { type: 'string', description: 'The owner of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
]);

// ---------------------------------------------------------------------------
// tool results
// ---------------------------------------------------------------------------

function toolOk(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function requireRepo(forge: Forge, args: Record<string, unknown>): ReturnType<Forge['getRepo']> {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  if (!owner || !repoName) throw new Error('owner and repo are required');
  if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) throw new Error('Not Found');
  const repo = forge.getRepo(repoName);
  if (!repo) throw new Error('Not Found');
  return repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (!repoName) throw new Error('name is required');
      if (forge.getRepo(repoName)) throw new Error('name already exists on this account');
      const description = asString(args.description) ?? '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = forge.createRepo(repoName, description, isPrivate);
      if (!repo) throw new Error('name already exists on this account');
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      if (!repo) throw new Error('Not Found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      if (!repo) throw new Error('Not Found');
      const title = asString(args.title);
      if (!title) throw new Error('title is required');
      const body = asString(args.body) ?? '';
      const issue = forge.createIssue(repo, title, body, []);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      if (!repo) throw new Error('Not Found');
      const state = asString(args.state) ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues = [...issues].sort((a, b) => b.createdSeq - a.createdSeq);
      return toolOk(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      if (!repo) throw new Error('Not Found');
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base) ?? repo.defaultBranch;
      if (!title) throw new Error('title is required');
      if (!head) throw new Error('head is required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) throw new Error(`Head branch ${head} does not exist`);
      if (!baseSha) throw new Error(`Base branch ${base} does not exist`);
      const existing = [...repo.pulls.values()].find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
      const pull =
        existing ??
        forge.createPull(repo, title, asString(args.body) ?? '', head, base);
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      if (!repo) throw new Error('Not Found');
      const number = asNumber(args.pull_number);
      if (number === null) throw new Error('pull_number is required');
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error('Not Found');
      if (pull.state === 'closed') throw new Error('Pull Request is not mergeable');
      const message = `Squash and merge ${pull.title} (#${pull.number})`;
      const result = mergePull(forge, repo, pull, 'squash', message);
      return toolOk({ ...result, number: pull.number });
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const KNOWN_REVISIONS = new Set([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

export async function handleMcp(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const header = req.headers.authorization ?? '';
  const ok = token === '' ? header.startsWith('Bearer ') && header.length > 7 : header === `Bearer ${token}`;
  if (!ok) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    const id = isRecord(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number') ? parsed.id : null;
    sendJson(res, 400, rpcError(id, -32600, 'Invalid Request'));
    return true;
  }
  const request = parsed as JsonRpcRequest;
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const isNotification = request.id === undefined || request.id === null;
  const params = isRecord(request.params) ? request.params : {};

  // A notification gets no JSON-RPC answer (202, empty body).
  if (isNotification) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return true;
  }

  switch (request.method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      }));
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = KNOWN_REVISIONS.has(requested) ? requested : PROTOCOL_VERSION;
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      }));
      return true;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return true;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
        return true;
      }
      try {
        const result = callTool(forge, toolName, args);
        sendJson(res, 200, rpcResult(id, result));
      } catch (error) {
        if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'number') {
          sendJson(res, 200, rpcError(id, (error as { code: number }).code, error.message));
        } else {
          sendJson(res, 200, rpcResult(id, toolError(error instanceof Error ? error.message : String(error))));
        }
      }
      return true;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${request.method}`));
      return true;
    }
  }
}
