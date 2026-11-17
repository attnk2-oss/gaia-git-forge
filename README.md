# gaia-git-forge

A GitHub-compatible git forge in one Node process, built for the make.fun
bounty `github-core-clone-01`. No git binary, no outside service, no UI: the
suite in the pod is its only client.

## What it serves

- **Git smart HTTP** (`/<owner>/<repo>.git/...`): upload-pack protocol v2
  (ls-refs, fetch with shallow/deepen, plain packfiles) and receive-pack v0
  (fast-forward checks, `non-fast-forward` refusals, sideband report-status).
- **REST v3** (`/api/v3`): repositories, refs, branches, commits, contents,
  labels, issues, pull requests (incl. squash merge with three-way conflict
  detection), comments. Issues and PRs share one numbering counter per repo.
- **GraphQL v4** (`/api/graphql`): a hand-written parser + executor for the
  documents gh sends — viewer/repository reads, `__type` introspection,
  Relay `node(id:)` global ids, issue/PR connections with cursor pagination,
  the five mutations (createIssue, closeIssue, createPullRequest,
  mergePullRequest, addComment), and operation batching.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, modern `server/discover`
  era (2026-07-28) with the legacy `initialize` handshake as fallback, and six
  tools: create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entry ↔ env lifecycle (bind ephemeral port, register, poll `/done`). Kept as the starter shipped it. |
| `app.ts` | HTTP server and routing: health probe, git, REST, GraphQL, MCP. |
| `store.ts` | The in-memory forge: repos, objects, refs, issues, PRs; git object model (commit/tree/blob/tag), three-way merge, deterministic counters for ids and timestamps. |
| `gitproto.ts` | pkt-line codec, packfile read (OFS/REF deltas) and write (plain), v2/v0 advertisements, fetch planning incl. shallow boundaries, receive-pack. |
| `rest.ts` | REST v3 routes and JSON shapes. |
| `graphql.ts` | GraphQL tokenizer, parser, schema table, executor and resolvers. |
| `mcp.ts` | MCP JSON-RPC methods and the six tools. |
| `util.ts` | Shared HTTP helpers (JSON answers, body reading, pagination links). |

## Determinism

Everything the server sends is a function of the requests it has seen: ids
and timestamps come from a counter seeded at a fixed epoch, never from the
wall clock or unseeded randomness. A replay of the same trial leaves a
byte-identical state export.

## Running it

Requires Node ≥ 22.18 (type stripping, no build step, no dependencies):

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:1 MAKEFUN_SHOP_TOKEN=test-token-123 \
  node --experimental-strip-types main.ts
```

In the trial the runner executes `node /bot/main.ts` with the real env URL and
token; the process binds an ephemeral port, registers it, serves until the env
says done, then exits 0.

## Testing locally

From the kit directory, with the server running on `$PORT`:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:$PORT \
  --token test-token-123 --json
```

Add `--perf` for the four benchmark workloads. A full trial check:

```sh
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/gaia-git-forge --driver process
```

## Results (local, 2026-11-17)

- Conformance: **120/120 checks** (git 30, repos 15, issues 15, pulls 20,
  protocol 5, GraphQL 20, MCP 15), MCP 15/15.
- Perf: **131/200** on the four workloads (push 40, clone 37, read 32,
  write 28) — faster than the house reference on all four.
- Full trial check (`grade-local --driver process`): **931/1000**, replay-stable
  (0 nondeterministic trials). Prize eligibility needs the session transcript
  bundled at submission; the code alone carries no transcript.

## License

MIT.
