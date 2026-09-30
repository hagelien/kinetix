import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import { CaseEditor } from '@/components/modeling/pattern/CaseEditor';
import { RatioProfile } from '@/components/modeling/pattern/RatioProfile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchModulesMetabolismGraph } from '@/lib/metabolismGraphApi';
import { EMPTY_LINEAGE_ENZYMES, type LineageEnzymes } from '@/lib/pattern/lineageEnzymes';
import { buildProfileFromCase } from '@/lib/pattern/buildProfile';
import {
  BENZODIAZEPINE_GRAPH,
  DIAZEPAM_FIXTURE_CASE,
  DIAZEPAM_FIXTURE_CASE_NUMBER,
} from '@/lib/pattern/fixtures';
import { PATTERN_MODULES } from '@/lib/pattern/modules';
import type { MetabolismGraph } from '@/lib/pattern/sourceAmbiguity';
import {
  listPatternCases,
  registryStaleness,
  type PatternCaseListEntry,
  type RegistryStaleness,
} from '@/lib/patternCases';
import { usePatternCaseStore } from '@/stores/patternCaseStore';

/**
 * The metabolite ratio profile at `/modeling/pattern[/:caseId]`.
 *
 * Phase 1: a case is entered, filed, and reopened. The profile is recomputed
 * from the case every time — never stored — which is what lets a corrected band
 * or a withdrawn threshold rule reach a case filed months ago, and is why the
 * registry versions travel with the case so a changed reading can be said out
 * loud instead of appearing silently.
 *
 * Still unlinked from the primary navigation (§10), until the reference atlas
 * lands.
 */
/** One page of the picker. The endpoint reports no total, so a full page is
 * the only signal that another may exist. */
const PAGE = 20;

