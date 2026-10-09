import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuthGuard } from '@/components/AuthGuard';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PriorityFlagsAdminSection } from '@/components/admin/PriorityFlagsAdminSection';
import { ResearchImportAdminSection } from '@/components/admin/ResearchImportAdminSection';
import { ConversationIngestionAdminSection } from '@/components/admin/ConversationIngestionAdminSection';
import { WikiArticleImportSection } from '@/components/admin/WikiArticleImportSection';
import { AgentFocusSection } from '@/components/admin/AgentFocusSection';
import { AgentsAdminSection } from '@/components/admin/AgentsAdminSection';
import { AgentHookRunsPanel } from '@/components/admin/AgentHookRunsPanel';
import { PermissionsAdminSection } from '@/components/admin/PermissionsAdminSection';
import { SiteSettingsAdminSection } from '@/components/admin/SiteSettingsAdminSection';
import { NavVisibilityAdminSection } from '@/components/admin/NavVisibilityAdminSection';
import { DrugMergeAdminSection } from '@/components/admin/DrugMergeAdminSection';
import { CitationMergeAdminSection } from '@/components/admin/CitationMergeAdminSection';
import { DisputesAdminSection } from '@/components/admin/DisputesAdminSection';
import { useCan } from '@/lib/usePermissions';
import { showToast } from '@/lib/toast';
import { useTranslation } from 'react-i18next';

interface AdminUser {
  id: number;
  email: string;
  username: string;
  role: string;
  createdAt: string;
}

interface AllowedDomainRow {
  id: number;
  domain: string;
  createdAt: string;
}

interface AllowedEmailRow {
  id: number;
  email: string;
  createdAt: string;
}

interface AdminGroupMember {
  id: number;
  email: string;
  username: string;
  role: string;
}

interface AdminGroup {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  members: AdminGroupMember[];
}

