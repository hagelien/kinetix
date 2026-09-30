/**
 * Agent focus config — the scope an admin sets for the scheduled
 * drug-database maintainer (agents/drug-db-maintainer.md §3). It globally
 * narrows the popularity-ordered work queues; it is NOT a per-(drug,parameter)
 * boost — that is parameter_priority_flags.
 *
 *   GET /api/agent-focus  — read the config (admin, or the agent routine via
 *                           its kxat token).
 *                           Page ids are enriched with title/slug/type for the
 *                           admin UI.
 *   PUT /api/agent-focus  — replace the config (admin only).
 *
 * The table holds a single seeded row (id = 1); writes upsert that row.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from "./_lib/response.js";
import { getDb } from "./_lib/db.js";
import { getUserFromRequest } from "./_lib/auth.js";
import { requireAdmin } from "./_lib/require-admin.js";
import { CAP } from "../src/lib/permissions.js";
import { callerCan } from "./_lib/permissions-store.js";
import { assertSameOrigin, parseAndValidate } from "./_lib/validate.js";
import { updateAgentFocusConfigSchema } from "./_lib/schemas.js";
import { isAgentWorkTarget } from "./_lib/agent-work-targets.js";
import { resolveActiveAgent } from "./_lib/agent-verifications.js";
import {
  agentFocusConfig,
  drugs,
  wikiPages,
  analyticalMethods,
  analyticalMethodComponents,
} from "../db/schema.js";

const CONFIG_ID = 1;
const PRIVATE_AGENT_FOCUS_HEADERS = noStoreHeaders();

interface FocusPage {
  id: number;
  title: string;
  slug: string;
  pageType: string;
}

interface FocusMethod {
  id: number;
  code: string;
  name: string;
  /**
   * Resolved drug-component ids for this method. Surfaced so the agent can
   * scope its work to these components without needing `rettstoks` group
   * access to /api/methods.
   */
  drugIds: number[];
}

interface FocusConfigResponse {
  mode: "all" | "pages" | "parameters" | "methods";
  pageIds: number[];
  parameters: string[];
  methodIds: number[];
  /**
   * EFFECTIVE: is agent wiki authoring closed right now? True when the switch
   * below is set, and also under `mode = "parameters"`, which closes the
   * action on its own. No monograph facts, no wiki sections; parameter work,
   * paper reviews, PDF handling and the discussion/approval sweeps are
   * untouched.
   *
   * This is the agent's field: echoed by GET so a routine can skip the
   * wiki-content action and log its `no_change` row without first being
   * refused at the door.
   */
  skipWikiContent: boolean;
  /**
   * STORED: the switch itself, exactly as an admin left it, with no mode
   * override folded in. This is the admin form's field, and it exists
   * separately because the two genuinely differ under `mode = "parameters"`.
   *
   * Serving only the effective value cost the form the admin's actual choice:
   * it loaded `true` under a parameter focus, could not tell a ticked box from
   * an implied one, and the next save under any other mode wrote back the
   * `false` it had guessed — silently erasing a guard nobody had untouched.
   * A guard that a mode switch can drop is not a guard.
   */
  skipWikiContentSetting: boolean;
  updatedAt: string | null;
  /** Hydrated metadata for `pageIds`, in the stored order. */
  pages: FocusPage[];
  /** Hydrated metadata for `methodIds`, in the stored order. */
  methods: FocusMethod[];
}

function toIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => Number.isInteger(v));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Hydrate stored analytical-method ids with display metadata and their
 * resolved component drug ids, preserving the admin-chosen order. The drug
 * ids let the scheduled maintainer scope to a method's components without
 * `rettstoks` access to /api/methods.
 */
