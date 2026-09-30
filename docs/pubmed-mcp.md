# PubMed MCP server

Kinetix ships its own Model Context Protocol (MCP) server exposing PubMed and
PMC through NCBI E-utilities as seven read-only tools, so any MCP client —
Codex, the ChatGPT desktop app, Claude, IDE extensions — can search the
biomedical literature with the provenance rules this project cares about (exact
query echoed back, PMIDs on every record, abstract-level evidence kept distinct
from full text).

It runs over **two transports that share one server definition**
(`api/_lib/mcp-pubmed-server.ts`), so the tools, the evidence instructions and
the advertised identity are identical either way:

| | **stdio** (local process) | **HTTP** (hosted) |
| --- | --- | --- |
| Start it with | `npm run mcp:stdio` | deploy, then `https://…/api/mcp` |
| Auth | none needed — the client owns the process | `MCP_BEARER_TOKEN` |
| Latency | direct to NCBI | extra hop, possible cold start |
| NCBI rate budget | the caller's own | **shared** by every client of the deployment |
| Use when | the client can launch a command | it cannot |

**Prefer stdio wherever the client supports it.** It is faster, it costs
nothing to run, and it spends your own NCBI budget instead of contending for the
deployment's. NCBI's ceiling is per-identity: a hosted server pools every agent
behind one key, so heavy concurrent use is throttled collectively and a block
would take out PubMed access for everyone at once.

Reach for the hosted endpoint when a client only offers a URL field — the
ChatGPT desktop "Server URL" dialog is the case this was originally built for —
or when you want one audited deployment serving agents that have no local
checkout.

Either way the point is the same: these tools handle a long list of Entrez
behaviours that fail *silently* (see §5), which is why the project keeps one
implementation instead of leaving each agent to rediscover them.

---

## 1. Run it locally (stdio)

From a checkout:

```bash
npm run mcp:stdio          # or: npx tsx scripts/pubmed-mcp-stdio.ts
```

It speaks newline-delimited JSON-RPC on stdin/stdout and writes diagnostics to
stderr. Nothing listens on a port and no token is involved.

Set `NCBI_API_KEY` and `NCBI_TOOL_EMAIL` in your environment if you have them —
the server warns on stderr when they are missing. The key is free and raises the
ceiling from 3 to 10 requests/second.

### Codex CLI

```toml
# ~/.codex/config.toml
[mcp_servers.pubmed]
command = "npm"
args = ["--prefix", "/path/to/kinetix", "run", "--silent", "mcp:stdio"]
enabled = true

[mcp_servers.pubmed.env]
NCBI_API_KEY = "…"
NCBI_TOOL_EMAIL = "you@example.org"
```

`--silent` matters: npm's own banner would otherwise land on stdout, which
carries the JSON-RPC stream. Invoking `npx tsx scripts/pubmed-mcp-stdio.ts`
directly avoids the question entirely.

### Claude Code

```bash
claude mcp add pubmed -- npx tsx /path/to/kinetix/scripts/pubmed-mcp-stdio.ts
```

### Claude Desktop / ChatGPT desktop (local server)

```json
{
  "mcpServers": {
    "pubmed": {
      "command": "npx",
      "args": ["tsx", "/path/to/kinetix/scripts/pubmed-mcp-stdio.ts"],
      "env": { "NCBI_TOOL_EMAIL": "you@example.org" }
    }
  }
}
```

### Check it by hand

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | npm run --silent mcp:stdio 2>/dev/null | head -c 200
```

---

## 2. Configure the deployment (HTTP)

| Variable           | Required | Purpose                                                                     |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `MCP_BEARER_TOKEN` | yes      | Shared secret clients send as `Authorization: Bearer <token>`               |
| `NCBI_API_KEY`     | no       | Raises the NCBI rate ceiling from 3 to 10 requests/second                   |
| `NCBI_TOOL_EMAIL`  | no       | Contact address NCBI uses before blocking a misbehaving client              |

Generate a token and set it on the Vercel project (Settings → Environment
Variables), or in `.env` for local work:

```bash
openssl rand -base64 32
```

The endpoint **fails closed**. With `MCP_BEARER_TOKEN` unset it answers `503
mcp_not_configured` and reaches NCBI for nobody, so a half-configured deployment
is never an open relay running under this project's identity.

An NCBI API key is free (NCBI account → Settings → API Key Management) and worth
setting: without it the server throttles itself to ~2.8 requests/second, and a
single `find_related_articles` call with metadata is already two requests.

## 3. Verify the deployment is live

The health probe needs no token and reveals nothing:

```bash
curl -s https://kinetix.no/api/mcp?health=1
# {"status":"ok","transport":"streamable-http","configured":true,"tools":7}
```

`configured: false` means `MCP_BEARER_TOKEN` is missing on that deployment.

Then check the protocol handshake and the tool list:

```bash
TOKEN=... # the value of MCP_BEARER_TOKEN