export function PatternCasePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith('en') ? 'en-GB' : 'nb-NO';
  const navigate = useNavigate();
  const { caseId: caseIdParam } = useParams<{ caseId?: string }>();

  const {
    caseId,
    caseName,
    data,
    status,
    error,
    dirty,
    startNew,
    cancelLoad,
    setName,
    setData,
    load,
    save,
  } = usePatternCaseStore();

  // The profile's own controls write to the case, and this is a change from
  // Phase 0, where they were a scratch layer over a fixture nobody could save.
  // A hydrolysis protocol, a genotype or a corrected concentration is case
  // data: it decides which artefact warnings fire and which signals are
  // computable, so keeping it beside the case meant a curator could set it,
  // read the assessment it produced, file the case, and reopen it showing a
  // different assessment made from the defaults. The recompute-without-submit
  // behaviour is unchanged — a case is edited in place either way; what
  // changes is that the edit is now part of what gets written down.
  /**
   * Whether this case began as the demonstration fixture.
   *
   * Read off the case rather than remembered in the page, because the case
   * outlives the page in both directions: leaving for another part of the app
   * remounts this component with a fresh `false` while the store still holds
   * the fixture, and filing it hands back a saved case the page has never seen
   * before. Either way the demonstration's invented concentrations would come
   * back presenting as ordinary casework.
   */
  const fromExample = data.origin === 'example';
  // Kept by the offset each page came from, not appended to a list.
  // `requestedId` going back to null re-runs the fetch with whatever offset was
  // last asked for, and appending would then count that page twice — after
  // which "show more" starts past the rows in between and they become
  // unreachable. A page keyed by its offset replaces itself instead.
  const [pages, setPages] = useState<Record<number, PatternCaseListEntry[]>>({});
  const [listFailed, setListFailed] = useState(false);
  const [listOffset, setListOffset] = useState(0);
  // Bumped to ask again for the same page. Re-setting the offset to the value
  // it already holds does not re-run the effect — React bails out on an
  // unchanged state — so the retry button would do nothing at all.
  const [listAttempt, setListAttempt] = useState(0);
  const [graph, setGraph] = useState<MetabolismGraph | null>({ nodes: [], edges: [] });
  // The enzymes this case's lineage routes through, with what the catalog says
  // moves them. Beside the graph rather than inside it: they come from the same
  // request and the same module scope, but the source walk reads metabolism and
  // has nothing to say about an enzyme.
  const [enzymes, setEnzymes] = useState<LineageEnzymes>(EMPTY_LINEAGE_ENZYMES);
  const [graphAttempt, setGraphAttempt] = useState(0);
  // Distinct from `graph === null`, which is also true while the request is in
  // flight: a screen that said the graph was missing during every load would
  // teach the reader to ignore the one time it means it.
  const [graphFailed, setGraphFailed] = useState(false);
  // A field holding text the case could not take. The problem list is silent
  // about it — the case is valid, because those keystrokes never reached it —
  // so without this the screen shows one number while the case holds another,
  // and Save files the one the curator was replacing.
  const [editorDraftProblem, setEditorDraftProblem] = useState(false);
  // The profile edits concentrations too, and its fields are the same kind of
  // draft — so they answer to the same guard. Held apart from the editor's
  // because the two report independently and either one closing the save must
  // not clear the other's.
  const [profileDrafts, setProfileDrafts] = useState<ReadonlySet<string>>(() => new Set());
  const noteProfileDraft = useCallback((id: string, problem: boolean) => {
    setProfileDrafts((previous) => {
      if (problem === previous.has(id)) return previous;
      const next = new Set(previous);
      if (problem) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const draftProblem = editorDraftProblem || profileDrafts.size > 0;

  // An address can name something that is not a case id at all —
  // `/modeling/pattern/foo`, `/modeling/pattern/0`. Sorted out here rather than
  // inside the effect: read as a case that has not arrived, the screen waits
  // for a load nobody started, and the retry button asks the server about `0`.
  const asked = caseIdParam === undefined ? null : Number(caseIdParam);
  const requestedId = asked !== null && Number.isInteger(asked) && asked > 0 ? asked : null;
  const badAddress = caseIdParam !== undefined && requestedId === null;
  const pending = requestedId !== null && caseId !== requestedId;

  useEffect(() => {
    // Both branches below replace the case in hand, and the working copy is
    // the only copy: the store is not persisted, so unsaved specimens and
    // observations exist nowhere else. Browser Back from an edited case, or
    // opening another case from an edited draft, would take them with it
    // without a word. The address has already moved by the time this runs, so
    // declining means putting it back where the case actually lives.
    const replacesCase =
      requestedId !== null ? caseId !== requestedId : caseId !== null;
    if (replacesCase && dirty && !window.confirm(t('pattern.profile.page.confirmDiscard'))) {
      navigate(caseId === null ? '/modeling/pattern' : `/modeling/pattern/${caseId}`, {
        replace: true,
      });
      return;
    }
    if (requestedId !== null) {
      // Already in hand, which is what happens the moment a new case is filed:
      // the save returns an id, the address follows it, and this effect runs.
      // Loading here would fetch the copy the server has and replace a working
      // copy that may have moved on since the request went out — the curator
      // kept typing, the store deliberately kept those edits, and a reload
      // would undo exactly what it kept.
      if (caseId === requestedId) return;
      void load(requestedId, PATTERN_MODULES);
    } else {
      // The bare route is a new case, and anything still on its way in is about
      // a case this screen has stopped showing. Disowned first and
      // unconditionally: a load started from a fresh draft leaves `caseId`
      // null, so a check on that would let the late answer through — and it
      // would install a saved case over the draft, under an address naming no
      // case at all.
      cancelLoad();
      // Start the picker over. The endpoint orders by when a case was last
      // touched, so saving moves that case to the first page — and a cached
      // page 0 from before then would show the list without it while another
      // row appeared twice across the stale and refreshed pages. Paging
      // position is not worth keeping across a reordering that invalidates it.
      setListOffset(0);
      setPages((previous) => (Object.keys(previous).length === 0 ? previous : {}));
      if (caseId !== null) {
        // Navigating from a saved case back to the bare route starts a new one
        // rather than leaving the old case on screen under a URL that no longer
        // names it.
        startNew(PATTERN_MODULES[0]!.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedId]);

  // The graph the source walk reads, for the modules this case names. Fetched
  // rather than fixed: a case naming the cocaine module and handed the
  // benzodiazepine fixture would have its ambiguity statement computed against
  // somebody else's metabolism.
  // Only the modules this app ships. The endpoint has nothing to answer for a
  // module it does not know, and a 404 for one retired family would take the
  // whole graph down with it — leaving no profile at all for a case whose other
  // modules are perfectly current. The registry marker is what says the case
  // names a family that has gone.
  const moduleKey = [...new Set(data.moduleIds)]
    .filter((id) => PATTERN_MODULES.some((module) => module.id === id))
    .sort()
    .join(',');
  // The fixture's own graph, for exactly as long as the case *is* the fixture,
  // by identity — a narrower test than the marker above, and deliberately so.
  // Every edit produces a new object, so ticking a second module takes the
  // fixture graph away: keeping it would evaluate the new module's
  // observations against a graph that cannot contain their nodes and report
  // that as a curation gap rather than as the wrong graph. The red warning
  // stays, because the case is still built out of invented numbers.
  const usingFixtureGraph = data === DIAZEPAM_FIXTURE_CASE;
  useEffect(() => {
    setGraphFailed(false);
    if (usingFixtureGraph) {
      // The fixture ships a graph and no enzymes: it is benzodiazepine data,
      // and that module's context field is module-scoped rather than
      // enzyme-derived, so there is nothing for a lineage to route through.
      setGraph(BENZODIAZEPINE_GRAPH);
      setEnzymes(EMPTY_LINEAGE_ENZYMES);
      return;
    }
    const controller = new AbortController();
    const ids = moduleKey ? moduleKey.split(',') : [];
    if (ids.length === 0) {
      setGraph({ nodes: [], edges: [] });
      setEnzymes(EMPTY_LINEAGE_ENZYMES);
      return;
    }
    setGraph(null);
    void fetchModulesMetabolismGraph(ids, controller.signal)
      .then((answer) => {
        setGraph(answer.graph);
        setEnzymes(answer.enzymes);
      })
      .catch(() => {
        // Never an empty graph. An empty graph is a real answer — a module
        // whose substances nobody has entered edges for — and the walk reads it
        // as a curation gap, degrading every source-dependent signal. A dropped
        // request would then turn a network fault into a forensic assessment
        // about the state of the database. No profile at all is the honest
        // answer, so the screen says the graph is missing and offers to ask
        // again.
        if (controller.signal.aborted) return;
        setGraph(null);
        setEnzymes(EMPTY_LINEAGE_ENZYMES);
        setGraphFailed(true);
      });
    return () => controller.abort();
  }, [moduleKey, usingFixtureGraph, graphAttempt]);

  useEffect(() => {
    if (requestedId !== null) return;
    setListFailed(false);
    // Dropped if the offset moves before it lands. Coming back from a case
    // resets the paging, and a page requested at the old offset would
    // otherwise arrive afterwards and reinstate exactly what the reset threw
    // away.
    let current = true;
    void listPatternCases({ limit: PAGE, offset: listOffset })
      // The pages before this one stay: a picker that swapped them out would
      // make paging forward look like paging away from what the curator was
      // looking for.
      .then((rows) => {
        if (current) setPages((previous) => ({ ...previous, [listOffset]: rows }));
      })
      // A failed request is not an empty shelf. Telling a curator their filed
      // work does not exist, because a session expired or a network dropped,
      // is the one answer this list must never give.
      .catch(() => {
        if (current) setListFailed(true);
      });
    return () => {
      current = false;
    };
  }, [requestedId, listOffset, listAttempt]);

  const saved = useMemo(
    () =>
      Object.keys(pages)
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((offset) => pages[offset]!),
    [pages],
  );
  const listLoaded = Object.keys(pages).length > 0;

  // Computed from the case in hand rather than remembered from the load that
  // fetched it: ticking another module changes which registry entries the case
  // computes from, and a remembered answer would go on warning about a family
  // it no longer names while saying nothing about the unstamped one just
  // added. Null before the case has ever been filed — there is no earlier
  // registry to differ from, which is not the same as agreeing with this one.
  const staleness = useMemo(
    () => (caseId === null ? null : registryStaleness(data, PATTERN_MODULES)),
    [caseId, data],
  );

  const modules = useMemo(
    () => PATTERN_MODULES.filter((module) => data.moduleIds.includes(module.id)),
    [data.moduleIds],
  );

  const model = useMemo(
    () =>
      modules.length === 0 || graph === null
        ? null
        : buildProfileFromCase({
            caseData: data,
            modules,
            graph,
            enzymes,
            locale,
          }),
    [data, modules, graph, enzymes, locale],
  );

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-6 px-4 pt-6">
      <div className="space-y-2">
        <h1 className="text-base font-semibold">{t('pattern.profile.page.title')}</h1>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="text-[hsl(var(--muted-foreground))]">
              {t('pattern.profile.page.name')}
            </span>
            {/* Not while another case is on its way in. The name still shows
                the case being left, and everything else about that case is
                already off screen — so a name typed here would be attached to
                whichever case arrives, or dropped when it does. The editor is
                hidden for the same span; this field was the one way left to
                write to a case nobody is looking at. */}
            <Input
              value={caseName}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button
            type="button"
            disabled={pending || draftProblem || status === 'saving' || caseName.trim() === ''}
            onClick={() =>
              void save(PATTERN_MODULES).then((id) => {
                // The URL follows the case, so a reload or a shared link opens
                // what was filed rather than a fresh draft.
                if (id !== null && id !== caseId) navigate(`/modeling/pattern/${id}`);
              })
            }
          >
            {status === 'saving' ? t('pattern.profile.page.saving') : t('pattern.profile.page.save')}
          </Button>
          {draftProblem && (
            <span className="text-xs text-[hsl(var(--destructive))]">
              {t('pattern.profile.page.draftProblem')}
            </span>
          )}
          {dirty && (
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              {t('pattern.profile.page.unsaved')}
            </span>
          )}
        </div>
        {error && (
          <p className="text-sm text-[hsl(var(--destructive))]">
            {t(`pattern.profile.page.error.${error.code}`)}
          </p>
        )}
        {fromExample && (
          <p className="text-xs text-[hsl(var(--destructive))]">
            {t('pattern.profile.page.fixtureNote')} (
            {t('pattern.profile.page.caseLabel', { caseNumber: DIAZEPAM_FIXTURE_CASE_NUMBER })})
          </p>
        )}
        <Staleness staleness={staleness} />
      </div>

      {/* The case in hand is not the one the address names — it is still on its
          way in, or it failed to arrive. Everything below writes, and writing
          here would file the case the curator has already navigated away from,
          under a URL that names another. So there is nothing below until the
          requested case is actually in hand. */}
      {badAddress ? (
        <p className="text-sm text-[hsl(var(--destructive))]">
          {t('pattern.profile.page.badAddress', { caseId: caseIdParam })}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => navigate('/modeling/pattern')}
          >
            {t('pattern.profile.page.toPicker')}
          </button>
        </p>
      ) : pending ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))]" aria-live="polite">
          {status === 'loading'
            ? t('pattern.profile.page.loadingCase', { caseId: requestedId })
            : t('pattern.profile.page.notLoaded', { caseId: requestedId })}
          {status !== 'loading' && (
            <>
              {' '}
              <button
                type="button"
                className="underline"
                onClick={() => void load(requestedId!, PATTERN_MODULES)}
              >
                {t('pattern.profile.page.retry')}
              </button>
            </>
          )}
        </p>
      ) : (
        <>
      {requestedId === null && (
        <section className="space-y-1">
          <h2 className="text-sm font-semibold">{t('pattern.profile.page.savedCases')}</h2>
          {listFailed ? (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {t('pattern.profile.page.listFailed')}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => setListAttempt((attempt) => attempt + 1)}
              >
                {t('pattern.profile.page.retry')}
              </button>
            </p>
          ) : (
            listLoaded &&
            saved.length === 0 && (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                {t('pattern.profile.page.noSavedCases')}
              </p>
            )
          )}
          <ul className="space-y-1 text-sm">
            {saved.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="underline"
                  onClick={() => navigate(`/modeling/pattern/${row.id}`)}
                >
                  {row.name || `#${row.id}`}
                </button>
                {/* A case that no longer parses is listed rather than hidden:
                    the curator saved it, and omitting it looks like lost work
                    instead of work that needs attention. */}
                {row.caseData === null && (
                  <span className="ml-2 text-xs text-[hsl(var(--destructive))]">
                    {t('pattern.profile.page.unreadable')}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {/* The endpoint reports no total, so a full page is the only sign
              another may exist — and without this the older half of a
              curator's work is unreachable from the screen. */}
          {saved.length > 0 && saved.length % PAGE === 0 && (
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setListOffset(saved.length)}
            >
              {t('pattern.profile.page.loadMore')}
            </button>
          )}
          <button
            type="button"
            className="text-sm underline"
            onClick={() => {
              // The same question the route effect asks, for the same reason:
              // this replaces the working copy, and the working copy is the
              // only copy. The address does not move, so the effect never runs
              // — a curator who had entered specimens on the draft route would
              // otherwise lose them to a button labelled as an example.
              if (dirty && !window.confirm(t('pattern.profile.page.confirmDiscard'))) return;
              setData(DIAZEPAM_FIXTURE_CASE);
            }}
          >
            {t('pattern.profile.page.loadExample')}
          </button>
        </section>
      )}

      {/* Keyed by the case, so opening another one remounts both: the field
          drafts inside them are half-typed numbers belonging to the case that
          was on screen, and React would otherwise keep them across the change
          — the previous case's keystrokes sitting over this one's values. */}
      <CaseEditor
        key={`editor-${caseId ?? 'new'}`}
        caseData={data}
        modules={PATTERN_MODULES}
        onChange={setData}
        // `setState` rather than a lambda: a fresh function identity each
        // render would re-run the editor's effect on every keystroke.
        onDraftProblem={setEditorDraftProblem}
      />

      {graphFailed && modules.length > 0 && (
        <p className="text-sm text-[hsl(var(--destructive))]">
          {t('pattern.profile.page.graphFailed')}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => setGraphAttempt((attempt) => attempt + 1)}
          >
            {t('pattern.profile.page.retry')}
          </button>
        </p>
      )}

      {model && (
        <RatioProfile
          key={`profile-${caseId ?? 'new'}`}
          model={model}
          // One field per callback; merging is the caller's job, since passing
          // a setter would replace the record and revert every earlier
          // selection.
          onContextChange={(patch) =>
            setData({
              ...data,
              context: { ...data.context, fields: { ...data.context.fields, ...patch } },
            })
          }
          onDraftProblem={noteProfileDraft}
          onObservationChange={(patch) => {
            // A Map, because the keys are observation ids out of a stored case:
            // `patch['toString']` answers with an inherited function rather
            // than with the absence that is the truth.
            const edits = new Map(Object.entries(patch));
            setData({
              ...data,
              observations: data.observations.map((observation) => {
                const edit = edits.get(observation.id);
                return edit === undefined
                  ? observation
                  : { ...observation, value: edit.value, reportedDecimals: edit.reportedDecimals };
              }),
            });
          }}
        />
      )}
        </>
      )}
    </div>
  );
}

/**
 * What the registry has done since this case was filed.
 *
 * Shown rather than applied silently: the profile is recomputed every time, so
 * a case can read differently from the day it was written down — and in a
 * forensic setting an unexplained change of assessment is worse than a stated
 * one.
 */
function Staleness({ staleness }: { staleness: RegistryStaleness | null }) {
  const { t } = useTranslation();
  if (staleness === null || staleness.kind === 'current') return null;

  return (
    <p className="rounded-lg border border-[hsl(var(--border-subtle))] p-2 text-xs">
      {staleness.kind === 'moved'
        ? t('pattern.profile.page.staleness.moved', {
            modules: staleness.modules
              .map((module) =>
                t('pattern.profile.page.staleness.movedModule', {
                  moduleId: module.moduleId,
                  saved: module.savedVersion ?? '?',
                  current: module.currentVersion ?? '—',
                }),
              )
              .join(', '),
          })
        : t('pattern.profile.page.staleness.unknown', { modules: staleness.modules.join(', ') })}
      {staleness.kind === 'moved' && staleness.unknownModules.length > 0 && (
        <>
          {' '}
          {t('pattern.profile.page.staleness.unknown', {
            modules: staleness.unknownModules.join(', '),
          })}
        </>
      )}
    </p>
  );
}