async function hydrateMethods(methodIds: number[]): Promise<FocusMethod[]> {
  if (methodIds.length === 0) return [];
  const db = getDb();
  const [rows, componentRows] = await Promise.all([
    db
      .select({
        id: analyticalMethods.id,
        code: analyticalMethods.code,
        name: analyticalMethods.name,
      })
      .from(analyticalMethods)
      .where(inArray(analyticalMethods.id, methodIds)),
    db
      .select({
        methodId: analyticalMethodComponents.methodId,
        drugId: analyticalMethodComponents.drugId,
      })
      .from(analyticalMethodComponents)
      .where(inArray(analyticalMethodComponents.methodId, methodIds))
      .orderBy(
        analyticalMethodComponents.sortOrder,
        analyticalMethodComponents.drugId,
      ),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const drugIdsByMethod = new Map<number, number[]>();
  for (const row of componentRows) {
    const list = drugIdsByMethod.get(row.methodId);
    if (list) list.push(row.drugId);
    else drugIdsByMethod.set(row.methodId, [row.drugId]);
  }

  // Preserve the admin-chosen order; drop ids whose method no longer exists.
  return methodIds
    .map((id) => {
      const method = byId.get(id);
      if (!method) return undefined;
      return { ...method, drugIds: drugIdsByMethod.get(id) ?? [] };
    })
    .filter((r): r is FocusMethod => r !== undefined);
}

/** Hydrate stored wiki-page ids with display metadata, preserving order. */
async function hydratePages(pageIds: number[]): Promise<FocusPage[]> {
  if (pageIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      pageType: wikiPages.pageType,
    })
    .from(wikiPages)
    .where(inArray(wikiPages.id, pageIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the admin-chosen order; drop ids whose page no longer exists.
  return pageIds
    .map((id) => byId.get(id))
    .filter((r): r is FocusPage => r !== undefined);
}

async function readConfig(): Promise<FocusConfigResponse> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(agentFocusConfig)
    .where(eq(agentFocusConfig.id, CONFIG_ID))
    .limit(1);

  // The migration seeds row 1, but tolerate its absence (fresh test DB) by
  // falling back to the inert default instead of throwing.
  const mode = (row?.mode ?? "all") as FocusConfigResponse["mode"];
  const pageIds = toIntArray(row?.pageIds);
  const parameters = effectiveFocusParameters(
    mode,
    toStringArray(row?.parameters),
    row?.methodsParametersOptIn ?? false,
  );
  const methodIds = toIntArray(row?.methodIds);
  const storedSkipWikiContent = row?.skipWikiContent ?? false;
  const [pages, methods] = await Promise.all([
    hydratePages(pageIds),
    hydrateMethods(methodIds),
  ]);
  return {
    mode,
    pageIds,
    parameters,
    methodIds,
    // `mode = "parameters"` closes the wiki action on its own, so the EFFECTIVE
    // answer is on under it: an agent told "wiki content is open" by a config
    // that refuses every wiki write would survey a page it cannot file
    // against. Resolved once, here, rather than at each of the readers — and
    // served beside the stored value rather than instead of it, so no caller
    // has to reconstruct the admin's own choice from a derived answer.
    skipWikiContent: mode === 'parameters' || storedSkipWikiContent,
    skipWikiContentSetting: storedSkipWikiContent,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    pages,
    methods,
  };
}

/**
 * The focus config reduced to what a ranked query needs: which parameters and
 * which drugs are in scope.
 *
 * `null` on an axis means **no restriction**. An empty array means **nothing
 * is in scope on that axis** — a real, deliberate answer, not a missing one.
 * The distinction matters: an admin who selected `mode = "parameters"` and
 * then chose nothing, or whose page focus resolves to no drug monographs, has
 * scoped the parameter action to the empty set. §3 of
 * `agents/drug-db-maintainer.md` is explicit that the routine then logs a
 * `no_change` row "rather than reaching outside the focus set", so collapsing
 * empty to unrestricted would have the agent quietly work the whole catalogue
 * against an admin's explicit instruction.
 *
 * The one exception is `mode = "methods"`, where the parameter list is an
 * OPTIONAL second filter on top of the panels rather than the instruction
 * itself, so an empty one resolves to `null` — see `resolveFocusNarrowing`.
 */
export interface FocusNarrowing {
  parameters: string[] | null;
  drugIds: number[] | null;
}

/**
 * Keep only the arrays the chosen mode actually reads.
 *
 * `db/schema.ts` has always described each array as "…for mode=X; empty
 * otherwise", but nothing enforced the second half: `PUT` stored whatever the
 * request carried, and the admin form submitted its whole state on every save
 * regardless of which radio was selected. A selection made under one mode
 * therefore survived, invisibly, under another.
 *
 * That was harmless only while every mode read exactly one array. `methods`
 * now reads two (see `resolveFocusNarrowing`), so a leftover `parameters`
 * array from an earlier `parameters`-mode save would become a live filter
 * nobody chose — a method-focused agent silently narrowed to a set an admin
 * last meant for a different scope, with a quieter queue as the only symptom.
 * Migration 0121 clears the row that already carries one; this keeps the next
 * one from being written.
 *
 * Pure and exported so the invariant is testable without a request, and stated
 * once rather than inline in the upsert's two column lists.
 */
export function scopeArraysToMode(
  mode: FocusConfigResponse['mode'],
  arrays: { pageIds: number[]; parameters: string[]; methodIds: number[] },
): {
  pageIds: number[];
  parameters: string[];
  methodIds: number[];
  methodsParametersOptIn: boolean;
} {
  // Two modes read the parameter list: it is the whole instruction under
  // `parameters`, and an optional further filter under `methods`.
  const parameters =
    mode === 'parameters' || mode === 'methods' ? arrays.parameters : [];
  return {
    pageIds: mode === 'pages' ? arrays.pageIds : [],
    parameters,
    methodIds: mode === 'methods' ? arrays.methodIds : [],
    // Derived from what this call is about to store, never passed in, so the
    // flag and the array it vouches for cannot drift apart. Setting it is the
    // whole signal: the pre-composition handler does not know the column
    // exists, so a write that slips through the deploy window (see migration
    // 0122) leaves it false and `effectiveFocusParameters` ignores the array.
    methodsParametersOptIn: mode === 'methods' && parameters.length > 0,
  };
}

/**
 * The parameter list that actually applies, given the opt-in.
 *
 * Under `methods` a stored array is trusted only when a composition-aware
 * writer vouched for it. Every consumer goes through here — the admin read and
 * the agent's narrowing alike — so a dormant array is not merely inert in the
 * resolver but invisible in the config too: the form loads no ticks for it, and
 * the next save rewrites the row empty. Nothing else can tell the two apart,
 * because a row written by the old handler is byte-identical to one an admin
 * chose on purpose apart from this flag.
 */
export function effectiveFocusParameters(
  mode: FocusConfigResponse['mode'],
  parameters: string[],
  methodsParametersOptIn: boolean,
): string[] {
  if (mode !== 'methods') return parameters;
  return methodsParametersOptIn ? parameters : [];
}

/** Reserved for `mode = "all"` and a genuinely absent config row. */
const NO_NARROWING: FocusNarrowing = { parameters: null, drugIds: null };

/**
 * Resolve the admin focus config into filters a query can apply.
 *
 * This exists so the parameter-gap queue can narrow **before** its LIMIT.
 * Applying focus after a ranked, limited fetch silently reports "no work" when
 * the in-scope candidates rank below the cut — a focus on `clearance` would
 * see nothing whenever higher-priority parameters fill the page, even with
 * real clearance gaps waiting. Narrowing server-side also keeps one reading of
 * the config rather than each caller reimplementing §3's rules.
 *
 * An empty selection stays empty. Widening it to the whole catalogue would be
 * the routine ignoring an admin instruction, which is worse than a quiet
 * cycle: the empty result is visible in the `no_change` log and in the `focus`
 * the endpoint echoes back, whereas working out of scope is not.
 */
/**
 * Why an agent's wiki-content write is out of scope, or `null` when it is in
 * scope. The string is the 403 body the submitter reads, so it names the mode
 * that refused and what to do instead.
 *
 * The focus config is the admin's answer to "what should the scheduled agents
 * work on", and until this existed it only ever narrowed the **parameter**
 * queues. `mode = "parameters"` in particular left the wiki-content action
 * completely unscoped — `agents/drug-db-maintainer.md` §3 used to say in so
 * many words that the monograph action "is not parameter-scoped, so it
 * proceeds by popularity as usual" — so an admin who narrowed the agents to a
 * handful of parameters still got a monograph fact on an unrelated drug every
 * cycle. Selecting parameters is a statement about what content the agents may
 * add or edit, not merely about which of several queues gets filtered.
 *
 * Each mode answers it the same way it answers the parameter axis:
 *
 * - `all` — unrestricted.
 * - `parameters` — the admin scoped agent authoring to a set of drug
 *   parameters. Monographs and topic articles are not parameters, so there is
 *   no in-scope wiki content at all and every such write is refused. Parameter
 *   work, paper reviews, PDF handling and the discussion/approval sweeps are
 *   untouched: this gate only governs `wiki_fact` / `wiki_section`.
 * - `pages` — only the pages the admin listed.
 * - `methods` — only monographs of drugs that are components of the selected
 *   analytical methods.
 *
 * An empty selection stays empty here for the same reason it does in
 * `resolveFocusNarrowing`: an admin who selected `pages` and listed nothing has
 * scoped the wiki action to the empty set, and widening that to the whole wiki
 * would be the routine overriding an instruction.
 */
/** True when this page is a drug monograph rather than a topic article. */
async function isDrugMonograph(pageId: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ pageType: wikiPages.pageType })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId))
    .limit(1);
  return row?.pageType === 'drug_monograph';
}

