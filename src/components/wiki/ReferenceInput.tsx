import { useState } from 'react';
import { useCan } from '@/lib/usePermissions';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  resolveReference,
  createReference,
  ApiError,
  type ReferenceMetadata,
  type ReferenceRow,
} from '@/lib/referenceApi';

type RefType = 'freetext' | 'pmid' | 'doi';

const ALL_REF_TYPES: readonly RefType[] = ['freetext', 'pmid', 'doi'];

interface ReferenceInputProps {
  drugId?: number | null;
  required?: boolean;
  /**
   * Which identifier tabs to offer. Defaults to all three. Callers that need a
   * *retrievable* paper (the fact-extraction queue, which has to fetch and
   * read the full text) drop `freetext` — a free-text citation names no
   * resolvable source, so offering the tab there only invites a submission the
   * server will refuse.
   */
  allowedTypes?: readonly RefType[];
  onReferenceCreated: (ref: ReferenceRow) => void;
}

const referenceErrorKeys: Record<string, string> = {
  reference_identifier_unresolved: 'references.errorIdentifierUnresolved',
  reference_metadata_mismatch: 'references.errorMetadataMismatch',
  reference_resolver_unavailable: 'references.errorResolverUnavailable',
};

// Which coded failures a free-text save can route around. Free text skips the
// external resolver and the identifier/metadata checks entirely, so every error
// raised in that layer is one the fallback genuinely resolves. Auth and
// server-write failures are not here: a free-text save hits the same endpoint
// with the same session and the same database, so offering it there would only
// walk the user into an identical failure.
const FREETEXT_RECOVERABLE_CODES = new Set([
  'reference_identifier_unresolved',
  'reference_metadata_mismatch',
  'reference_resolver_unavailable',
]);

interface ReferenceError {
  message: string;
  /** Whether saving the same input as free text could succeed instead. */
  recoverable: boolean;
}