curl -s https://kinetix.no/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

A live tool call:

```bash
curl -s https://kinetix.no/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"search_pubmed",
        "arguments":{"query":"postmortem redistribution femoral blood","max_results":3}}}' \
  | jq '.result.structuredContent | {query, total, returned}'
```

## 4. Connect a client to the hosted endpoint

### ChatGPT desktop app / Codex plugin dialog

In the **New Plugin** (or **Add server**) dialog:

1. **Name** — `PubMed`
2. **Connection** — leave it on **Server URL** and enter
   `https://kinetix.no/api/mcp`
3. **Authentication** — choose the access-token / bearer option, **not OAuth**,
   and paste the `MCP_BEARER_TOKEN` value. This server issues no OAuth metadata;
   selecting OAuth will fail discovery.
4. Acknowledge the custom-server warning and create.

If that dialog only offers *OAuth* or *None*, use the Codex CLI config below
instead — it takes a bearer token directly.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pubmed]
url = "https://kinetix.no/api/mcp"
bearer_token_env_var = "KINETIX_MCP_TOKEN"
enabled = true
```

Export `KINETIX_MCP_TOKEN` in your shell profile, then confirm with `codex mcp
list`, and `/mcp` inside a Codex session.

### Claude Code

```bash
claude mcp add --transport http pubmed https://kinetix.no/api/mcp \
  --header "Authorization: Bearer $KINETIX_MCP_TOKEN"
```

### Claude desktop / web

Settings → Connectors → Add custom connector, with the same URL and an
`Authorization: Bearer …` header.

### Local development

```bash
vercel dev
curl -s "http://localhost:3000/api/mcp?health=1"
```

`vercel dev` specifically — `npm run dev` is plain Vite (see AGENTS.md
Commands) and serves the frontend only, so nothing there executes
`api/mcp.ts`.

Point a client at `http://localhost:3000/api/mcp`. Clients that require a public
HTTPS URL (the ChatGPT desktop dialog among them) need a tunnel — `ngrok http
3000` or the dialog's own Tunnel mode — because the server is reached from the
client's host, not from your editor.

## 5. Tools

| Tool                    | Input                                        | Returns                                                                             |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `search_pubmed`         | query, date range, publication types, paging | Records + `total` hit count + the query as PubMed translated it (paging stops at offset 9998 — see below) |
| `fetch_pubmed_records`  | PMIDs                                        | Bibliographic metadata; unrecognised PMIDs listed in `notFound`                      |
| `fetch_abstracts`       | PMIDs                                        | Abstract + `abstractSource`, MeSH terms, copyright line; `abstract: null` when PubMed indexes none |
| `find_related_articles` | PMID                                         | PubMed's computed neighbours with relatedness scores, optionally with metadata       |
| `resolve_identifier`    | PMIDs / PMCIDs / DOIs, mixed                 | Crosswalk between all three, with the resolution route recorded in `status`          |
| `fetch_pmc_full_text`   | PMCID                                        | Plain-text rendering of PMC open-access XML, or `available: false`                   |
| `export_citations`      | PMIDs, format                                | Vancouver, APA, BibTeX or RIS strings                                                |

Every tool is annotated `readOnlyHint: true` — nothing here writes anywhere.

Two behaviours worth knowing:

- **`search_pubmed` returns `query` and `translatedQuery`.** `query` is the exact
  term string sent to Entrez (including any publication-type filter the tool
  appended); `translatedQuery` is NCBI's expansion of it into MeSH terms and
  synonyms. Quote `query` when reporting evidence — it is what makes a search
  reproducible.
- **A non-empty `warnings` means PubMed did not run your query.** ESearch does
  not fail on a term it cannot match — it drops the term, or drops a quoted
  phrase that found nothing, and returns a larger result set as though the query
  had been honoured. One live example: `aspirin[NoSuchField] OR "a phrase that
  does not exist anywhere"` returns 92,418 hits. `warnings` names every dropped
  term, unknown field and unconstraining phrase, and the server tells the model
  to read it before trusting the hit count.
- **`resolve_identifier` does not stop at PMC.** The NCBI ID converter only knows
  articles that reached PMC, so a DOI it rejects is retried against PubMed's
  `[AID]` index. "Not in PMC" and "not in PubMed" are different answers and the
  `status` field says which one you got — including the PMCID when there is one,
  which is what tells you `fetch_pmc_full_text` is worth trying.