/**
 * The refusal that does not depend on WHICH page is being written — the
 * switch, and the mode that implies it. Shared by both entry points below so
 * a new one cannot accidentally honour only the modes.
 *
 * The switch answers first, because it answers for every mode: an admin who
 * ticked it has closed agent authoring of wiki content whatever drug scope is
 * also in force. Under `mode = "parameters"` the mode refuses anyway
 * (`readConfig` reports the switch as on there), so the switch's message is
 * the one an admin sees only when they chose it on top of a page or method
 * scope — it must not name a mode as the reason.
 */
function outrightRefusal(config: FocusConfigResponse): string | null {
  if (config.mode === 'parameters') {
    return (
      'Agent focus is set to "parameters": scheduled agents may only add or ' +
      'edit the selected drug parameters, so monograph and wiki content is ' +
      'out of scope. Work the parameter queue instead.'
    );
  }
  if (config.skipWikiContent) {
    return (
      'Agent focus has monograph and wiki content switched off: scheduled ' +
      'agents may only work drug parameters right now. Work the parameter ' +
      'queue instead.'
    );
  }
  return null;
}

/**
 * What a wiki write will leave behind, judged as an identity rather than as a
 * row that happens to exist now.
 *
 * `pageType` and `drugId` are the values the page will HOLD after the write,
 * not the ones it holds before it. Judging the current row is not the same
 * question: a create names no row at all, and an update may change both fields
 * in the same request — so an in-scope monograph could be turned into a topic
 * page, or re-pointed at a drug the focus does not name, by a write the
 * before-picture approves.
 */
