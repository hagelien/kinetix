/**
 * Admin section for managing automated contributor agents (#319).
 *
 * Covers the full lifecycle: list, create, edit display fields, change
 * the permission tier (contributor ↔ editor) and the model capability
 * tier, toggle hook enrolment, transition status, and manage API tokens.
 *
 * Tokens are persistent and revocable: the server stores only a SHA-256
 * hash, returns the plaintext `kxat_…` secret exactly once at issuance,
 * and resolves it on each request by hash (see `api/_lib/auth.ts`).
 * Issuing here is admin-only and audited; every token carries a hard
 * expiry and can be revoked individually — a per-token kill switch that
 * needs no global `JWT_SECRET` rotation. Agents never carry `admin`, and
 * a suspended agent's tokens are inert regardless of revocation since
 * auth reads the live (demoted) role from the DB.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createAgent,
  fetchAdminAgents,
  issueAgentToken,
  listAgentTokens,
  patchAgent,
  revokeAgentToken,
  setAgentRole,
  transitionAgent,
  type AgentAdminRow,
  type AgentTokenMeta,
} from '@/lib/agentsApi';
import { type AgentStatus, allowedTransitions } from '@/lib/agentStatus';
import { MODEL_TIERS, type AssignableModelTier } from '@/lib/modelTiers';

export function AgentsAdminSection(): JSX.Element {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentAdminRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminAgents();
      setAgents(data.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">
          {t('admin.agents.heading', { defaultValue: 'Agents' })}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCreating((v) => !v)}
        >
          {creating
            ? t('admin.agents.cancel', { defaultValue: 'Cancel' })
            : t('admin.agents.newAgent', { defaultValue: 'New agent' })}
        </Button>
      </div>

      {creating && (
        <CreateAgentForm
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.agents.loading', { defaultValue: 'Loading agents…' })}
        </p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : agents && agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.agents.empty', { defaultValue: 'No agents yet.' })}
        </p>
      ) : (
        <ul className="space-y-3">
          {agents?.map((agent) => (
            <AgentEditRow
              key={agent.id}
              agent={agent}
              onChanged={() => void load()}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateAgentForm({
  onCreated,
}: {
  onCreated: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    email: '',
    username: '',
    name: '',
    nameEn: '',
    slug: '',
    description: '',
    descriptionEn: '',
    maintainerUserId: '',
    role: 'contributor' as 'contributor' | 'editor',
    modelTier: '' as TierChoice,
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Same gate as the edit row: an accidental pick here would otherwise mint a
    // live identity that can clear the high-risk gate on its first verdict.
    if (form.modelTier === 'flagship' && !confirmFlagship(t)) return;
    setSubmitting(true);
    setErr(null);
    try {
      const maintainerUserId = form.maintainerUserId
        ? Number(form.maintainerUserId)
        : undefined;
      if (form.maintainerUserId && Number.isNaN(maintainerUserId)) {
        throw new Error(
          t('admin.agents.errorMaintainerIdNotNumber', {
            defaultValue: 'Maintainer user id must be a number.',
          }) as string,
        );
      }
      await createAgent({
        email: form.email.trim(),
        username: form.username.trim(),
        name: form.name.trim(),
        nameEn: form.nameEn.trim() || undefined,
        slug: form.slug.trim() || undefined,
        description: form.description.trim() || undefined,
        descriptionEn: form.descriptionEn.trim() || undefined,
        maintainerUserId,
        role: form.role,
        // Omit rather than send null: create takes an optional tier and an
        // absent one is exactly "unclassified". The create form only ever
        // offers assignable tiers, so the guard is a type narrowing.
        modelTier: isAssignableTier(form.modelTier)
          ? form.modelTier
          : undefined,
      });
      onCreated();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 space-y-3 rounded-md border border-border bg-card p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t('admin.agents.email', { defaultValue: 'Email' })}
          </span>
          <Input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t('admin.agents.username', { defaultValue: 'Username' })}
          </span>
          <Input
            required
            pattern="[a-zA-Z0-9_-]+"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t('admin.agents.name', { defaultValue: 'Name (Norwegian)' })}
          </span>
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t('admin.agents.nameEn', { defaultValue: 'Name (English)' })}
          </span>
          <Input
            value={form.nameEn}
            onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t('admin.agents.slug', {
              defaultValue: 'Slug (auto from name)',
            })}
          </span>
          <Input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            placeholder={t('admin.agents.slugPlaceholder', {
              defaultValue: 'kebab-case',
            })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t('admin.agents.maintainerUserId', {
              defaultValue: 'Maintainer user id',
            })}
          </span>
          <Input
            type="number"
            value={form.maintainerUserId}
            onChange={(e) =>
              setForm({ ...form, maintainerUserId: e.target.value })
            }
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t('admin.agents.initialRole', { defaultValue: 'Initial role' })}
          </span>
          <select
            value={form.role}
            onChange={(e) =>
              setForm({
                ...form,
                role: e.target.value as 'contributor' | 'editor',
              })
            }
            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="contributor">{t('admin.contributor')}</option>
            <option value="editor">{t('admin.editor')}</option>
          </select>
        </label>
        <ModelTierSelect
          value={form.modelTier}
          onChange={(modelTier) => setForm({ ...form, modelTier })}
        />
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-muted-foreground">
          {t('admin.agents.description', { defaultValue: 'Description' })}
        </span>
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          rows={2}
          className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-muted-foreground">
          {t('admin.agents.descriptionEn', {
            defaultValue: 'Description (English)',
          })}
        </span>
        <textarea
          value={form.descriptionEn}
          onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })}
          rows={2}
          className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </label>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting
            ? t('admin.agents.creating', { defaultValue: 'Creating…' })
            : t('admin.agents.create', { defaultValue: 'Create agent' })}
        </Button>
      </div>
    </form>
  );
}

/**
 * A dropdown value: an assignable tier, `''` for unclassified (which maps to
 * `null` on the wire), or — on an existing agent — a tier string the database
 * holds that this build's registry no longer offers. That last case gets its
 * own option rather than being folded into `''`, so the form always shows what
 * is actually stored and any move away from it is the admin's own choice.
 */
