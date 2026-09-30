import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Table,
  TableRow,
  TableHeader,
  TableCell,
} from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Footnote } from "./extensions/Footnote";
import { ReferenceInput } from "./ReferenceInput";
import { parseLocaleNumberDetailed } from "@/lib/parseNumber";
import type { ReferenceRow } from "@/lib/referenceApi";
import { EditorToolbar } from "./EditorToolbar";
import { FootnotePrompt } from "./FootnotePrompt";
import { DrugReferencesList } from "./DrugReferencesList";
import { extractFootnoteIds } from "./WikiRenderer";
import { HeadingWithSectionId } from "./extensions/HeadingWithSectionId";
import { mintTopicSectionIds } from "@/lib/topicSections";
import { Fact } from "./extensions/Fact";
import { MathExtensions } from "./extensions/Math";
import { useDrugBibliography } from "@/lib/useDrugBibliography";
import type { PubChemCompound } from "@/components/PubChemSearchDropdown";
import { NewMonographSearchPanel } from "./NewMonographSearchPanel";
import type { DrugComponent } from "@/types";
import { Input } from "@/components/ui/input";
import { useNavigate } from "react-router-dom";
import { useCan } from "@/lib/usePermissions";
import { normalizeAliases } from "@/lib/drugNames";
import { resolveDrugName } from "@/lib/drugNames";
import { activeLangCode } from "@/lib/useDrugName";
import {
  emptyMonographContentV2,
  isMonographContentV2,
  wrapV1AsV2,
  type MonographContentV2,
} from "@/lib/monographContent";
import {
  MonographSectionsEditor,
  type MonographSectionsEditorHandle,
} from "./MonographSectionsEditor";
import "@/styles/wiki-prose.css";

/**
 * Render one reading of a separator-ambiguous molecular weight in the
 * author's locale, so the two offered choices are visibly different
 * (nb: "62,005 g/mol" vs "62 005 g/mol"). The unit is included because the
 * magnitude is the whole point of the choice.
 */
function formatMwCandidate(value: number, lang: string): string {
  const formatted = new Intl.NumberFormat(lang, {
    maximumFractionDigits: 20,
  }).format(value);
  return `${formatted} g/mol`;
}

export interface NewDrugFormFields {
  /** Per-language names; at least one entry required. */
  names: Record<string, string>;
  nameShort?: string;
  aliases?: string[];
  pubchemCid?: number;
  molecularWeight?: number;
}

export interface WikiEditorSaveOptions {
  pageType?: string;
  drugCid?: number;
  newDrug?: NewDrugFormFields;
  /**
   * Wiki parent page id (#301). null clears the parent; undefined leaves
   * it unchanged. Topic and drug-monograph pages can be nested under topic
   * pages up to MAX_NESTING_DEPTH levels.
   */
  parentId?: number | null;
}

interface WikiEditorProps {
  mode: "create" | "edit";
  initialTitle?: string;
  initialContent?: unknown;
  initialEditSummary?: string;
  pageType?: string;
  slug?: string;
  /**
   * Wiki page id; only set in edit mode for an existing page. The
   * monograph section editor uses this to gate the per-section "Add fact"
   * affordance on a real target the API can route to.
   */
  pageId?: number;
  drugCid?: number;
  initialParentId?: number | null;
  initialParentTitle?: string | null;
  /**
   * Hydration prop for reopening a pending wiki_new draft (#329). When
   * a draft was originally submitted with a new-drug payload (no
   * existing drug row yet), this carries the per-field values back into
   * the form so the author isn't sent back through the search-first
   * flow only to overwrite their CID/MW with a placeholder rebuild.
   */
  initialNewDrug?: NewDrugFormFields;
  /**
   * Seeds the new-monograph search field (search stage of create mode).
   * Used when the editor is opened for a known-but-missing compound name
   * so the kinetix + PubChem lookups run immediately for it.
   */
  initialSearchQuery?: string;
  onSave: (
    title: string,
    content: unknown,
    editSummary?: string,
    options?: WikiEditorSaveOptions,
    action?: "publish" | "review",
  ) => Promise<void>;
  onCancel: () => void;
}