export interface WikiWriteTarget {
  /** The existing page's id, or `null` when the page does not exist yet. */
  pageId: number | null;
  /** The `wiki_pages.page_type` the write leaves behind. */
  pageType: string;
  /** The `drugs.id` the page belongs to afterwards, or `null` for none. */
  drugId: number | null;
}

/**
 * Why an agent's wiki write to this target is out of scope, or `null` when it
 * is in scope.
 *
 * `wiki_page` / `wiki_new` submissions and direct `/api/wiki/pages` writes are
 * admin-tier by default, which is why the gate began life covering only
 * `wiki_fact` / `wiki_section`. But `wiki.page.submit` and `edit.directWrite`
 * both carry `floorTier: 'editor'`, so an admin may delegate either down to
 * the editor tier — and an agent identity backed by an editor-role user then
 * reaches those paths. A guard whose promise ("agents author no wiki content")
 * holds only until someone adjusts the permission matrix is not a guard.
 *
 * Under `methods` the page must be a drug monograph of an in-union component:
 * both halves, because a topic page about an in-scope drug is still topic
 * content under a mode defined as "the components of these panels". That is
 * the same pairing `wikiContentFocusRefusal` applies to an existing row, and
 * it is what closes the create-and-update shapes of the same trick — a
 * `wiki_new` naming a component drug but `pageType: "topic"`, or a `PUT` that
 * converts a component's monograph into a topic article.
 */
export async function wikiTargetFocusRefusal(
  target: WikiWriteTarget,
): Promise<string | null> {
  const config = await readConfig();
  const outright = outrightRefusal(config);
  if (outright) return outright;
  switch (config.mode) {
    case 'pages': {
      if (target.pageId !== null && config.pageIds.includes(target.pageId)) {
        return null;
      }
      return target.pageId === null
        ? 'Agent focus is set to "pages": a page that does not exist yet ' +
            'cannot be one the admin listed, so creating one is out of scope.'
        : `Agent focus is set to "pages": wiki page ${target.pageId} is not ` +
            'in the admin-selected focus set.';
    }
    case 'methods': {
      const inScope = new Set(config.methods.flatMap((m) => m.drugIds));
      if (
        target.pageType === 'drug_monograph' &&
        target.drugId !== null &&
        inScope.has(target.drugId)
      ) {
        return null;
      }
      return (
        'Agent focus is set to "methods": the page must be the monograph of ' +
        'a component of the selected analytical methods.'
      );
    }
    default:
      return null;
  }
}

