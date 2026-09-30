import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DRUG_PARAMETER_IDS, parameterAuthoringGated } from '@/lib/drugParameters';
import { DRUG_COVERAGE_AREAS } from '@/lib/drugCoverageAreas';
import { MODEL_DECLARATION_PARAMETERS } from '@/lib/parameterApplicability';
import { fetchMethods, type MethodRow } from '@/lib/drugApi';
import {
  fetchAgentFocusConfig,
  searchWikiPages,
  updateAgentFocusConfig,
  type AgentFocusConfig,
  type AgentFocusMode,
  type AgentFocusPage,
  type WikiSearchResult,
} from '@/lib/agentFocusApi';

const MODES: AgentFocusMode[] = ['all', 'pages', 'parameters', 'methods'];

export function AgentFocusSection() {
  const { t } = useTranslation();

  const [mode, setMode] = useState<AgentFocusMode>('all');
  const [pages, setPages] = useState<AgentFocusPage[]>([]);
  const [parameters, setParameters] = useState<string[]>([]);
  const [methodIds, setMethodIds] = useState<number[]>([]);
  const [skipWikiContent, setSkipWikiContent] = useState(false);
  /**
   * The switch as this form last saw it on the server, so a save can tell an
   * admin's decision from a value it merely carried along. See `handleSave`.
   */
  const [loadedSkipWikiContent, setLoadedSkipWikiContent] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WikiSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [methods, setMethods] = useState<MethodRow[]>([]);
  const [methodsLoading, setMethodsLoading] = useState(false);
  const [methodsError, setMethodsError] = useState(false);

  /**
   * Mirror a server config into the form.
   *
   * The wiki switch binds to `skipWikiContentSetting` — what the admin
   * actually ticked — and never to the effective `skipWikiContent`, which
   * folds in the `parameters` mode override. Reading the effective value here
   * would leave the form unable to tell a ticked box from an implied one:
   * under a parameter focus it would load `true` however the switch was left,
   * and the next save under any other mode would write back whatever it had
   * guessed. Either direction is a guard changing because a mode changed. The
   * box is rendered ticked-and-disabled under that mode from `mode` alone, so
   * the implication is still visible without ever entering the state.
   */
  const applyConfig = useCallback((config: AgentFocusConfig) => {
    setMode(config.mode);
    setPages(config.pages);
    setParameters(config.parameters);
    setMethodIds(config.methodIds);
    setSkipWikiContent(config.skipWikiContentSetting);
    setLoadedSkipWikiContent(config.skipWikiContentSetting);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetchAgentFocusConfig()
      .then((config) => {
        applyConfig(config);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [applyConfig]);

  useEffect(() => {
    load();
  }, [load]);

  // Lazy-load the analytical-method list the first time 'methods' mode is
  // shown. Admins can read /api/methods; the stored config only keeps ids.
  useEffect(() => {
    if (mode !== 'methods' || methods.length > 0 || methodsLoading) return;
    setMethodsLoading(true);
    setMethodsError(false);
    fetchMethods()
      .then(({ methods: rows, gated }) => {
        setMethods(gated ? [] : rows);
      })
      .catch(() => setMethodsError(true))
      .finally(() => setMethodsLoading(false));
  }, [mode, methods.length, methodsLoading]);

  // Debounced page typeahead (only relevant in 'pages' mode).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode !== 'pages' || !query.trim()) {
      setResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      searchWikiPages(query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, mode]);

  const selectedPageIds = useMemo(
    () => new Set(pages.map((p) => p.id)),
    [pages],
  );

  /**
   * Everything an admin can point the agents at, as one list of checkboxes.
   *
   * The coverage areas ride alongside the parameters rather than in a section
   * of their own: to the admin they are the same decision ("what should the
   * agents work on"), and the API stores them in the same `parameters` array.
   * They sit last because they are the newest and the coarsest.
   */
  const focusTargets = useMemo(
    () => [
      ...DRUG_PARAMETER_IDS.filter((id) => !parameterAuthoringGated(id)).map((id) => ({
        id: id as string,
        label: t(`parameters.${id}.label`, { defaultValue: id }),
      })),
      ...DRUG_COVERAGE_AREAS.map((area) => ({
        id: area.id as string,
        label: t(area.i18nKey, { defaultValue: area.id }),
      })),
    ],
    [t],
  );
  const selectedParams = useMemo(() => new Set(parameters), [parameters]);
  const selectedMethodIds = useMemo(() => new Set(methodIds), [methodIds]);

  function addPage(result: WikiSearchResult) {
    setSaved(false);
    if (selectedPageIds.has(result.id)) return;
    setPages((prev) => [
      ...prev,
      {
        id: result.id,
        title: result.title,
        slug: result.slug,
        pageType: result.pageType,
      },
    ]);
    setQuery('');
    setResults([]);
  }

  function removePage(id: number) {
    setSaved(false);
    setPages((prev) => prev.filter((p) => p.id !== id));
  }

  function toggleParameter(id: string) {
    setSaved(false);
    setParameters((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  // `parameters` mode already refuses every agent wiki write, so the switch is
  // not a separate choice there — it is reported and rendered as on.
  const wikiClosedByMode = mode === 'parameters';

  // The parameter list narrows two modes now: in `parameters` it IS the
  // instruction, in `methods` it is an optional extra filter on the panels.
  const showParameterPicker = mode === 'parameters' || mode === 'methods';

  /**
   * One click for the pairing this composition was built for: the panels an
   * admin already selected, narrowed to the four parameters that decide which
   * equations a drug can be simulated with. Additive — it leaves any other
   * selected parameter alone rather than replacing the set.
   */
  function selectModelStructure() {
    setSaved(false);
    setParameters((prev) => [
      ...prev,
      ...MODEL_DECLARATION_PARAMETERS.filter((id) => !prev.includes(id)),
    ]);
  }

  function toggleMethod(id: number) {
    setSaved(false);
    setMethodIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // The switch travels only when this admin actually changed it.
      //
      // Sending it unconditionally makes every save an assertion about the
      // guard, including a save that was about the scope: two admins with the
      // form open, one ticks the switch, the other saves a mode change from a
      // tab loaded before that — and the second request posts the `false` it
      // loaded, reopening agent wiki authoring on a save that said nothing
      // about it. Omitting it is not merely silence, it is the defined way to
      // say "unchanged": the server then leaves the column out of the
      // statement entirely, so the other admin's tick survives.
      //
      // Compared against the loaded value rather than tracked as "touched",
      // so ticking and unticking again is the no-op it looks like. The scope
      // fields keep last-write-wins, which is the ordinary and visible
      // behaviour for an instruction; a guard is the thing that must not come
      // off by accident.
      const config = await updateAgentFocusConfig({
        mode,
        pageIds: pages.map((p) => p.id),
        parameters,
        methodIds,
        ...(skipWikiContent === loadedSkipWikiContent ? {} : { skipWikiContent }),
      });
      applyConfig(config);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">{t('agentFocus.title')}</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('agentFocus.description')}
      </p>

      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 mb-3">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">
          {t('agentFocus.loading')}
        </p>
      ) : (
        <div className="space-y-4 max-w-2xl">
          <fieldset className="space-y-2">
            {MODES.map((m) => (
              <label
                key={m}
                className="flex items-start gap-3 rounded-md border border-border px-3 py-2 cursor-pointer"
              >
                <input
                  type="radio"
                  name="agent-focus-mode"
                  className="mt-1"
                  checked={mode === m}
                  onChange={() => {
                    setMode(m);
                    setSaved(false);
                  }}
                />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {t(`agentFocus.mode.${m}.label`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`agentFocus.mode.${m}.description`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {/* Orthogonal to the mode above: the mode says WHICH drugs and
              parameters are in scope, this says WHETHER the agents may author
              wiki content at all. `parameters` mode closes it by itself, so
              there the box is shown ticked and locked rather than hidden —
              hiding it would read as "this setting does not exist here". */}
          <label
            className={`flex items-start gap-3 rounded-md border border-border px-3 py-2 ${
              wikiClosedByMode ? 'cursor-default opacity-70' : 'cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={wikiClosedByMode || skipWikiContent}
              disabled={wikiClosedByMode}
              onChange={() => {
                setSaved(false);
                setSkipWikiContent((prev) => !prev);
              }}
            />
            <span className="min-w-0">
              <span className="block font-medium">
                {t('agentFocus.skipWikiContent.label')}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(
                  wikiClosedByMode
                    ? 'agentFocus.skipWikiContent.impliedByMode'
                    : 'agentFocus.skipWikiContent.description',
                )}
              </span>
            </span>
          </label>

          {mode === 'pages' && (
            <div className="rounded-md border border-border p-3">
              <h3 className="text-sm font-medium mb-2">
                {t('agentFocus.pagesHeading')}
              </h3>
              <div className="relative mb-3">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('agentFocus.searchPlaceholder')}
                />
                {query.trim() && (results.length > 0 || searching) && (
                  <ul className="absolute z-10 mt-1 w-full rounded-md border border-border bg-background shadow-md max-h-64 overflow-auto">
                    {searching && results.length === 0 ? (
                      <li className="px-3 py-2 text-sm text-muted-foreground">
                        {t('agentFocus.searching')}
                      </li>
                    ) : (
                      results.map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 disabled:opacity-50"
                            disabled={selectedPageIds.has(r.id)}
                            onClick={() => addPage(r)}
                          >
                            <span className="font-medium">{r.title}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {r.slug}
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>

              {pages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('agentFocus.noPages')}
                </p>
              ) : (
                <ul className="border border-border rounded-md divide-y divide-border">
                  {pages.map((p) => (
                    <li
                      key={p.id}
                      className="px-3 py-2 flex items-center justify-between gap-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-sm">
                          {p.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {p.slug}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => removePage(p.id)}
                      >
                        {t('agentFocus.remove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}


          {mode === 'methods' && (
            <div className="rounded-md border border-border p-3">
              <h3 className="text-sm font-medium mb-2">
                {t('agentFocus.methodsHeading')}
              </h3>
              {methodsLoading ? (
                <p className="text-sm text-muted-foreground">
                  {t('agentFocus.methodsLoading')}
                </p>
              ) : methodsError ? (
                <p className="text-sm text-rose-700 dark:text-rose-300">
                  {t('agentFocus.methodsError')}
                </p>
              ) : methods.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('agentFocus.noMethods')}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {methods.map((m) => (
                    <li key={m.id}>
                      <label className="flex items-start gap-2 rounded-md px-2 py-1 text-sm cursor-pointer hover:bg-muted/40">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={selectedMethodIds.has(m.id)}
                          onChange={() => toggleMethod(m.id)}
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">
                            {m.code} — {m.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t('agentFocus.methodComponentCount', {
                              count: m.componentCount,
                            })}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {showParameterPicker && (
            <div className="rounded-md border border-border p-3">
              <h3 className="text-sm font-medium mb-2">
                {mode === 'methods'
                  ? t('agentFocus.parametersWithinMethodsHeading')
                  : t('agentFocus.parametersHeading')}
              </h3>
              {/* In methods mode this narrowing is optional, and an empty
                  selection means "every parameter" rather than "none" — say so,
                  because the same control means the opposite one mode up. */}
              {mode === 'methods' ? (
                <p className="text-xs text-muted-foreground mb-2">
                  {t('agentFocus.parametersWithinMethodsHint')}
                </p>
              ) : null}
              <div className="grid gap-1.5 sm:grid-cols-2">
                {focusTargets.map(({ id, label }) => (
                  <label
                    key={id}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-sm cursor-pointer hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={selectedParams.has(id)}
                      onChange={() => toggleParameter(id)}
                    />
                    <span className="truncate">{label}</span>
                  </label>
                ))}
              </div>
              {mode === 'methods' && MODEL_DECLARATION_PARAMETERS.some(
                (id) => !selectedParams.has(id),
              ) ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={selectModelStructure}
                >
                  {t('agentFocus.selectModelStructure')}
                </Button>
              ) : null}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t('agentFocus.saving') : t('agentFocus.save')}
            </Button>
            {saved && (
              <span className="text-sm text-emerald-600 dark:text-emerald-400">
                {t('agentFocus.savedConfirmation')}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