type TierChoice = string;

type Translate = ReturnType<typeof useTranslation>['t'];

/** True when a stored tier is one this build knows how to offer. */
function isAssignableTier(tier: string | null): tier is AssignableModelTier {
  return (MODEL_TIERS as readonly string[]).includes(tier ?? '');
}

/**
 * Flagship is the one tier whose verification can auto-publish a high-risk
 * edit, so every path that can assign it asks first — create and edit alike.
 * Returns false when the admin backs out.
 */
function confirmFlagship(t: Translate): boolean {
  return window.confirm(
    t('admin.agents.confirmFlagship', {
      defaultValue:
        'Mark this agent as flagship? A high-risk edit auto-publishes on two independent approvals of which at least one is flagship, and this identity would be able to supply that flagship approval. Only do this if it really runs a flagship model.',
    }) as string,
  );
}

/**
 * The translated name of each assignable tier. One map for the dropdown and the
 * row badge alike, so a tier cannot read "Mellom" in the form and "MID" on the
 * row it belongs to. The explanation of what flagship unlocks lives in the help
 * text below the dropdown, which leaves these short enough for a badge.
 */
function tierLabels(t: Translate): Record<AssignableModelTier, string> {
  return {
    flagship: t('admin.agents.tierFlagship', {
      defaultValue: 'Flagship',
    }) as string,
    mid: t('admin.agents.tierMid', { defaultValue: 'Mid' }) as string,
    light: t('admin.agents.tierLight', { defaultValue: 'Light' }) as string,
  };
}

/**
 * Capability-tier dropdown. Shared by the create form and the edit row so the
 * wording of the flagship warning is written once — a cheap model marked
 * flagship is the exact hole the consensus gate exists to close.
 */