export async function wikiContentFocusRefusal(
  pageId: number,
): Promise<string | null> {
  const config = await readConfig();
  const outright = outrightRefusal(config);
  if (outright) return outright;
  switch (config.mode) {
    case 'pages': {
      if (config.pageIds.includes(pageId)) return null;
      return (
        `Agent focus is set to "pages": wiki page ${pageId} is not in the ` +
        'admin-selected focus set.'
      );
    }
    case 'methods': {
      const inScope = new Set(config.methods.flatMap((m) => m.drugIds));
      if (inScope.size > 0 && (await isDrugMonograph(pageId))) {
        // The page-type test is not redundant with the drug lookup. A page's
        // `drug_cid` outlives its `page_type`: `PUT /api/wiki/pages` sets the
        // two independently, so converting a monograph to a topic article
        // without also clearing `drugCid` leaves a topic page still pointing
        // at its old drug. Resolving the drug alone would then admit that
        // topic page whenever the drug is a selected method's component —
        // topic content under a mode defined as "components of these panels".
        const drugIds = await resolveDrugIdsForPages([pageId]);
        if (drugIds.some((id) => inScope.has(id))) return null;
      }
      return (
        `Agent focus is set to "methods": wiki page ${pageId} is not the ` +
        'monograph of a component of the selected analytical methods.'
      );
    }
    default:
      return null;
  }
}

export async function resolveFocusNarrowing(): Promise<FocusNarrowing> {
  const config = await readConfig();
  switch (config.mode) {
    case 'parameters':
      return {
        parameters: config.parameters.filter(isAgentWorkTarget),
        drugIds: null,
      };
    case 'methods': {
      // The two axes compose here, and only here. `mode = "methods"` is the
      // one scope whose natural unit is a WORK PROGRAMME — "these panels,
      // these parameters" — and without composition the two useful halves were
      // mutually exclusive: an admin could say "the 1020 components" or "the
      // model-structure axes" but never both, which is precisely the pairing
      // the model-declaration lane exists to serve.
      //
      // An empty list means UNRESTRICTED here, unlike `mode = "parameters"`
      // where the list is the whole instruction and empty means "nothing is in
      // scope". The difference is what the admin selected: in this mode the
      // methods carry the instruction and the parameters are an optional
      // further narrowing, so reading "I picked no extra filter" as "I scoped
      // the agents to nothing" would silence a focus that names real drugs.
      //
      // `readConfig` has already applied the opt-in (migration 0122), so a
      // `parameters` array no composition-aware writer vouched for arrives
      // here empty and reads as "no extra filter". Do not re-check the flag
      // here: a second copy of the rule is how the queue and its own
      // suppression count came to disagree one lane over.
      const parameters = config.parameters.filter(isAgentWorkTarget);
      return {
        parameters: parameters.length > 0 ? parameters : null,
        drugIds: Array.from(new Set(config.methods.flatMap((m) => m.drugIds))),
      };
    }
    case 'pages':
      return {
        parameters: null,
        drugIds: await resolveDrugIdsForPages(config.pageIds),
      };
    default:
      return NO_NARROWING;
  }
}

/**
 * Drugs whose monographs are among these wiki pages.
 *
 * `wiki_pages.drug_cid` is mixed-vintage — modern rows hold `drugs.id`, legacy
 * rows can hold a PubChem CID — so both have to be resolved. **Internal id
 * wins, PubChem CID is only a fallback for values no id matched**, the same
 * precedence `GET /api/drugs?wikiDrugId=` applies and for the same reason: the
 * two numbering spaces collide in live data (the repo's documented case is
 * 25C-NBOMe at id 281 against carbon monoxide at CID 281).
 *
 * Resolving both at once with an OR would put the collided drug in the focus
 * set too, and because the gap queue ranks by method membership and popularity
 * it could then hand the routine that drug's gap ahead of the intended one.
 * That is not a focus set one drug too wide — it is the agent working a
 * substance the admin did not select, which §3 explicitly forbids.
 */
