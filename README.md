# github-core-clone

A GitHub-compatible git forge, implemented from scratch in Node 22 with
stdlib only: no git binary, no dependencies, no network beyond the harness.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (with
  the v0 fallback), receive-pack v0 with `report-status`, `side-band-64k` and
  `delete-refs`. Fast-forward-only updates; a non-fast-forward ref is refused
  per-ref with `ng <ref> non-fast-forward` while the other refs apply.
  The object store is written here: loose objects (zlib), packfile reading
  and writing, pkt-line framing, refs, commits, trees, blobs, OFS_DELTA and
  REF_DELTA resolution, shallow and deepen fetch, and thin-pack handling.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents
  (create/update/delete with sha optimistic locking), issues, labels,
  comments, pull requests with squash merge and conflict detection
  (405 on a conflicted merge). Every reply is `application/json` with a
  non-empty `X-GitHub-Request-Id`; bearer auth from `MAKEFUN_SHOP_TOKEN`;
  foreign-owner repos answer 404, never 403.
- **GraphQL** at `/api/graphql`: `viewer`, `repository`, `node`, `__type`
  introspection, issue and pull-request connections with cursor pagination
  and `orderBy: { field: CREATED_AT, direction: DESC }`, and the mutations
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`. Batched operation arrays answer in order; unknown fields
  return HTTP 200 with an `errors` array naming the field.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, revision `2026-07-28`
  (`server/discover`, plus the legacy `initialize` handshake) and six tools —
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — sharing the same store as
  REST, so ids round-trip across the two surfaces.

## Determinism

All state lives in memory and every timestamp derives from a counter, not
the wall clock. There is no `Math.random`, no random UUID, and no clock in
anything that reaches state, so a state export is byte-identical across
runs. The viewer login and the scenario identity come from the same seeded
scenario derivation the harness uses, so the viewer the suite expects is the
viewer this forge serves.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, then long-polls
`$MAKEFUN_ENV_URL/done` until the harness reports `{"done": true}` and
exits 0. It never binds 8080 and never touches a port the harness did not
assign.

## Layout

- `main.ts` — env lifecycle (entrypoint).
- `app.ts` — the whole forge: object store, packfiles, git protocol,
  REST, GraphQL, MCP.