function ModelTierSelect({
  value,
  onChange,
  disabled,
  unrecognised,
}: {
  value: TierChoice;
  onChange: (next: TierChoice) => void;
  disabled?: boolean;
  /** A stored tier outside {@link MODEL_TIERS}, offered so it stays selectable. */
  unrecognised?: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  const tierLabel = tierLabels(t);
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-muted-foreground">
        {t('admin.agents.modelTier', { defaultValue: 'Model tier' })}
      </span>
      <select
        // The visible label sits in the same <label> as the help text below,
        // so name the control explicitly rather than inherit both.
        aria-label={
          t('admin.agents.modelTier', { defaultValue: 'Model tier' }) as string
        }
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as TierChoice)}
        className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm disabled:opacity-50"
      >
        <option value="">
          {t('admin.agents.tierUnclassified', {
            defaultValue: 'Unclassified',
          })}
        </option>
        {MODEL_TIERS.map((tier) => (
          <option key={tier} value={tier}>
            {tierLabel[tier]}
          </option>
        ))}
        {/* Shown only when the database holds a tier this build cannot offer.
            Without it the control would display "Unclassified" for a value
            that is not null, and choosing Unclassified would look like a
            no-op instead of the clear it is. */}
        {unrecognised && (
          <option value={unrecognised}>
            {unrecognised} (
            {t('admin.agents.tierUnrecognised', {
              defaultValue: 'unrecognised',
            })}
            )
          </option>
        )}
      </select>
      <span className="mt-1 block text-xs text-muted-foreground">
        {value === 'flagship'
          ? t('admin.agents.tierFlagshipHelp', {
              defaultValue:
                'A high-risk edit needs two independent approvals, at least one of them from a flagship verifier. Flagship is what lets this identity be that one — set it only for an identity actually backed by a flagship model.',
            })
          : t('admin.agents.tierHelp', {
              defaultValue:
                'Capability of the model behind this identity. Only a flagship verifier can supply the flagship approval a high-risk edit requires; no other tier — unclassified included — counts for it.',
            })}
      </span>
    </label>
  );
}