export function WikiEditor({
  mode,
  initialTitle = "",
  initialContent,
  initialEditSummary = "",
  pageType = "topic",
  pageId,
  drugCid,
  initialParentId = null,
  initialParentTitle = null,
  initialNewDrug,
  initialSearchQuery = "",
  onSave,
  onCancel,
}: WikiEditorProps) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const navigate = useNavigate();
  const [title, setTitle] = useState(initialTitle);
  const [editSummary, setEditSummary] = useState(initialEditSummary);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedPageType, setSelectedPageType] = useState(pageType);
  const [showCitePanel, setShowCitePanel] = useState(false);
  const [selectedDrugCid, setSelectedDrugCid] = useState<number | undefined>(
    drugCid,
  );
  // New-drug creation state: shown only for drug_monograph in create mode
  // when no existing drug has been linked. Author fills in basic drug
  // identification + (optionally) PK parameter values backed by a shared
  // citation; the backend creates a drugs row alongside the monograph so
  // it is immediately searchable and usable in the simulator.
  const [newDrugNameNb, setNewDrugNameNb] = useState(
    initialNewDrug?.names?.nb ?? "",
  );
  const [newDrugNameEn, setNewDrugNameEn] = useState(
    initialNewDrug?.names?.en ?? "",
  );
  const [newDrugNameShort, setNewDrugNameShort] = useState(
    initialNewDrug?.nameShort ?? "",
  );
  const [newDrugAliases, setNewDrugAliases] = useState(
    (initialNewDrug?.aliases ?? []).join(", "),
  );
  const [newDrugPubchemCid, setNewDrugPubchemCid] = useState(
    initialNewDrug?.pubchemCid != null ? String(initialNewDrug.pubchemCid) : "",
  );
  const [newDrugMolecularWeight, setNewDrugMolecularWeight] = useState(
    initialNewDrug?.molecularWeight != null
      ? String(initialNewDrug.molecularWeight)
      : "",
  );
  // A molecular weight like "62.005" (nitrate, straight from PubChem) is
  // separator-ambiguous to `parseLocaleNumber`: it could equally be 62.005
  // or a thousands-grouped 62005, and the parser refuses to guess between
  // readings that differ by 1000×. That refusal used to be a dead end — the
  // form autofilled the value from PubChem and then rejected it as "not a
  // number" with no way for the author to spell it differently. We keep the
  // 1000× guard and record the resolved reading instead: machine-supplied
  // values are pre-resolved (PubChem always emits a dot decimal), and a
  // hand-typed ambiguous value gets a pick-one prompt under the field. The
  // text is stored alongside the number so any later edit invalidates it.
  const [newDrugMwResolved, setNewDrugMwResolved] = useState<{
    text: string;
    value: number;
  } | null>(
    initialNewDrug?.molecularWeight != null
      ? {
          text: String(initialNewDrug.molecularWeight),
          value: initialNewDrug.molecularWeight,
        }
      : null,
  );
  // Two-stage flow for monograph creation (#329):
  // 'search' shows only the combined kinetix + PubChem search panel; the
  // form fields (title, name fields, PK box, section editor) are revealed
  // once the author selects a result or chooses to enter the drug
  // manually. Edit mode, topic pages, and reopened drafts that already
  // carry a new-drug payload skip the search stage so the author doesn't
  // have to re-do the dedup search.
  const [creationStage, setCreationStage] = useState<"search" | "form">(
    mode === "create" &&
      pageType === "drug_monograph" &&
      !drugCid &&
      !initialNewDrug
      ? "search"
      : "form",
  );
  // Bumped on Back to search to force the per-section TipTap editor and
  // any other content-bearing children to remount with cleared state.
  // Internal TipTap state survives a content prop change otherwise.
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [parentId, setParentId] = useState<number | null>(
    initialParentId ?? null,
  );
  const [parentTitle, setParentTitle] = useState<string | null>(
    initialParentTitle ?? null,
  );
  const [parentQuery, setParentQuery] = useState("");
  const [parentResults, setParentResults] = useState<
    Array<{ id: number; slug: string; title: string; pageType: string }>
  >([]);
  const [parentSearching, setParentSearching] = useState(false);
  // Two different gates, and the API treats them as such: reaching the
  // whole-page save path at all is `wiki.page.submit`, while
  // `edit.directWrite` only decides whether that save publishes straight
  // away or is queued for review.
  const canSubmitPage = useCan("wiki.page.submit");
  const canPublishDirectly = useCan("edit.directWrite");
  const canCreateDrug = useCan("drug.create");
  const isMonographCreate =
    mode === "create" && selectedPageType === "drug_monograph";
  // A monograph create with no existing drug picked sends a `newDrug` payload,
  // which POST /api/wiki/pages rejects without drug.create — so the save is
  // blocked here rather than at the 403.
  const blockedByDrugCreate =
    isMonographCreate && !selectedDrugCid && !canCreateDrug;

  // When the author flips the page-type radio from "Topic" to "Drug
  // monograph" mid-create (or clears a linked drug back to no selection),
  // the de-duplication search must run before they can fill out the form.
  // Without this effect, `creationStage` only reflects the initial prop
  // and the search-first flow gets bypassed. Skip the very first run so
  // a reopened draft hydrated into form stage isn't kicked back to
  // search on mount.
  const initialStageMountRef = useRef(true);
  useEffect(() => {
    if (initialStageMountRef.current) {
      initialStageMountRef.current = false;
      return;
    }
    if (
      mode === "create" &&
      selectedPageType === "drug_monograph" &&
      !selectedDrugCid
    ) {
      setCreationStage("search");
    }
  }, [mode, selectedPageType, selectedDrugCid]);
  // Drug monographs use the per-section editor (#276); topic pages keep the
  // legacy single-surface editor. Determined from the live page type so the
  // create-mode radio toggles correctly without a remount.
  const isMonographMode = selectedPageType === "drug_monograph";

  // v2 envelope state for monograph mode. v1 input is wrapped on first
  // mount so existing pages can be opened directly in the section editor.
  const [monographContent, setMonographContent] = useState<MonographContentV2>(
    () => {
      if (isMonographContentV2(initialContent)) return initialContent;
      if (initialContent) return wrapV1AsV2(initialContent);
      return emptyMonographContentV2();
    },
  );
  const monographEditorRef = useRef<MonographSectionsEditorHandle | null>(null);

  const editor = useEditor({
    extensions: [
      // Topic pages now anchor atomic facts on heading sectionIds
      // (#310 phase 2 / #348). Disable StarterKit's vanilla heading so
      // HeadingWithSectionId owns the schema — otherwise the
      // `data-section-id` attribute on existing headings would round-trip
      // through this admin-only editor as silently stripped.
      StarterKit.configure({ link: false, heading: false }),
      HeadingWithSectionId,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image,
      Link.configure({ openOnClick: false }),
      Footnote,
      // #348: topic pages can carry approved `fact` nodes after
      // phase 2. Without registering the schema here, ProseMirror
      // would drop them silently from `editor.getJSON()` on save and
      // delete the underlying claims + their citation links. The
      // FactView's edit affordance is no-op in this whole-page
      // surface (admin override), but the nodes round-trip.
      Fact,
      // Inline `$…$` and display `$$…$$` math nodes (KaTeX). Input rules
      // make them work without a toolbar; the carrier is `data-tex`.
      ...MathExtensions,
    ],
    content: (initialContent as Record<string, unknown>) ?? {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
    editorProps: {
      attributes: {
        class:
          "wiki-prose prose prose-sm max-w-none focus:outline-none min-h-[300px] px-4 py-3",
      },
    },
  });

  // `null` when the field is blank (molecular weight is optional). An
  // author-confirmed reading short-circuits the parser so the resolved
  // value survives re-renders without the prompt reappearing.
  const molecularWeightParse = useMemo(() => {
    const trimmed = newDrugMolecularWeight.trim();
    if (trimmed === "") return null;
    if (newDrugMwResolved?.text === trimmed) {
      return { ok: true as const, value: newDrugMwResolved.value };
    }
    return parseLocaleNumberDetailed(trimmed);
  }, [newDrugMolecularWeight, newDrugMwResolved]);

  const handleSave = useCallback(
    async (action: "publish" | "review" = "review") => {
      if (!title.trim()) return;
      // Saving is meaningless before the search-first flow has resolved
      // — without a Kinetix/PubChem pick or explicit manual entry, the
      // form would publish a monograph using whatever stale title was
      // left over from a topic draft. Only apply this guard in monograph
      // create mode; topic drafts are unaffected even if the stage state
      // wasn't reset after a topic→monograph→topic toggle.
      if (isMonographCreate && creationStage === "search") return;
      // Topic pages still use the single legacy editor; monographs gather
      // their content from the per-section editor's imperative handle.
      if (!isMonographMode && !editor) return;
      setError("");

      // Kinetix is a Norwegian product, so a monograph's stored title is the
      // drug's Norwegian name whenever it has one — regardless of the author's
      // active UI language. Existing-drug picks already seed the title with the
      // Norwegian name (see handlePickExistingDrug); the new-drug branch below
      // overrides it from the freshly typed `nb` field.
      let pageTitle = title;

      // Build the new-drug payload for monograph creation mode when the user
      // hasn't picked an existing drug row.
      let newDrug: NewDrugFormFields | undefined;
      if (isMonographCreate && !selectedDrugCid) {
        // Creating the catalog drug alongside the monograph is its own
        // capability server-side; stop here rather than filling out the form
        // and collecting a 403.
        if (!canCreateDrug) {
          setError(t("wikiEditor.needDrugCreate"));
          return;
        }
        // Pull a localized name from whichever language field is filled, or
        // fall back to the page title if both are empty. The user's active
        // interface language determines which slot the title backfills into.
        const nbName = newDrugNameNb.trim();
        const enName = newDrugNameEn.trim();
        const fallbackTitle = title.trim();
        const names: Record<string, string> = {};
        if (nbName) names.nb = nbName;
        if (enName) names.en = enName;
        if (Object.keys(names).length === 0 && fallbackTitle) {
          names[lang] = fallbackTitle;
        }
        if (Object.keys(names).length === 0) {
          setError(t("wikiEditor.errorDrugName"));
          return;
        }
        // Prefer the Norwegian name for the page title; fall back to the
        // typed title (e.g. an English-only or PubChem-sourced drug).
        if (names.nb) pageTitle = names.nb;
        // Bail before building the payload so an unresolved 1000× ambiguity
        // can't reach the API as a silently-picked reading.
        if (molecularWeightParse && !molecularWeightParse.ok) {
          setError(
            molecularWeightParse.reason === "ambiguous"
              ? t("wikiEditor.errorMolecularWeightAmbiguous")
              : t("wikiEditor.errorMolecularWeight"),
          );
          return;
        }
        const aliases = normalizeAliases(newDrugAliases);
        newDrug = {
          names,
          nameShort: newDrugNameShort.trim() || undefined,
          aliases: aliases.length > 0 ? aliases : undefined,
          pubchemCid: newDrugPubchemCid.trim()
            ? Number(newDrugPubchemCid.trim())
            : undefined,
          molecularWeight: molecularWeightParse?.value,
        };
        if (
          newDrug.pubchemCid !== undefined &&
          !Number.isFinite(newDrug.pubchemCid)
        ) {
          setError(t("wikiEditor.errorPubchem"));
          return;
        }
      }

      setSaving(true);
      try {
        const options: WikiEditorSaveOptions = {
          pageType: selectedPageType,
          drugCid: selectedDrugCid,
          newDrug,
          // Only forward when something changed so update PUTs don't
          // re-write parentId on every save.
          parentId:
            parentId !== (initialParentId ?? null) ? parentId : undefined,
        };
        let content = isMonographMode
          ? (monographEditorRef.current?.getContent() ?? monographContent)
          : editor!.getJSON();
        // #348: when an admin authors or edits a topic page through the
        // legacy whole-page editor, every new heading lands without a
        // `sectionId`. Mint stable ids before submission so non-admin
        // atomic-fact editing can anchor against those headings the
        // moment the page is saved (the one-shot migration only runs
        // once; without this, every new heading would create a section
        // that's invisible to TopicSectionsEditor).
        if (!isMonographMode && selectedPageType === "topic") {
          content = mintTopicSectionIds(content as never).doc as typeof content;
        }
        await onSave(
          pageTitle,
          content,
          editSummary.trim() || undefined,
          options,
          action,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : t("wiki.failedToSave"));
      } finally {
        setSaving(false);
      }
    },
    [
      editor,
      title,
      editSummary,
      selectedPageType,
      selectedDrugCid,
      isMonographMode,
      isMonographCreate,
      creationStage,
      monographContent,
      newDrugNameNb,
      newDrugNameEn,
      newDrugNameShort,
      newDrugAliases,
      newDrugPubchemCid,
      molecularWeightParse,
      lang,
      parentId,
      initialParentId,
      onSave,
      // The matrix can arrive after the session, so the guard inside must not
      // capture the initial `false` and refuse a save the API would accept.
      canCreateDrug,
      t,
    ],
  );

  // Parent-page search. Hits the wiki search endpoint with a 200ms debounce
  // and filters out the page itself so authors can't pick themselves as
  // their own parent — the API enforces this too, but the UI shouldn't
  // even offer it.
  useEffect(() => {
    const q = parentQuery.trim();
    if (!q) {
      setParentResults([]);
      setParentSearching(false);
      return;
    }
    setParentSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/wiki/search?q=${encodeURIComponent(q)}&limit=8`,
        );
        if (!res.ok) {
          setParentResults([]);
          return;
        }
        const data = (await res.json()) as {
          results?: Array<{
            id: number;
            slug: string;
            title: string;
            pageType: string;
          }>;
        };
        const filtered = (data.results ?? []).filter(
          (r) => r.id !== (pageId ?? -1),
        );
        setParentResults(filtered);
      } finally {
        setParentSearching(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [parentQuery, pageId]);

  // Handlers for the #329 search-stage panel. Kept close to the other
  // form actions so the stage transitions sit alongside the rest of the
  // create-flow logic.

  const handlePickExistingDrug = useCallback(
    async (drug: DrugComponent) => {
      if (!drug._dbId) return;
      const res = await fetch(`/api/wiki/pages?drugCid=${drug._dbId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.page?.slug) {
          navigate(`/wiki/${data.page.slug}`);
          return;
        }
      }
      setSelectedDrugCid(drug._dbId);
      // Always replace the title so a stale topic-mode title can't ride into
      // the new monograph; the user can edit it freely afterwards. Kinetix is
      // a Norwegian product, so prefer the Norwegian name as the title (with
      // graceful fallback to whatever language the drug has).
      setTitle(resolveDrugName(drug.names, "nb"));
      setCreationStage("form");
    },
    [navigate],
  );

  const handlePickPubChem = useCallback((compound: PubChemCompound) => {
    // PubChem's primary term is English; fill EN so the user just types
    // the Norwegian translation (if any) once the form opens. We always
    // overwrite EN/CID/MW/title because picking a (different) compound
    // means the previously selected one is no longer the user's choice
    // — keeping any of the old fields would let stale data ride into
    // the submitted monograph.
    setNewDrugNameEn(compound.name);
    setNewDrugPubchemCid(String(compound.cid));
    // PubChem hands us a real number, so its stringification is canonical
    // dot-decimal — never a thousands grouping. Record that reading up front
    // so a value like nitrate's 62.005 doesn't strand the author on an
    // ambiguity prompt for a choice only the machine could have made.
    const mwText =
      compound.molecularWeight != null ? String(compound.molecularWeight) : "";
    setNewDrugMolecularWeight(mwText);
    setNewDrugMwResolved(
      compound.molecularWeight != null
        ? { text: mwText, value: compound.molecularWeight }
        : null,
    );
    setTitle(compound.name);
    setCreationStage("form");

    // Lazy synonyms autofill (loose-thread #363). Fired after the form
    // stage opens so the search-stage round-trip stays minimal: PubChem
    // synonyms are an extra HTTP call that most authors won't need to
    // see in the search results, but the create form benefits from
    // having them pre-populated. Preserves any aliases the author has
    // already typed (e.g. when re-picking a different compound while
    // the form is open) by appending the canonical name first and
    // skipping anything that's already present.
    if (compound.cid > 0) {
      void (async () => {
        try {
          const res = await fetch(
            `/api/pubchem-search?expand=${encodeURIComponent(String(compound.cid))}`,
          );
          if (!res.ok) return;
          const data = (await res.json()) as { synonyms?: string[] };
          const fetched = data.synonyms ?? [];
          if (fetched.length === 0) return;
          setNewDrugAliases((current) => {
            const existing = current
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const lower = new Set(existing.map((s) => s.toLowerCase()));
            // Drop the canonical name since it's already in nameEn.
            lower.add(compound.name.toLowerCase());
            const merged = [...existing];
            for (const syn of fetched) {
              if (lower.has(syn.toLowerCase())) continue;
              merged.push(syn);
              lower.add(syn.toLowerCase());
            }
            return merged.join(", ");
          });
        } catch {
          // Synonyms autofill is best-effort; a network blip shouldn't
          // disturb the create flow.
        }
      })();
    }
  }, []);

  const handleSkipManual = useCallback(
    (typedQuery: string) => {
      // Seed the active-language name slot with whatever the author typed
      // so they don't have to re-enter it. The other slot stays empty.
      if (lang === "nb") {
        setNewDrugNameNb(typedQuery);
      } else {
        setNewDrugNameEn(typedQuery);
      }
      // Always replace the title so a stale topic-mode title can't ride
      // into the new monograph; the user can edit it freely afterwards.
      setTitle(typedQuery);
      setCreationStage("form");
    },
    [lang],
  );

  const handleBackToSearch = useCallback(() => {
    setCreationStage("search");
    setSelectedDrugCid(undefined);
    // Drop any state that came from a previous PubChem pick or manual
    // entry. Without this, a back-to-search → manual flow can submit the
    // earlier compound's CID/MW/title attached to a brand-new drug.
    setTitle("");
    setNewDrugNameNb("");
    setNewDrugNameEn("");
    setNewDrugNameShort("");
    setNewDrugAliases("");
    setNewDrugPubchemCid("");
    setNewDrugMolecularWeight("");
    setNewDrugMwResolved(null);
    setMonographContent(emptyMonographContentV2());
    // Force the per-section editor to remount with the cleared content.
    // Without bumping the key it keeps its internal TipTap state and a
    // subsequent save would publish the previous drug's prose.
    setDraftEpoch((n) => n + 1);
  }, []);

  function handleCiteReferenceCreated(ref: ReferenceRow) {
    if (isMonographMode) {
      // Targets the most recently focused section editor; falls back to
      // `summary` when nothing has been focused yet. In #303 hard mode
      // (edit flow, pageId set) the section editor is read-only —
      // skip the programmatic insert so the cite panel can't smuggle a
      // footnote into prose around the atomic-fact pipeline. The
      // citation row is still saved to the page's references table by
      // the panel itself; contributors attach it to a new claim via
      // the AddFactPanel.
      const active = monographEditorRef.current?.getActiveEditor();
      if (active?.isEditable) {
        active.commands.insertFootnote(ref.id);
      }
    } else {
      editor?.commands.insertFootnote(ref.id);
    }
    // Keep cite panel open for adding more references
  }

  // Footnote ids extracted live from the editor content. Re-derived on every
  // doc update so the references panel below the editor stays in sync as
  // citations are inserted, removed, or pasted. In monograph mode the v2
  // envelope already updates on every section edit, so a useMemo over
  // monographContent gives us the same liveness without per-section
  // subscriptions.
  const [topicFootnoteRefIds, setTopicFootnoteRefIds] = useState<number[]>(
    () =>
      initialContent && !isMonographMode
        ? extractFootnoteIds(initialContent)
        : [],
  );
  const monographFootnoteIds = useMemo(
    () => (isMonographMode ? extractFootnoteIds(monographContent) : []),
    [isMonographMode, monographContent],
  );
  const footnoteRefIds = isMonographMode
    ? monographFootnoteIds
    : topicFootnoteRefIds;
  // Memoize a stable array reference keyed on the comma-joined ids so the
  // bibliography hook doesn't refetch on every keystroke.
  const footnoteIdsKey = footnoteRefIds.join(",");
  const stableFootnoteIds = useMemo(
    () => footnoteRefIds,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [footnoteIdsKey],
  );

  useEffect(() => {
    if (!editor || isMonographMode) return;
    const sync = () => {
      const ids = extractFootnoteIds(editor.getJSON());
      setTopicFootnoteRefIds((prev) => {
        if (prev.length === ids.length && prev.every((v, i) => v === ids[i])) {
          return prev;
        }
        return ids;
      });
    };
    sync();
    editor.on("update", sync);
    return () => {
      editor.off("update", sync);
    };
  }, [editor, isMonographMode]);

  // Track which footnote (if any) the cursor is currently on, so the panel
  // below can highlight that entry. Topic mode walks the single editor's
  // selection; monograph mode receives the active reference id from the
  // currently focused section editor via callback.
  const [activeReferenceId, setActiveReferenceId] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (!editor || isMonographMode) return;
    const sync = () => {
      const { from } = editor.state.selection;
      let found: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (found != null) return false;
        if (node.type.name === "footnote") {
          const end = pos + node.nodeSize;
          // Cursor sits on or immediately after the atom — both feel "on it"
          // to a writer. nodeSize for an inline atom is 1.
          if (from >= pos && from <= end) {
            const refId = node.attrs.referenceId;
            if (typeof refId === "number") found = refId;
            return false;
          }
        }
        return true;
      });
      setActiveReferenceId(found);
    };
    sync();
    editor.on("selectionUpdate", sync);
    editor.on("update", sync);
    return () => {
      editor.off("selectionUpdate", sync);
      editor.off("update", sync);
    };
  }, [editor, isMonographMode]);

  // The effective drug for citation purposes is whatever the picker
  // currently holds. selectedDrugCid is seeded from the drugCid prop on
  // mount, so initial behavior matches the prop; thereafter it is the
  // source of truth — including the "Change drug" flow which clears the
  // selection to undefined. Falling back to the prop here would leak the
  // original drug's bibliography after a clear.
  const effectiveDrugCid = selectedDrugCid;
  const { ordered: orderedRefs } = useDrugBibliography(
    effectiveDrugCid ?? null,
    stableFootnoteIds,
  );

  // Only show entries actually cited in the body. useDrugBibliography
  // returns the drug's full bibliography (parameter-level refs, indicator
  // refs, footnote refs) — useful for read-only views where the page also
  // lists parameter citations, but here we want strictly "what's in the
  // prose", per #270. We keep the global numbering so the displayed
  // numbers stay in lock-step with the [N] superscripts in the editor.
  const cited = useMemo(
    () =>
      orderedRefs?.filter((r) => stableFootnoteIds.includes(r.row.id)) ?? null,
    [orderedRefs, stableFootnoteIds],
  );

  // Keyboard shortcuts: Ctrl+S to save, Ctrl+Shift+R to cite
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        // Don't let Ctrl+S fire a save the API would reject, and don't let it
        // publish directly for someone who may only submit for review.
        if (canPublishDirectly) handleSave("publish");
        else if (canSubmitPage) handleSave("review");
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "R") {
        e.preventDefault();
        setShowCitePanel(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, canPublishDirectly, canSubmitPage]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">
          {mode === "create" ? t("wiki.newPage") : t("wiki.editPage")}
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="text-sm px-3 py-1.5 text-muted-foreground hover:text-foreground"
          >
            {t("common.cancel")}
          </button>
          {canSubmitPage ? (
            <>
              <button
                onClick={() => handleSave("review")}
                disabled={
                  saving ||
                  !title.trim() ||
                  (isMonographCreate && creationStage === "search") ||
                  blockedByDrugCreate
                }
                className="text-sm border border-input bg-background px-4 py-1.5 rounded-md hover:bg-muted disabled:opacity-50"
              >
                {saving ? t("wiki.saving") : t("wiki.submitForReview")}
              </button>
              {canPublishDirectly && (
                <button
                  onClick={() => handleSave("publish")}
                  disabled={
                    saving ||
                    !title.trim() ||
                    (isMonographCreate && creationStage === "search") ||
                    blockedByDrugCreate
                  }
                  className="text-sm bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving
                    ? t("wiki.saving")
                    : mode === "create"
                      ? t("wiki.createPublish")
                      : t("wiki.savePublish")}
                </button>
              )}
            </>
          ) : null}
          {/*
            #310: whole-page Save / Submit-for-review is admin-only.
            Non-admins still need the route reachable so they can use the
            atomic-fact panels (AddFactPanel / EditFactPanel) embedded in
            MonographSectionsEditor below — those POST `wiki_fact` edits
            on their own and don't depend on these page-level buttons.
          */}
        </div>
      </div>

      {canSubmitPage && blockedByDrugCreate && (
        <div className="mb-4 p-3 bg-muted text-muted-foreground text-sm rounded-md">
          {t("wikiEditor.needDrugCreate")}
        </div>
      )}

      {!canSubmitPage && (
        <div className="mb-4 p-3 bg-muted text-muted-foreground text-sm rounded-md">
          {t("wiki.adminOnlyWholePage")}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-destructive/10 text-destructive text-sm rounded-md">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {/*
          Page-type selector — kept outside the search-stage gate so an
          author who flips topic → drug monograph by mistake can switch
          back without losing their draft to Cancel.
        */}
        {mode === "create" && (
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="pageType"
                value="topic"
                checked={selectedPageType === "topic"}
                onChange={() => setSelectedPageType("topic")}
              />
              {t("wiki.topicArticle")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="pageType"
                value="drug_monograph"
                checked={selectedPageType === "drug_monograph"}
                onChange={() => setSelectedPageType("drug_monograph")}
              />
              {t("wiki.drugMonograph")}
            </label>
          </div>
        )}
        {isMonographCreate && creationStage === "search" ? (
          <NewMonographSearchPanel
            initialQuery={initialSearchQuery}
            onPickExistingDrug={handlePickExistingDrug}
            onPickPubChem={handlePickPubChem}
            onSkipManual={handleSkipManual}
          />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("wiki.pageTitle")}
                className="w-full text-2xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/50"
              />
              {mode === "create" &&
                selectedPageType === "drug_monograph" &&
                selectedDrugCid && (
                  <button
                    type="button"
                    onClick={handleBackToSearch}
                    className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                  >
                    {t("wiki.changeDrug")}
                  </button>
                )}
            </div>

            {isMonographCreate && !selectedDrugCid && (
              <div className="space-y-4">
                <div>
                  <button
                    type="button"
                    onClick={handleBackToSearch}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("newMonograph.backToSearch", {
                      defaultValue: "← Back to search",
                    })}
                  </button>
                </div>

                <div className="border border-border rounded-md bg-muted/20 p-3 space-y-3">
                  <div>
                    <h3 className="text-sm font-medium">
                      {t("wikiEditor.createNewDrug")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t("wikiEditor.createNewDrugDescription")}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="flex flex-col gap-1 col-span-2">
                      <span className="text-muted-foreground">
                        {t("wikiEditor.drugNameNb", {
                          defaultValue: "Drug name (Norwegian)",
                        })}
                      </span>
                      <Input
                        value={newDrugNameNb}
                        onChange={(e) => setNewDrugNameNb(e.target.value)}
                        placeholder={
                          title || t("wikiEditor.drugNamePlaceholder")
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-1 col-span-2">
                      <span className="text-muted-foreground">
                        {t("wikiEditor.drugNameEn", {
                          defaultValue: "Drug name (English)",
                        })}
                      </span>
                      <Input
                        value={newDrugNameEn}
                        onChange={(e) => setNewDrugNameEn(e.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">
                        {t("wikiEditor.shortName")}
                      </span>
                      <Input
                        value={newDrugNameShort}
                        onChange={(e) => setNewDrugNameShort(e.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 col-span-2">
                      <span className="text-muted-foreground">
                        {t("wikiEditor.aliases", {
                          defaultValue:
                            "Aliases (literature variants, brand and street names; comma-separated)",
                        })}
                      </span>
                      <Input
                        value={newDrugAliases}
                        onChange={(e) => setNewDrugAliases(e.target.value)}
                        placeholder={t('wikiEditor.aliasesPlaceholder')}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">
                        {t("wikiEditor.pubchemCid")}
                      </span>
                      <Input
                        type="number"
                        value={newDrugPubchemCid}
                        onChange={(e) => setNewDrugPubchemCid(e.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">
                        {t("wikiEditor.molecularWeight")}
                      </span>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={newDrugMolecularWeight}
                        onChange={(e) => {
                          setNewDrugMolecularWeight(e.target.value);
                          // Any keystroke invalidates an earlier pick; the
                          // prompt re-appears if the new text is ambiguous too.
                          setNewDrugMwResolved(null);
                        }}
                      />
                      {molecularWeightParse &&
                        !molecularWeightParse.ok &&
                        molecularWeightParse.reason === "ambiguous" && (
                          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {t("wikiEditor.mwAmbiguousPrompt")}
                            {(
                              [
                                molecularWeightParse.asDecimal,
                                molecularWeightParse.asThousands,
                              ] as const
                            ).map((candidate) => (
                              <button
                                key={candidate}
                                type="button"
                                onClick={() =>
                                  setNewDrugMwResolved({
                                    text: newDrugMolecularWeight.trim(),
                                    value: candidate,
                                  })
                                }
                                className="rounded-md border border-input px-2 py-0.5 font-medium text-foreground hover:bg-accent"
                              >
                                {formatMwCandidate(candidate, lang)}
                              </button>
                            ))}
                          </span>
                        )}
                    </label>
                  </div>
                </div>
              </div>
            )}

            {canSubmitPage && (
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">
                  {t("wiki.editSummaryOptional")}
                </span>
                <textarea
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  maxLength={500}
                  rows={2}
                  placeholder={t("wiki.describChanges")}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            )}

            {/* Parent page picker (#301). Optional - leaving blank keeps the
            page at the top level. Server enforces max nesting depth and
            cycle prevention; we just have to forward the chosen id. */}
            <div className="space-y-1 text-sm">
              <label className="block text-muted-foreground">
                {t("wiki.parentPage")}
              </label>
              {parentId != null ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 rounded-md">
                  <span className="flex-1 truncate">
                    {parentTitle ?? `#${parentId}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setParentId(null);
                      setParentTitle(null);
                      setParentQuery("");
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("wiki.clearParent")}
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Input
                    value={parentQuery}
                    onChange={(e) => setParentQuery(e.target.value)}
                    placeholder={t("wiki.parentSearchPlaceholder")}
                  />
                  {parentQuery.trim() && (
                    <div className="absolute z-10 left-0 right-0 mt-1 max-h-60 overflow-auto bg-background border border-border rounded-md shadow-lg">
                      {parentSearching && parentResults.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          {t("wiki.searching")}
                        </div>
                      ) : parentResults.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          {t("wiki.noSearchResults", { query: parentQuery })}
                        </div>
                      ) : (
                        parentResults.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => {
                              setParentId(r.id);
                              setParentTitle(r.title);
                              setParentQuery("");
                              setParentResults([]);
                            }}
                            className="block w-full text-left px-3 py-2 text-sm hover:bg-muted"
                          >
                            <span>{r.title}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {r.pageType === "drug_monograph"
                                ? t("wiki.drugMonograph")
                                : t("wiki.topic")}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t("wiki.parentHint")}
              </p>
            </div>

            {/* Editor surface — drug monographs use the per-section editor; topic
            pages keep the legacy single TipTap surface with toolbar. Monograph
            *creation* renders no content editor at all: a new monograph is
            created as an empty shell, and its sections and PK parameters are
            authored afterwards through their own dedicated editors. */}
            {isMonographCreate ? null : isMonographMode ? (
              <div className="space-y-3">
                {/*
              #303 hard mode: the monograph section editors are only
              reached in edit flow (pageId always set) and are read-only;
              inserting a footnote into prose would silently orphan the
              citation row. Contributors attach citations to a new claim
              through the AddFactPanel's own ReferenceInput, so no
              standalone cite affordance is rendered here.
            */}
                <MonographSectionsEditor
                  key={draftEpoch}
                  ref={monographEditorRef}
                  initialContent={monographContent}
                  onContentChange={setMonographContent}
                  onActiveReferenceChange={setActiveReferenceId}
                  pageId={pageId ?? null}
                  drugId={selectedDrugCid ?? drugCid ?? null}
                />
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                {editor && (
                  <EditorToolbar
                    editor={editor}
                    onCite={() => setShowCitePanel(true)}
                  />
                )}
                <div className="relative">
                  <EditorContent editor={editor} />
                  {editor && (
                    <FootnotePrompt
                      editor={editor}
                      onAddCitation={() => setShowCitePanel(true)}
                    />
                  )}
                </div>
                {showCitePanel && (
                  <div className="border-t border-border px-4 py-3 bg-muted/20">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium">
                        {t("wiki.addCitation")}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowCitePanel(false)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                    <ReferenceInput
                      drugId={selectedDrugCid ?? drugCid}
                      onReferenceCreated={(ref: ReferenceRow) =>
                        handleCiteReferenceCreated(ref)
                      }
                    />
                  </div>
                )}
              </div>
            )}

            {/*
          References panel — only renders when the page is attached to a drug
          and at least one footnote is present. Highlights the entry matching
          the cursor's current footnote so authors can see what `[N]` refers
          to without leaving edit mode.
        */}
            {effectiveDrugCid != null && cited && cited.length > 0 && (
              <DrugReferencesList
                orderedRefs={cited}
                activeReferenceId={activeReferenceId}
                scrollable
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