async function resolveDrugIdsForPages(pageIds: number[]): Promise<number[]> {
  if (pageIds.length === 0) return [];
  const db = getDb();
  const pages = await db
    .select({ drugCid: wikiPages.drugCid })
    .from(wikiPages)
    .where(inArray(wikiPages.id, pageIds));
  const cids = Array.from(
    new Set(
      pages
        .map((p) => p.drugCid)
        .filter((v): v is number => typeof v === 'number'),
    ),
  );
  if (cids.length === 0) return [];

  const byId = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(inArray(drugs.id, cids));
  const resolved = new Set(byId.map((r) => r.id));

  // Only the values no drug row claimed as its own id are treated as legacy
  // PubChem CIDs. A value that matched an id is already answered.
  const unresolved = cids.filter((cid) => !resolved.has(cid));
  if (unresolved.length === 0) return Array.from(resolved);

  const byCid = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(inArray(drugs.pubchemCid, unresolved));
  for (const row of byCid) resolved.add(row.id);
  return Array.from(resolved);
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "GET") {
    const auth = await getUserFromRequest(req);
    if (!auth) {
      error(res, 401, "Authentication required");
      return;
    }
    if (!(await callerCan(auth.role, CAP["admin.agents.manage"]))) {
      const agent = await resolveActiveAgent(auth.userId);
      if (!agent) {
        error(res, 403, "Admin or agent token required");
        return;
      }
    }
    json(
      res,
      200,
      { config: await readConfig() },
      { headers: PRIVATE_AGENT_FOCUS_HEADERS },
    );
    return;
  }

  if (req.method === "PUT") {
    assertSameOrigin(req);
    const auth = await requireAdmin(req, res, CAP["admin.agents.manage"]);
    if (!auth) return;

    const parsed = await parseAndValidate(req, updateAgentFocusConfigSchema);
    if ("error" in parsed) {
      error(res, 400, parsed.error);
      return;
    }

    const parameters = parsed.data.parameters ?? [];
    const invalidParam = parameters.find((p) => !isAgentWorkTarget(p));
    if (invalidParam) {
      error(res, 400, `Invalid focus target id: ${invalidParam}`);
      return;
    }

    // Dedupe so the stored arrays stay clean; order is preserved.
    const pageIds = Array.from(new Set(parsed.data.pageIds ?? []));
    const dedupedParams = Array.from(new Set(parameters));
    const methodIds = Array.from(new Set(parsed.data.methodIds ?? []));

    const scoped = scopeArraysToMode(parsed.data.mode, {
      pageIds,
      parameters: dedupedParams,
      methodIds,
    });

    // Not part of `scopeArraysToMode`: this switch is orthogonal to the mode,
    // so it is stored as chosen rather than cleared by the mode's set-list.
    //
    // Absent means UNCHANGED, not `false` — a client that predates the switch
    // must not re-open the wiki action by saving an unrelated scope change —
    // and "unchanged" is expressed by LEAVING THE COLUMN OUT of the statement,
    // never by reading the old value and writing it back. That read-then-write
    // is a lost update wearing a guard's clothes: between the read and the
    // upsert another admin can tick the switch, and this request would then
    // restore the stale `false` over it, reopening agent wiki authoring
    // through a save that was about something else entirely. Omitting the
    // column instead lets Postgres keep the current value inside the same
    // statement, so there is no window to lose. On the insert branch the
    // column's own `DEFAULT false` answers, which is the right answer for a
    // config row that did not exist.
    const skipWikiContentColumn =
      parsed.data.skipWikiContent === undefined
        ? {}
        : { skipWikiContent: parsed.data.skipWikiContent };

    const db = getDb();
    const now = new Date();
    await db
      .insert(agentFocusConfig)
      .values({
        id: CONFIG_ID,
        mode: parsed.data.mode,
        pageIds: scoped.pageIds as never,
        parameters: scoped.parameters as never,
        methodIds: scoped.methodIds as never,
        methodsParametersOptIn: scoped.methodsParametersOptIn,
        ...skipWikiContentColumn,
        updatedBy: auth.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentFocusConfig.id,
        set: {
          mode: parsed.data.mode,
          pageIds: scoped.pageIds as never,
          parameters: scoped.parameters as never,
          methodIds: scoped.methodIds as never,
          methodsParametersOptIn: scoped.methodsParametersOptIn,
          ...skipWikiContentColumn,
          updatedBy: auth.userId,
          updatedAt: now,
        },
      });

    json(
      res,
      200,
      { config: await readConfig() },
      { headers: PRIVATE_AGENT_FOCUS_HEADERS },
    );
    return;
  }

  error(res, 405, "Method not allowed");
});