/** Row badge for the stored tier, so the setting is visible without opening the form. */
function ModelTierBadge({ tier }: { tier: string | null }): JSX.Element {
  const { t } = useTranslation();
  const flagship = tier === 'flagship';
  // The raw value is a last resort for a tier this build does not know; every
  // tier it does know reads the same here as in the dropdown, in either language.
  const label = isAssignableTier(tier)
    ? tierLabels(t)[tier]
    : (tier ??
      (t('admin.agents.tierBadgeUnclassified', {
        defaultValue: 'Unclassified',
      }) as string));
  return (
    <span
      title={
        t('admin.agents.modelTier', { defaultValue: 'Model tier' }) as string
      }
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
        flagship
          ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400'
          : 'border-border bg-muted text-muted-foreground'
      }`}
    >
      {label}
    </span>
  );
}

/**
 * The role the edit form should show. While suspended the live role is
 * `authenticated` and the intended one lives in preSuspensionRole; anything
 * else falls back to contributor so the dropdown always holds a valid value.
 */
function effectiveAgentRole(agent: AgentAdminRow): 'contributor' | 'editor' {
  return (
    agent.status === 'suspended' ? agent.preSuspensionRole : agent.userRole
  ) === 'editor'
    ? 'editor'
    : 'contributor';
}

/**
 * The edit form's draft, built from the row as stored.
 *
 * Rebuilt every time the form opens or closes, so a cancelled edit is discarded
 * rather than left in state. A draft that outlives Cancel reappears on the next
 * open, and since the save sends only what differs from the stored value, a
 * cancelled tier change would then ride out on an unrelated save — a demotion
 * from flagship that nobody confirmed, silently costing that identity its place
 * in the high-risk quorum.
 */
function agentDraft(agent: AgentAdminRow) {
  return {
    name: agent.name,
    nameEn: agent.nameEn ?? '',
    slug: agent.slug,
    description: agent.description ?? '',
    descriptionEn: agent.descriptionEn ?? '',
    maintainerUserId: agent.maintainerUserId?.toString() ?? '',
    role: effectiveAgentRole(agent),
    hooksEnabled: agent.hooksEnabled,
    selfReviewEnabled: agent.selfReviewEnabled,
    modelTier: (agent.modelTier ?? '') as TierChoice,
    adjudicator: agent.adjudicator,
    modelFamily: agent.modelFamily ?? '',
  };
}

function AgentEditRow({
  agent,
  onChanged,
}: {
  agent: AgentAdminRow;
  onChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const effectiveRole = effectiveAgentRole(agent);
  // The raw stored value, including a tier this build's registry no longer
  // offers: the dropdown shows that value as its own option, so "changed"
  // means changed against what the database actually holds. Saving an
  // untouched form therefore never rewrites the tier, and picking
  // Unclassified over an unrecognised value really does clear it.
  const storedTier: TierChoice = agent.modelTier ?? '';
  const unrecognisedTier = isAssignableTier(agent.modelTier)
    ? null
    : agent.modelTier;
  const [form, setForm] = useState(() => agentDraft(agent));

  /** Open the form on the stored values, dropping any cancelled draft. */
  function openEditor() {
    setForm(agentDraft(agent));
    setErr(null);
    setEditing(true);
  }

  /** Close it the same way, so nothing survives to be sent by a later save. */
  function closeEditor() {
    setForm(agentDraft(agent));
    setEditing(false);
  }

  async function handleSave() {
    const tierChanged = form.modelTier !== storedTier;
    // Promotion to flagship is the one change that widens what this identity
    // can wave through on its own, so it gets the same deliberate confirm as
    // the terminal deactivate.
    if (tierChanged && form.modelTier === 'flagship' && !confirmFlagship(t)) {
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const maintainerUserId = form.maintainerUserId
        ? Number(form.maintainerUserId)
        : null;
      if (form.maintainerUserId && Number.isNaN(maintainerUserId)) {
        throw new Error(
          t('admin.agents.errorMaintainerIdNotNumber', {
            defaultValue: 'Maintainer user id must be a number.',
          }) as string,
        );
      }
      const applyFields = () =>
        patchAgent(agent.id, {
          name: form.name.trim(),
          nameEn: form.nameEn.trim() || null,
          slug: form.slug.trim(),
          description: form.description.trim() || null,
          descriptionEn: form.descriptionEn.trim() || null,
          maintainerUserId,
          hooksEnabled: form.hooksEnabled,
          selfReviewEnabled: form.selfReviewEnabled,
          adjudicator: form.adjudicator,
          ...(form.modelFamily.trim() !== (agent.modelFamily ?? '')
            ? { modelFamily: form.modelFamily.trim() || null }
            : {}),
          // Only when changed against the stored value. A changed value is
          // either '' (clear) or one of the offered tiers; the unrecognised
          // option equals the stored value, so selecting it is not a change.
          ...(tierChanged && (form.modelTier === '' || isAssignableTier(form.modelTier))
            ? { modelTier: form.modelTier === '' ? null : form.modelTier }
            : {}),
        });
      // Role lives on the backing user and is lifecycle-aware, so it
      // goes through a dedicated endpoint — only call it when changed.
      const roleChanged = form.role !== effectiveRole;
      const applyRole = () => setAgentRole(agent.id, form.role);

      // Two requests, so a failure between them leaves a partial save. Order
      // them so the surviving half is never the more permissive one: the
      // combination that matters is editor + self-review (moderating its own
      // edits, rather than only verifying them), so a demotion goes first and
      // everything else after. Demoting to contributor first means a failed
      // second call leaves a contributor — with or without the flag, it can
      // only verify — instead of an editor that just gained self-approval.
      const demoting = roleChanged && form.role === 'contributor';
      if (demoting) {
        await applyRole();
        await applyFields();
      } else {
        await applyFields();
        if (roleChanged) await applyRole();
      }
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      // A partial save leaves the row out of sync with this form. Refetch so
      // the admin is looking at what the server actually holds before they
      // retry — otherwise the failed half is invisible and the next save is
      // made against stale state.
      onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTransition(to: AgentStatus) {
    // `deactivated` is terminal — gate behind a confirm so an
    // accidental click doesn't lock the agent out permanently.
    if (to === 'deactivated') {
      if (
        !window.confirm(
          t('admin.agents.confirmDeactivate', {
            defaultValue:
              'Deactivate this agent? This is terminal — the row stays for audit but cannot be reactivated.',
          }) as string,
        )
      ) {
        return;
      }
    }
    const reason = window.prompt(
      t('admin.agents.reasonPrompt', {
        defaultValue: 'Reason (optional):',
      }) as string,
    );
    if (reason === null) {
      // User dismissed the prompt — treat as cancelling the whole
      // transition for every status, not just the destructive one.
      // The empty-string case (clicked OK without typing) still falls
      // through and sends the transition with no reason.
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await transitionAgent(agent.id, {
        status: to,
        reason: reason?.trim() || undefined,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const [showHistory, setShowHistory] = useState(false);
  const status: AgentStatus = agent.status;
  const transitions = allowedTransitions(status);
  const statusLabel: Record<AgentStatus, string> = {
    active: t('admin.agents.statusActive', {
      defaultValue: 'Active',
    }) as string,
    suspended: t('admin.agents.statusSuspended', {
      defaultValue: 'Suspended',
    }) as string,
    deactivated: t('admin.agents.statusDeactivated', {
      defaultValue: 'Deactivated',
    }) as string,
  };
  const statusBadgeClass: Record<AgentStatus, string> = {
    active:
      'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    suspended:
      'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    deactivated: 'border-destructive/40 bg-destructive/10 text-destructive',
  };

  return (
    <li className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{agent.name}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${statusBadgeClass[status]}`}
            >
              {statusLabel[status]}
            </span>
            <span className="text-xs text-muted-foreground font-mono">
              @{agent.username ?? '?'}
            </span>
            {/* Self-review is a deviation from the standing peer-review rule,
                so it is legible without opening the edit form. */}
            {agent.selfReviewEnabled && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">
                {t('admin.agents.selfReviewBadge', {
                  defaultValue: 'Self-review',
                })}
              </span>
            )}
            {agent.adjudicator && (
              <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-400">
                {t('admin.agents.adjudicatorBadge', {
                  defaultValue: 'T3 adjudicator',
                })}
              </span>
            )}
            {/* Always rendered, unclassified included: the gate turns on this
                value, so "nobody set it" has to be as visible as any tier. */}
            <ModelTierBadge tier={agent.modelTier} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t('admin.agents.userId', { defaultValue: 'User id' })}:{' '}
            <span className="font-mono">{agent.userId}</span>
            {' · '}
            {t('admin.agents.userRole', { defaultValue: 'Role' })}:{' '}
            <span className="font-mono">{agent.userRole}</span>
            {' · '}
            {t('admin.agents.maintainerUserId', {
              defaultValue: 'Maintainer',
            })}
            : <span className="font-mono">{agent.maintainerUserId ?? '—'}</span>
          </div>
          {agent.statusChangedAt && (
            <div className="mt-1 text-xs text-muted-foreground">
              {t('admin.agents.lastChanged', {
                defaultValue: 'Last changed',
              })}
              :{' '}
              <time dateTime={agent.statusChangedAt}>
                {new Date(agent.statusChangedAt).toLocaleString()}
              </time>
              {agent.statusChangeReason && (
                <>
                  {' — '}
                  <span className="italic">{agent.statusChangeReason}</span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => (editing ? closeEditor() : openEditor())}
          >
            {editing
              ? t('admin.agents.cancel', { defaultValue: 'Cancel' })
              : t('admin.agents.edit', { defaultValue: 'Edit' })}
          </Button>
          {transitions.map((to) => (
            <Button
              key={to}
              variant="outline"
              size="sm"
              onClick={() => void handleTransition(to)}
              disabled={submitting}
            >
              {to === 'active'
                ? t('admin.agents.activate', { defaultValue: 'Activate' })
                : to === 'suspended'
                  ? t('admin.agents.suspend', { defaultValue: 'Suspend' })
                  : t('admin.agents.deactivate', {
                      defaultValue: 'Deactivate',
                    })}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTokens((v) => !v)}
          >
            {showTokens
              ? t('admin.agents.hideTokens', { defaultValue: 'Hide tokens' })
              : t('admin.agents.tokens', { defaultValue: 'Tokens' })}
          </Button>
          {agent.history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory
                ? t('admin.agents.hideHistory', {
                    defaultValue: 'Hide history',
                  })
                : t('admin.agents.showHistory', {
                    defaultValue: 'History',
                  })}
            </Button>
          )}
        </div>
      </div>

      {showHistory && agent.history.length > 0 && (
        <ol className="mt-3 space-y-1 text-xs text-muted-foreground">
          {agent.history.map((h) => {
            // Reuse the same status labels rendered in the badge above
            // so the timeline doesn't leak raw enum values into nb UI.
            const from = h.fromStatus
              ? statusLabel[h.fromStatus as AgentStatus]
              : null;
            const to = statusLabel[h.toStatus as AgentStatus];
            return (
              <li key={h.id} className="flex gap-2">
                <time dateTime={h.changedAt} className="font-mono">
                  {new Date(h.changedAt).toLocaleString()}
                </time>
                <span>{from ? `${from} → ${to}` : `→ ${to}`}</span>
                {h.reason && <span className="italic">— {h.reason}</span>}
                {h.changedBy != null && (
                  <span className="font-mono">
                    (
                    {t('admin.agents.historyActor', {
                      defaultValue: 'user {{id}}',
                      id: h.changedBy,
                    })}
                    )
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editing && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('admin.agents.name', {
                defaultValue: 'Name',
              })}
            />
            <Input
              value={form.nameEn}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
              placeholder={t('admin.agents.nameEn', {
                defaultValue: 'Name (English)',
              })}
            />
            <Input
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              placeholder={t('admin.agents.slugPlaceholder', {
                defaultValue: 'slug',
              })}
            />
            <Input
              type="number"
              value={form.maintainerUserId}
              onChange={(e) =>
                setForm({ ...form, maintainerUserId: e.target.value })
              }
              placeholder={t('admin.agents.maintainerUserId', {
                defaultValue: 'Maintainer user id',
              })}
            />
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t('admin.agents.role', { defaultValue: 'Role' })}
              </span>
              <select
                value={form.role}
                disabled={status === 'deactivated'}
                onChange={(e) =>
                  setForm({
                    ...form,
                    role: e.target.value as 'contributor' | 'editor',
                  })
                }
                className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm disabled:opacity-50"
              >
                <option value="contributor">{t('admin.contributor')}</option>
                <option value="editor">{t('admin.editor')}</option>
              </select>
            </label>
            <ModelTierSelect
              value={form.modelTier}
              onChange={(modelTier) => setForm({ ...form, modelTier })}
              disabled={status === 'deactivated'}
              unrecognised={unrecognisedTier}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.hooksEnabled}
                onChange={(e) =>
                  setForm({ ...form, hooksEnabled: e.target.checked })
                }
                className="h-4 w-4 rounded border-input"
              />
              <span>
                {t('admin.agents.hooksEnabled', {
                  defaultValue: 'Enable hook routine',
                })}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.selfReviewEnabled}
                onChange={(e) =>
                  setForm({ ...form, selfReviewEnabled: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-input"
              />
              <span>
                {t('admin.agents.selfReviewEnabled', {
                  defaultValue: 'Allow reviewing its own work',
                })}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t('admin.agents.selfReviewHelp', {
                    defaultValue:
                      'The agent sees its own submissions in the review queue and may verify them. Off by default, so its work waits for a second reader. It still cannot review a person’s edits.',
                  })}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.adjudicator}
                onChange={(e) =>
                  setForm({ ...form, adjudicator: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-input"
              />
              <span>
                {t('admin.agents.adjudicator', {
                  defaultValue: 'T3 adjudicator',
                })}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t('admin.agents.adjudicatorHelp', {
                    defaultValue:
                      'May sit on the two-agent panel that settles a disagreement surviving the expert review. Needs the Flagship tier too. It never closes a dispute a person raised.',
                  })}
                </span>
              </span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block">
                {t('admin.agents.modelFamily', { defaultValue: 'Model family' })}
              </span>
              <input
                type="text"
                value={form.modelFamily}
                onChange={(e) =>
                  setForm({ ...form, modelFamily: e.target.value })
                }
                placeholder={
                  t('admin.agents.modelFamilyPlaceholder', {
                    defaultValue: 'e.g. claude',
                  }) as string
                }
                className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              />
            </label>
          </div>
          {status === 'suspended' && (
            <p className="text-xs text-muted-foreground">
              {t('admin.agents.roleWhileSuspended', {
                defaultValue:
                  'Agent is suspended — the role change applies when it is reactivated.',
              })}
            </p>
          )}
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={2}
            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            placeholder={t('admin.agents.description', {
              defaultValue: 'Description',
            })}
          />
          <textarea
            value={form.descriptionEn}
            onChange={(e) =>
              setForm({ ...form, descriptionEn: e.target.value })
            }
            rows={2}
            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            placeholder={t('admin.agents.descriptionEn', {
              defaultValue: 'Description (English)',
            })}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={closeEditor}
            >
              {t('admin.agents.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting
                ? t('admin.agents.saving', { defaultValue: 'Saving…' })
                : t('admin.agents.save', { defaultValue: 'Save' })}
            </Button>
          </div>
        </div>
      )}

      {showTokens && <AgentTokensPanel agentId={agent.id} status={status} />}
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
    </li>
  );
}

function AgentTokensPanel({
  agentId,
  status,
}: {
  agentId: number;
  status: AgentStatus;
}): JSX.Element {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<AgentTokenMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [issuing, setIssuing] = useState(false);
  // The plaintext secret, shown exactly once right after issuance.
  const [freshSecret, setFreshSecret] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listAgentTokens(agentId);
      setTokens(data.tokens);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function handleIssue(e: FormEvent) {
    e.preventDefault();
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days <= 0) {
      setErr(
        t('admin.agents.tokenExpiryInvalid', {
          defaultValue: 'Expiry must be a positive number of days.',
        }) as string,
      );
      return;
    }
    setIssuing(true);
    setErr(null);
    try {
      const { token } = await issueAgentToken(agentId, {
        label: label.trim() || undefined,
        expiresInDays: days,
      });
      setFreshSecret(token);
      setLabel('');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setIssuing(false);
    }
  }

  async function handleRevoke(tokenId: number) {
    if (
      !window.confirm(
        t('admin.agents.confirmRevoke', {
          defaultValue:
            'Revoke this token? Any client using it will stop authenticating immediately.',
        }) as string,
      )
    ) {
      return;
    }
    setErr(null);
    try {
      await revokeAgentToken(agentId, tokenId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function tokenState(tk: AgentTokenMeta): string {
    if (tk.revokedAt)
      return t('admin.agents.tokenRevoked', { defaultValue: 'Revoked' });
    if (tk.expiresAt && new Date(tk.expiresAt).getTime() <= Date.now())
      return t('admin.agents.tokenExpired', { defaultValue: 'Expired' });
    return t('admin.agents.tokenActive', { defaultValue: 'Active' });
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <h4 className="mb-2 text-sm font-semibold">
        {t('admin.agents.apiTokens', { defaultValue: 'API tokens' })}
      </h4>

      {freshSecret && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <p className="mb-1 font-medium text-amber-700 dark:text-amber-400">
            {t('admin.agents.tokenOnceWarning', {
              defaultValue:
                'Copy this token now — it is shown only once and cannot be retrieved again.',
            })}
          </p>
          <code className="block break-all rounded bg-background px-2 py-1 font-mono">
            {freshSecret}
          </code>
          <div className="mt-1 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(freshSecret);
              }}
            >
              {t('admin.agents.copy', { defaultValue: 'Copy' })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFreshSecret(null)}
            >
              {t('admin.agents.dismiss', { defaultValue: 'Dismiss' })}
            </Button>
          </div>
        </div>
      )}

      {status !== 'deactivated' && (
        <form
          onSubmit={handleIssue}
          className="mb-3 flex flex-wrap items-end gap-2"
        >
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t('admin.agents.tokenLabel', { defaultValue: 'Label' })}
            </span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('admin.agents.tokenLabelPlaceholder', {
                defaultValue: 'e.g. ci-runner',
              })}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t('admin.agents.tokenExpiryDays', {
                defaultValue: 'Expires in (days)',
              })}
            </span>
            <Input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              className="w-28"
            />
          </label>
          <Button type="submit" size="sm" disabled={issuing}>
            {issuing
              ? t('admin.agents.issuing', { defaultValue: 'Issuing…' })
              : t('admin.agents.issueToken', { defaultValue: 'Issue token' })}
          </Button>
        </form>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">
          {t('admin.agents.tokensLoading', { defaultValue: 'Loading tokens…' })}
        </p>
      ) : tokens && tokens.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('admin.agents.noTokens', { defaultValue: 'No tokens yet.' })}
        </p>
      ) : (
        <ul className="space-y-1 text-xs">
          {tokens?.map((tk) => (
            <li
              key={tk.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border bg-background px-2 py-1"
            >
              <code className="font-mono">{tk.prefix}</code>
              {tk.label && (
                <span className="text-muted-foreground">{tk.label}</span>
              )}
              <span className="text-muted-foreground">{tokenState(tk)}</span>
              {tk.expiresAt && (
                <span className="text-muted-foreground">
                  {t('admin.agents.tokenExpiresAt', {
                    defaultValue: 'expires',
                  })}{' '}
                  <time dateTime={tk.expiresAt}>
                    {new Date(tk.expiresAt).toLocaleDateString()}
                  </time>
                </span>
              )}
              {tk.lastUsedAt && (
                <span className="text-muted-foreground">
                  {t('admin.agents.tokenLastUsed', {
                    defaultValue: 'last used',
                  })}{' '}
                  <time dateTime={tk.lastUsedAt}>
                    {new Date(tk.lastUsedAt).toLocaleDateString()}
                  </time>
                </span>
              )}
              <span className="ml-auto">
                {!tk.revokedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRevoke(tk.id)}
                  >
                    {t('admin.agents.revoke', { defaultValue: 'Revoke' })}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
    </div>
  );
}
