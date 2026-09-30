import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { useCan, usePermissionOverrides } from '@/lib/usePermissions';
import {
  deleteMethod,
  fetchMethodDetail,
  type MethodDetail,
} from '@/lib/drugApi';
import {
  formatGenericDrugName,
  resolveDrugName,
  type LangCode,
} from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  methodTypeBadgeVariant,
  methodTypeLabelKey,
} from '@/lib/methodMeta';
import { MatrixBadges } from '@/components/methods/MatrixBadges';
import { MethodEditorModal } from '@/components/methods/MethodEditorModal';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';

/**
 * Render a reporting figure (Påvisn./MKK/Terskel). When the value is present the
 * number is wrapped in {@link UnitTooltip} so hovering surfaces the same
 * concentration in the user's other enabled units (nmol/L, mg/L, …). The
 * method's unit lives in its own column, so the tooltip trigger is the bare
 * number — `UnitTooltip` underlines the whole value in that case.
 */
function FigureCell({
  value,
  unit,
  molecularWeight,
}: {
  value: number | null;
  unit: string | null;
  molecularWeight: number | null;
}) {
  if (value == null) return <>–</>;
  return (
    <UnitTooltip value={value} unit={unit} molecularWeight={molecularWeight}>
      {String(value)}
    </UnitTooltip>
  );
}

/**
 * The label a component row shows — the same string the table cell renders, so
 * sorting on it orders what the reader actually sees rather than the slug or
 * the stored insertion order.
 */
function componentLabel(
  c: MethodDetail['components'][number],
  lang: LangCode,
): string {
  return formatGenericDrugName(resolveDrugName(c.names, lang)) || c.slug;
}

export function MethodDetailPage() {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  const user = useAuthStore((s) => s.user);
  const permissionOverrides = usePermissionOverrides();
  const canView = canAccessAnalyticalMethods(
    user,
    permissionOverrides,
  );
  const canEdit = useCan('methods.write');

  const [method, setMethod] = useState<MethodDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!canView || !Number.isInteger(id)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchMethodDetail(id)
      .then(({ method: m }) => {
        setMethod(m);
        setErrorMsg(null);
      })
      .catch(() => setErrorMsg(t('methods.loadError')))
      .finally(() => setLoading(false));
  }, [canView, id, t]);

  useEffect(() => {
    load();
  }, [load]);

  // The API returns components in the method's stored order (`sortOrder`, then
  // drug id) — i.e. whatever order they happened to be entered in. A method's
  // analyte list is read by looking a substance up, so present it sorted by the
  // localized display name. `numeric` keeps numbered metabolites in count order
  // (7-aminoklonazepam before 10-OH-karbazepin) instead of the codepoint order
  // that files "10" ahead of "7", and the locale-aware collator sorts æ/ø/å
  // after z in Norwegian.
  const components = useMemo(() => {
    const rows = method?.components ?? [];
    const collator = new Intl.Collator(i18n.language || undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return [...rows].sort((a, b) =>
      collator.compare(componentLabel(a, lang), componentLabel(b, lang)),
    );
  }, [method?.components, i18n.language, lang]);

  async function handleDelete() {
    if (!method) return;
    if (!window.confirm(t('methods.deleteConfirm', { code: method.code })))
      return;
    setDeleting(true);
    try {
      await deleteMethod(method.id);
      navigate('/methods');
    } catch {
      setErrorMsg(t('methods.saveError'));
      setDeleting(false);
    }
  }

  if (!canView) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-muted-foreground">
        {t('methods.forbidden')}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Link
        to="/methods"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('methods.back')}
      </Link>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : errorMsg && !method ? (
        <p className="text-sm text-destructive">{errorMsg}</p>
      ) : !method ? (
        <p className="text-sm text-muted-foreground">{t('methods.empty')}</p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-semibold text-primary">
                  {method.code}
                </span>
                <Badge variant={methodTypeBadgeVariant(method.methodType)}>
                  {t(methodTypeLabelKey(method.methodType))}
                </Badge>
              </div>
              <h1 className="mt-1 text-xl font-bold leading-tight">
                {method.name}
              </h1>
              {method.description && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {method.description}
                </p>
              )}
            </div>
            {canEdit && (
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="mr-1 h-3.5 w-3.5" />
                  {t('methods.edit')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  {t('methods.delete')}
                </Button>
              </div>
            )}
          </div>

          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('methods.matrices')}
              </dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                <MatrixBadges matrices={method.matrices} />
              </dd>
            </div>
            {method.volumeMl != null && (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {t('methods.volume')}
                </dt>
                <dd className="mt-1">
                  {t('methods.volumeMl', { value: method.volumeMl })}
                </dd>
              </div>
            )}
          </dl>

          <h2 className="mb-2 mt-6 text-sm font-semibold">
            {t('methods.componentCount', { count: components.length })}
          </h2>
          {components.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('methods.noComponents')}
            </p>
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground shadow-sm">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('methods.component')}
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title={t('methods.lorFull')}
                    >
                      {t('methods.lor')}
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title={t('methods.mkkFull')}
                    >
                      {t('methods.mkk')}
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title={t('methods.lodFull')}
                    >
                      {t('methods.lod')}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('methods.unit')}
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title={t('methods.uncertaintyFull')}
                    >
                      {t('methods.uncertainty')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {components.map((c) => (
                    <tr key={c.drugId} className="border-t">
                      <td className="px-3 py-1.5 font-medium">
                        <Link
                          to={`/wiki/drug/${c.drugId}`}
                          className="hover:text-primary hover:underline"
                        >
                          {componentLabel(c, lang)}
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        <FigureCell
                          value={c.lor}
                          unit={c.unit}
                          molecularWeight={c.molecularWeight}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        <FigureCell
                          value={c.mkk}
                          unit={c.unit}
                          molecularWeight={c.molecularWeight}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        <FigureCell
                          value={c.lod}
                          unit={c.unit}
                          molecularWeight={c.molecularWeight}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {c.unit ?? '–'}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {c.measurementUncertainty != null
                          ? `${c.measurementUncertainty}%`
                          : '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && method && (
        <MethodEditorModal
          methodId={method.id}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      )}
    </div>
  );
}