export function ReferenceInput({
  drugId,
  required,
  allowedTypes = ALL_REF_TYPES,
  onReferenceCreated,
}: ReferenceInputProps) {
  const { t } = useTranslation();
  const canCreateReference = useCan('reference.create');
  const [tab, setTab] = useState<RefType>(allowedTypes[0] ?? 'freetext');
  const [value, setValue] = useState('');
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<{
    metadata: ReferenceMetadata;
    type: RefType;
    identifier: string;
  } | null>(null);
  const [error, setError] = useState<ReferenceError | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleResolve() {
    if (!value.trim()) return;
    setError(null);
    setResolving(true);
    try {
      const result = await resolveReference(tab, value.trim());
      if (result.metadata) {
        setPreview({
          metadata: result.metadata,
          type: tab,
          identifier: value.trim(),
        });
      } else {
        setError({
          message: result.error ?? t('references.couldNotResolve'),
          recoverable: true,
        });
      }
    } catch (err) {
      setError(resolveErrorMessage(err, t));
    } finally {
      setResolving(false);
    }
  }

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createReference({
        drugId: drugId ?? null,
        type: 'freetext',
        identifier: value.trim(),
        metadata: null,
      });
      onReferenceCreated(result.reference);
      setValue('');
      setPreview(null);
    } catch (err) {
      setError(referenceErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveResolved() {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createReference({
        drugId: drugId ?? null,
        type: preview.type,
        identifier: preview.identifier,
        metadata: preview.metadata,
      });
      onReferenceCreated(result.reference);
      setValue('');
      setPreview(null);
    } catch (err) {
      setError(referenceErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  }

  function handleFallbackToFreetext() {
    setTab('freetext');
    setError(null);
    setPreview(null);
  }

  const tabs: { key: RefType; label: string }[] = [
    { key: 'freetext', label: t('references.tabText') },
    { key: 'pmid', label: t('references.tabPmid') },
    { key: 'doi', label: t('references.tabDoi') },
  ].filter((tabItem) => allowedTypes.includes(tabItem.key as RefType)) as {
    key: RefType;
    label: string;
  }[];

  const placeholder =
    tab === 'freetext'
      ? t('references.placeholderText')
      : tab === 'pmid'
        ? t('references.placeholderPmid')
        : t('references.placeholderDoi');

  // POST /api/references (and the resolver behind the PMID/DOI tabs) needs
  // `reference.create`; without it the whole add-a-source affordance would
  // just walk the user into a 403.
  if (!canCreateReference) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground mr-1">
          {required ? t('references.source') : t('references.sourceOptional')}
        </span>
        {tabs.map((tabItem) => (
          <button
            key={tabItem.key}
            type="button"
            onClick={() => {
              setTab(tabItem.key);
              setPreview(null);
              setError(null);
            }}
            className={`text-xs px-2 py-0.5 rounded ${
              tab === tabItem.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setPreview(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (tab === 'freetext') handleSave();
              else handleResolve();
            }
          }}
          placeholder={placeholder}
          className="text-sm"
        />
        {tab === 'freetext' ? (
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!value.trim() || saving}
          >
            {saving ? '...' : t('references.add')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={handleResolve}
            disabled={!value.trim() || resolving}
          >
            {resolving ? '...' : t('references.lookup')}
          </Button>
        )}
      </div>

      {preview && (
        <div className="border border-border rounded p-2 bg-muted/30 text-xs space-y-1.5">
          <div className="font-medium">{preview.metadata.title}</div>
          <div className="text-muted-foreground">
            {preview.metadata.authors.slice(0, 3).join(', ')}
            {preview.metadata.authors.length > 3 && ', et al.'}
            {preview.metadata.journal && ` — ${preview.metadata.journal}`}
            {preview.metadata.year && ` (${preview.metadata.year})`}
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleSaveResolved}
            disabled={saving}
          >
            {saving ? t('wiki.saving') : t('references.useThis')}
          </Button>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-600 flex items-center gap-2">
          <span>{error.message}</span>
          {error.recoverable &&
            tab !== 'freetext' &&
            allowedTypes.includes('freetext') && (
              <button
                type="button"
                onClick={handleFallbackToFreetext}
                className="text-primary underline"
              >
                {t('references.saveAsFreetext')}
              </button>
            )}
        </div>
      )}
    </div>
  );
}

function referenceErrorMessage(
  err: unknown,
  t: (key: string) => string,
): ReferenceError {
  if (err instanceof ApiError) {
    if (err.code) {
      const key = referenceErrorKeys[err.code];
      if (key) {
        return {
          message: t(key),
          recoverable: FREETEXT_RECOVERABLE_CODES.has(err.code),
        };
      }
    }
    // No stable code, so map on HTTP status. These outcomes previously all
    // collapsed into the opaque "saveFailed"; each needs a different action.
    if (err.status === 401) {
      return {
        message: t('references.errorSessionExpired'),
        recoverable: false,
      };
    }
    if (err.status === 403) {
      return { message: t('references.errorForbidden'), recoverable: false };
    }
    if (err.status === 429) {
      // A free-text save skips the resolver quota entirely, so it can succeed
      // where the PMID/DOI save was throttled.
      return { message: t('references.errorRateLimited'), recoverable: true };
    }
    if (err.status >= 500) {
      return { message: t('references.errorServer'), recoverable: false };
    }
  }
  return { message: t('references.saveFailed'), recoverable: false };
}

/**
 * A lookup that throws is a rejected response, not necessarily a dropped
 * connection: the resolver 400s an unparseable identifier, 429s a client that
 * is hammering it, and 5xx-es when the upstream provider is down. Naming those
 * by HTTP status keeps the picker from labelling every failure "network error"
 * (which sends the user retrying a request that will never succeed) while
 * reserving that label for a genuine transport/parse failure — an ApiError is
 * only thrown once a response has been received, so a raw throw is the network
 * case.
 *
 * The lookup path differs from {@link referenceErrorMessage}: a free-text save
 * skips the resolver, its quota, and the identifier/metadata checks, so a
 * malformed identifier, a throttled quota, an upstream outage, or a dropped
 * connection are all recoverable that way. Only session/permission failures are
 * not — a free-text save hits the same endpoint with the same session and would
 * fail identically.
 */
function resolveErrorMessage(
  err: unknown,
  t: (key: string) => string,
): ReferenceError {
  if (err instanceof ApiError) {
    if (err.code) {
      const key = referenceErrorKeys[err.code];
      if (key) {
        return {
          message: t(key),
          recoverable: FREETEXT_RECOVERABLE_CODES.has(err.code),
        };
      }
    }
    if (err.status === 401) {
      return {
        message: t('references.errorSessionExpired'),
        recoverable: false,
      };
    }
    if (err.status === 403) {
      return { message: t('references.errorForbidden'), recoverable: false };
    }
    if (err.status === 400) {
      return {
        message: t('references.errorIdentifierUnresolved'),
        recoverable: true,
      };
    }
    if (err.status === 429) {
      return { message: t('references.errorRateLimited'), recoverable: true };
    }
    if (err.status >= 500) {
      return {
        message: t('references.errorResolverUnavailable'),
        recoverable: true,
      };
    }
    return { message: t('references.couldNotResolve'), recoverable: true };
  }
  return { message: t('references.networkError'), recoverable: true };
}