function UserSection() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin?resource=users')
      .then((res) => res.json())
      .then((data) => {
        setUsers(data.users ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function changeRole(userId: number, newRole: string) {
    const res = await fetch('/api/admin?resource=users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, role: newRole }),
    });
    if (res.ok) {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)),
      );
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-4">{t('admin.users')}</h2>
      {loading ? (
        <p className="text-muted-foreground">{t('admin.loadingUsers')}</p>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium">
                  {t('admin.username')}
                </th>
                <th className="text-left px-4 py-3 font-medium">
                  {t('admin.email')}
                </th>
                <th className="text-left px-4 py-3 font-medium">
                  {t('admin.role')}
                </th>
                <th className="text-left px-4 py-3 font-medium">
                  {t('admin.joined')}
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-border">
                  <td className="px-4 py-3">{user.username}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {user.email}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={user.role}
                      onChange={(e) => changeRole(user.id, e.target.value)}
                      className="bg-background border border-input rounded px-2 py-1 text-sm"
                    >
                      <option value="authenticated">
                        {t('admin.authenticated')}
                      </option>
                      <option value="contributor">
                        {t('admin.contributor')}
                      </option>
                      <option value="editor">{t('admin.editor')}</option>
                      <option value="admin">{t('admin.adminRole')}</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AllowedDomainSection() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AllowedDomainRow[]>([]);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    fetch('/api/admin?resource=allowed-domains')
      .then((res) => res.json())
      .then((data) => setRows(data.domains ?? []))
      .catch(() => setRows([]));
  };

  useEffect(load, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/admin?resource=allowed-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain.trim().toLowerCase() }),
    });
    if (res.ok) {
      setDomain('');
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? t('admin.failedAddDomain'));
    }
  }

  async function handleDelete(id: number) {
    await fetch(`/api/admin?resource=allowed-domains&id=${id}`, {
      method: 'DELETE',
    });
    load();
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">
        {t('admin.allowedDomains')}
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('admin.domainsDescription')}
      </p>

      <form onSubmit={handleAdd} className="flex gap-2 mb-3 max-w-md">
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="kinetix.no"
          required
        />
        <Button type="submit">{t('admin.addDomain')}</Button>
      </form>
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <ul className="border border-border rounded-lg divide-y divide-border max-w-md">
        {rows.length === 0 && (
          <li className="p-3 text-sm text-muted-foreground">
            {t('admin.noDomains')}
          </li>
        )}
        {rows.map((row) => (
          <li key={row.id} className="p-3 flex items-center justify-between">
            <span className="font-mono text-sm">{row.domain}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDelete(row.id)}
            >
              {t('admin.remove')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AllowedEmailSection() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AllowedEmailRow[]>([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    fetch('/api/admin?resource=allowed-emails')
      .then((res) => res.json())
      .then((data) => setRows(data.emails ?? []))
      .catch(() => setRows([]));
  };

  useEffect(load, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/admin?resource=allowed-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    if (res.ok) {
      setEmail('');
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? t('admin.failedAddEmail'));
    }
  }

  async function handleDelete(id: number) {
    await fetch(`/api/admin?resource=allowed-emails&id=${id}`, {
      method: 'DELETE',
    });
    load();
  }

  return (
    <section>
      <h2 className="text-xl font-semibold mb-2">{t('admin.allowedEmails')}</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('admin.emailsDescription')}
      </p>

      <form onSubmit={handleAdd} className="flex gap-2 mb-3 max-w-md">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@example.org"
          required
        />
        <Button type="submit">{t('admin.addEmail')}</Button>
      </form>
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <ul className="border border-border rounded-lg divide-y divide-border max-w-md">
        {rows.length === 0 && (
          <li className="p-3 text-sm text-muted-foreground">
            {t('admin.noEmails')}
          </li>
        )}
        {rows.map((row) => (
          <li key={row.id} className="p-3 flex items-center justify-between">
            <span className="font-mono text-sm">{row.email}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDelete(row.id)}
            >
              {t('admin.remove')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GroupsSection() {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [draftMembers, setDraftMembers] = useState<Record<number, Set<number>>>(
    {},
  );
  const [savingGroupId, setSavingGroupId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/admin?resource=groups').then((res) => res.json()),
      fetch('/api/admin?resource=users').then((res) => res.json()),
    ])
      .then(([groupData, userData]) => {
        const nextGroups = groupData.groups ?? [];
        setGroups(nextGroups);
        setUsers(userData.users ?? []);
        setDraftMembers(
          Object.fromEntries(
            nextGroups.map((group: AdminGroup) => [
              group.id,
              new Set(group.members.map((member) => member.id)),
            ]),
          ),
        );
      })
      .catch(() => {
        setGroups([]);
        setUsers([]);
      });
  }, []);

  useEffect(load, [load]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/admin?resource=groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || undefined,
      }),
    });
    if (res.ok) {
      setName('');
      setSlug('');
      setDescription('');
      load();
      showToast(t('admin.groupsCreated'));
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? t('admin.groupsCreateFailed'));
    }
  }

  function toggleMember(groupId: number, userId: number, checked: boolean) {
    setDraftMembers((prev) => {
      const next = new Set(prev[groupId] ?? []);
      if (checked) next.add(userId);
      else next.delete(userId);
      return { ...prev, [groupId]: next };
    });
  }

  async function saveMembers(groupId: number) {
    setError('');
    setSavingGroupId(groupId);
    try {
      const res = await fetch(`/api/admin?resource=groups&id=${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [...(draftMembers[groupId] ?? [])] }),
      });
      if (res.ok) {
        load();
        showToast(t('admin.groupsSaved'));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t('admin.groupsSaveFailed'));
      }
    } catch {
      setError(t('admin.groupsSaveFailed'));
    } finally {
      setSavingGroupId(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">{t('admin.groups')}</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('admin.groupsDescription')}
      </p>

      <form
        onSubmit={handleAdd}
        className="grid gap-2 mb-4 max-w-2xl sm:grid-cols-3"
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('admin.groupNamePlaceholder')}
          required
        />
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={t('admin.groupSlugPlaceholder')}
        />
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('admin.groupDescriptionPlaceholder')}
        />
        <Button type="submit" className="sm:col-span-3 sm:w-fit">
          {t('admin.addGroup')}
        </Button>
      </form>
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <div className="space-y-4">
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('admin.noGroups')}</p>
        )}
        {groups.map((group) => (
          <div key={group.id} className="border border-border rounded-lg p-4">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
              <div>
                <h3 className="font-semibold">{group.name}</h3>
                <p className="text-xs text-muted-foreground">{group.slug}</p>
                {group.description && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {group.description}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => saveMembers(group.id)}
                disabled={savingGroupId === group.id}
              >
                {savingGroupId === group.id
                  ? t('admin.groupsSaving')
                  : t('common.save')}
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {users.map((user) => (
                <label
                  key={user.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={draftMembers[group.id]?.has(user.id) ?? false}
                    onChange={(e) =>
                      toggleMember(group.id, user.id, e.target.checked)
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {user.username}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {user.email}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type AdminPane =
  | 'users'
  | 'permissions'
  | 'groups'
  | 'agents'
  | 'content'
  | 'settings'
  | 'navVisibility'
  | 'seed'
  | 'merge'
  | 'ingest'
  | 'disputes';

const ADMIN_PANES: AdminPane[] = [
  'users',
  'permissions',
  'groups',
  'agents',
  'content',
  'settings',
  'navVisibility',
  'seed',
  'merge',
  'ingest',
  'disputes',
];


function AdminContent() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const paneParam = searchParams.get('pane') as AdminPane | null;
  // Most admin capabilities are delegable (an admin may hand
  // `admin.groups.manage` to editors), so panes are filtered per viewer
  // rather than assuming whoever reached /admin holds everything. A pane can
  // bundle sections whose endpoints have *different* capabilities — user
  // roles vs. the login allowlists, the agent registry vs. the hook-run log —
  // so each section is gated on its own and the pane appears when any of its
  // sections does.
  const canManageUsers = useCan('admin.users.manage');
  const canManageAllowlist = useCan('admin.allowlist.manage');
  const canManagePermissions = useCan('admin.permissions.manage');
  const canManageGroups = useCan('admin.groups.manage');
  const canManageAgents = useCan('admin.agents.manage');
  const canReadHookRuns = useCan('admin.agentHookRuns.read');
  const canFlagParameters = useCan('parameterFlag.write');
  const canSeedDrugs = useCan('admin.researchImport.run');
  const canIngestConversations = useCan('admin.conversationIngestion.run');
  const canManageSettings = useCan('admin.settings.manage');
  const canManageNavVisibility = useCan('admin.navVisibility.manage');
  const canMergeDrugs = useCan('drug.merge');
  const canMergeCitations = useCan('citation.merge');
  const canReadDisputeQueue = useCan('dispute.queue.read');
  const allowed: Record<AdminPane, boolean> = {
    users: canManageUsers || canManageAllowlist,
    permissions: canManagePermissions,
    groups: canManageGroups,
    agents: canManageAgents || canReadHookRuns,
    content: canFlagParameters,
    settings: canManageSettings,
    navVisibility: canManageNavVisibility,
    seed: canSeedDrugs,
    merge: canMergeDrugs || canMergeCitations,
    ingest: canIngestConversations,
    disputes: canReadDisputeQueue,
  };
  const visiblePanes = ADMIN_PANES.filter((pane) => allowed[pane]);
  const activePane: AdminPane =
    paneParam && visiblePanes.includes(paneParam)
      ? paneParam
      : (visiblePanes[0] ?? 'users');

  function selectPane(pane: AdminPane) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('pane', pane);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div className="flex-1 bg-background">
      <main className="max-w-5xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-4">{t('admin.title')}</h1>
        <nav
          aria-label={t('admin.panes.navLabel')}
          className="mb-6 flex flex-wrap gap-1 border-b border-border pb-3"
        >
          {visiblePanes.map((pane) => (
            <button
              key={pane}
              type="button"
              role="tab"
              aria-selected={activePane === pane}
              onClick={() => selectPane(pane)}
              className={buttonVariants({
                variant: activePane === pane ? 'default' : 'ghost',
                size: 'sm',
              })}
            >
              {t(`admin.panes.${pane}`)}
            </button>
          ))}
        </nav>

        {visiblePanes.length === 0 && (
          <p className="text-muted-foreground">
            {/* Reachable when an admin grants admin.panel.access to a tier
                without granting any pane's own capability. Say so rather
                than rendering an empty page. */}
            {t('auth.accessDenied')}
          </p>
        )}
        {activePane === 'users' && (
          <>
            {canManageUsers && <UserSection />}
            {canManageAllowlist && (
              <>
                <AllowedDomainSection />
                <AllowedEmailSection />
              </>
            )}
          </>
        )}
        {activePane === 'permissions' && canManagePermissions && (
          <PermissionsAdminSection />
        )}
        {activePane === 'groups' && canManageGroups && <GroupsSection />}
        {activePane === 'agents' && (
          <>
            {canManageAgents && <AgentsAdminSection />}
            {canReadHookRuns && <AgentHookRunsPanel />}
            {canManageAgents && <AgentFocusSection />}
          </>
        )}
        {activePane === 'content' && canFlagParameters && (
          <PriorityFlagsAdminSection />
        )}
        {activePane === 'settings' && canManageSettings && (
          <SiteSettingsAdminSection />
        )}
        {activePane === 'navVisibility' && canManageNavVisibility && (
          <NavVisibilityAdminSection />
        )}
        {activePane === 'seed' && canSeedDrugs && <ResearchImportAdminSection />}
        {activePane === 'merge' && (
          <>
            {canMergeDrugs && <DrugMergeAdminSection />}
            {canMergeCitations && <CitationMergeAdminSection />}
          </>
        )}
        {activePane === 'ingest' && canIngestConversations && (
          <><WikiArticleImportSection /><ConversationIngestionAdminSection /></>
        )}
        {activePane === 'disputes' && canReadDisputeQueue && (
          <DisputesAdminSection />
        )}
      </main>
    </div>
  );
}

export function AdminPage() {
  return (
    // /admin hosts more than one workflow: most panes are admin-only, but
    // the global dispute queue and the nav-visibility pane are deliberately
    // editor-reachable (moderators are the digest recipients and
    // `GET /api/disputes` already lets them read it — see
    // DisputesAdminSection; `admin.navVisibility.manage` is delegable to
    // editors the same way `admin.settings.manage` is). Gating the whole
    // route on `admin.panel.access` alone would deny those panes to an
    // editor who holds only their own capability, so this follows the same
    // `requiredAnyCapability` pattern as `/wiki/:slug/edit`. `AdminContent`
    // itself still gates each pane (and each section within a pane) on its
    // own capability, so a caller who only holds `dispute.queue.read`,
    // `admin.navVisibility.manage` or `citation.merge` sees just that one tab.
    <AuthGuard
      requiredAnyCapability={[
        'admin.panel.access',
        'dispute.queue.read',
        'admin.navVisibility.manage',
        'citation.merge',
      ]}
    >
      <AdminContent />
    </AuthGuard>
  );
}