- **`search_pubmed` cannot page past 9,999 matches.** That is an Entrez limit,
  not ours: ESearch rejects `retstart` above 9998 outright. `total` still
  reports the full hit count, so a query with 60,000 matches tells you honestly
  that you are seeing a slice — narrow it with date bounds or publication types
  rather than paging.
- **`fetch_pmc_full_text` requires an actual article body.** PMC answers for
  non-open-access articles with front matter only — journal title, ISSNs,
  publisher, identifiers — which flattens to a plausible-looking few thousand
  characters of nothing. A response with no `<body>` element is reported as
  `available: false` rather than rendered. The article text comes back in the
  content block only; `structuredContent` carries the metadata and a
  `characters` count, so a long article is not transmitted twice.
- **`fetch_abstracts` reports which abstract you got.** A record can carry both
  an indexed abstract (MEDLINE `AB`) and a publisher-supplied one (`OAB`). The
  indexed one wins, `abstractSource` says which is in hand, and any alternate
  version stays in `otherAbstracts` — running them together would read as one
  abstract stating its claims twice.

## 6. Evidence rules

The server sends these to the model as `instructions` on every `initialize`, so
they apply even to clients that never read this file. Repeat them in a project's
`AGENTS.md` when that project's agents rely on PubMed:

```markdown
## Biomedical literature

Use the PubMed MCP server for biomedical and toxicological literature searches.

When reporting evidence:
- Return title, authors, journal, year, PMID and DOI when available.
- Preserve the exact PubMed query used.
- Distinguish abstract-level evidence from reviewed full-text evidence.
- Do not imply that an abstract establishes findings not stated in it.
- Prefer primary studies for quantitative pharmacokinetic values.
- Do not combine incompatible populations, matrices, routes or study designs.
- Identify reviews separately from primary evidence.
- State when relevant records may be missing because of indexing or search limits.
```

In Kinetix specifically this server **finds and reads** sources; it does not
satisfy the read-in-full review gate (`assertReferencesJudged`). A
`fetch_pmc_full_text` result is a lossy rendering — tables, figures and formulae
are dropped — so a quantitative value reported only in a table will not appear in
it. Reading the published article remains a human/agent judgement recorded as a
`paper_review`.

## 7. Limits

- **Stateless.** No sessions, no server-initiated SSE stream, no subscriptions.
  `GET` returns `405`; every exchange is one `POST` with one JSON response. That
  is a conforming subset of the Streamable HTTP transport and the only shape that
  survives serverless invocation boundaries.
- **Rate limits.** 120 requests/minute per bearer token (per serverless
  instance), and self-throttling to stay under NCBI's ceiling. Both are
  best-effort and per-instance, like the rest of `api/_lib/rate-limit.ts`.
- **Batching.** JSON-RPC batches are accepted for older clients even though
  protocol 2025-06-18 removed them, capped at 20 messages. Each message in a
  batch is charged to the rate limiter, so a batch buys no extra throughput.
- **Protocol versions.** `2025-06-18`, `2025-03-26` and `2024-11-05` are
  negotiated on `initialize`; anything else falls back to the newest.

## 8. Where the code lives

| File                            | Role                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `api/_lib/mcp-pubmed-server.ts` | The server itself: tools + instructions + identity, shared by both transports |
| `api/_lib/mcp.ts`               | Transport-agnostic MCP core (`initialize`, `tools/*`)         |
| `api/mcp.ts`                    | HTTP shell: auth, CORS, rate limit, JSON-RPC framing          |
| `api/_lib/mcp-stdio.ts`         | stdio transport: newline-delimited framing, ordered writes    |
| `scripts/pubmed-mcp-stdio.ts`   | `npm run mcp:stdio` entry point                               |
| `api/_lib/mcp-pubmed-tools.ts`  | The seven tool definitions and citation formatters            |
| `api/_lib/pubmed-eutils.ts`     | NCBI client: throttle, retries, MEDLINE and JATS parsing      |
| `tests/api/mcp-route.test.ts`   | HTTP route: auth, protocol, tool dispatch                     |
| `tests/api/mcp-stdio.test.ts`   | stdio framing, ordering, batches, parity with HTTP            |
| `tests/api/pubmed-eutils.test.ts` | Parsers and citation formats                                |

`api/_lib/pubmed.ts` is separate and stays that way: it is the single-purpose
esummary lookup behind citation resolution (`api/references.ts`,
`api/references-resolve.ts`), not part of this server.
