import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agents,
  disputes,
  permissionOverrides,
  users,
  wikiPages,
  drugParameterDiscussions,
  drugParameterRevisions,
  notifications,
  parameterEntries,
  pendingEdits,
} from '../../db/schema.js';
import {
  contributionAuthorUserId,
  fanOutDisputeNotification,
  listNotifications,
  notifyContributionFeedback,
  reclassifyTargetAuthorNotices,
} from '../../api/_lib/notifications.js';
import { resetPermissionOverridesForTests } from '../../api/_lib/permissions-store.js';
import { notifyEditDecision } from '../../api/_lib/editDecisionNotifications.js';
import { notifyCommentFeedback } from '../../api/_lib/commentNotifications.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let alice: number;
let bob: number;
let carol: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  alice = await seedUser(db, { email: 'alice@example.com', username: 'alice' });
  bob = await seedUser(db, { email: 'bob@example.com', username: 'bob' });
  carol = await seedUser(db, { email: 'carol@example.com', username: 'carol' });
});

async function inbox(userId: number) {
  return db
    .select({
      type: notifications.type,
      audience: notifications.audience,
      bodyMd: notifications.bodyMd,
      url: notifications.url,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));
}

describe('notifyContributionFeedback', () => {
  it('writes one author-audience row for a human recipient', async () => {
    const r = await notifyContributionFeedback({
      recipientUserId: alice,
      actorUserId: bob,
      type: 'contribution_endorsed',
      targetType: 'wiki_revision',
      targetId: 1,
      title: 'Your contribution received an approval stamp',
      url: '/wiki/x',
    });
    expect(r.notified).toBe(true);
    expect(await inbox(alice)).toEqual([
      { type: 'contribution_endorsed', audience: 'author', bodyMd: null, url: '/wiki/x' },
    ]);
  });

  it('never notifies the actor about their own action, or an agent', async () => {
    await db.insert(agents).values({ userId: carol, name: 'Carol bot', slug: 'carol-bot' });
    const self = await notifyContributionFeedback({
      recipientUserId: alice,
      actorUserId: alice,
      type: 'edit_approved',
      targetType: 'pending_edit',
      targetId: 1,
      title: 'x',
      url: '/review?id=1',
    });
    const agent = await notifyContributionFeedback({
      recipientUserId: carol,
      actorUserId: alice,
      type: 'edit_approved',
      targetType: 'pending_edit',
      targetId: 1,
      title: 'x',
      url: '/review?id=1',
    });
    expect(self.notified).toBe(false);
    expect(agent.notified).toBe(false);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});

describe('notifyEditDecision', () => {
  it('tells the submitter the decision and carries the reviewer note', async () => {
    await notifyEditDecision({
      edit: { id: 42, submittedBy: alice, editType: 'parameter' },
      decision: 'returned',
      actorUserId: bob,
      note: '  Please cite the table directly.  ',
    });
    expect(await inbox(alice)).toEqual([
      {
        type: 'edit_returned',
        audience: 'author',
        bodyMd: 'Please cite the table directly.',
        url: '/review?id=42&status=all',
      },
    ]);
  });
});

describe('notifyCommentFeedback', () => {
  it('tells the replied-to author and the parameter contributors, each once', async () => {
    const drugId = await seedDrug(db);
    const [edit] = await db
      .insert(pendingEdits)
      .values({ editType: 'parameter', status: 'approved', submittedBy: alice, reviewedBy: carol, proposedValue: {} } as never)
      .returning({ id: pendingEdits.id });
    await db.insert(drugParameterRevisions).values({
      drugId,
      parameter: 'halfLife',
      pendingEditId: edit!.id,
      createdBy: alice,
    });
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'halfLife',
      low: '2',
      high: '4',
      unit: 'h',
      createdBy: bob,
    } as never);
    const [parent] = await db
      .insert(drugParameterDiscussions)
      .values({ drugId, parameter: 'halfLife', body: 'Source?', createdBy: bob })
      .returning({ id: drugParameterDiscussions.id });

    await notifyCommentFeedback({
      comment: {
        id: 99,
        body: 'Table 2 of the paper.',
        parentId: parent!.id,
        parameter: 'halfLife',
        drugId,
        wikiPageId: null,
        createdBy: carol,
      },
      url: '/wiki/drug',
    });

    // Bob wrote the parent AND contributed a source value: the reply wins.
    expect((await inbox(bob)).map((r) => r.type)).toEqual(['comment_reply']);
    expect((await inbox(alice)).map((r) => r.type)).toEqual(['comment_on_contribution']);
    expect(await inbox(carol)).toEqual([]);
  });

  it('does not take a recompute, an import or an ingested value for a contribution', async () => {
    const drugId = await seedDrug(db);
    // Alice triggered an aggregate recompute and ran a research import; Bob
    // ingested a source value through a conversation bundle.
    await db.insert(drugParameterRevisions).values([
      { drugId, parameter: 'halfLife', createdBy: alice, editSummary: 'Seeded from deep-research output' },
      { drugId, parameter: 'halfLife', createdBy: alice, editSummary: 'auto:param_entries_recomputed:2' },
    ]);
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'halfLife',
      low: '2',
      high: '4',
      unit: 'h',
      origin: 'conversation',
      createdBy: bob,
    } as never);

    await notifyCommentFeedback({
      comment: {
        id: 99,
        body: 'Reference 1610 points at the wrong compound.',
        parentId: null,
        parameter: 'halfLife',
        drugId,
        wikiPageId: null,
        createdBy: carol,
      },
      url: '/wiki/drug',
    });

    expect(await inbox(alice)).toEqual([]);
    expect(await inbox(bob)).toEqual([]);
  });

  it('tells earlier commenters in the thread how the discussion continues', async () => {
    const drugId = await seedDrug(db);
    await db.insert(drugParameterDiscussions).values([
      { drugId, parameter: 'halfLife', body: 'Is this the right CID?', createdBy: alice },
      { drugId, parameter: 'tmax', body: 'Other thread', createdBy: bob },
    ]);

    await notifyCommentFeedback({
      comment: {
        id: 99,
        body: 'No — CID 9332 is a different compound.',
        parentId: null,
        parameter: 'halfLife',
        drugId,
        wikiPageId: null,
        createdBy: carol,
      },
      url: '/wiki/drug',
    });

    expect(await inbox(alice)).toEqual([
      {
        type: 'comment_in_thread',
        audience: 'author',
        bodyMd: 'No — CID 9332 is a different compound.',
        url: '/wiki/drug',
      },
    ]);
    // A comment in another parameter's thread is not this discussion.
    expect(await inbox(bob)).toEqual([]);
    expect(await inbox(carol)).toEqual([]);
  });

  it('does not take a fact its submitter approved themselves for a contribution', async () => {
    const [page] = await db
      .insert(wikiPages)
      .values({ slug: 'ingested', title: 'I', status: 'published', createdBy: bob, updatedBy: bob } as never)
      .returning({ id: wikiPages.id });
    await db.insert(pendingEdits).values({
      editType: 'wiki_fact',
      status: 'approved',
      submittedBy: alice,
      reviewedBy: alice,
      targetId: page!.id,
      proposedValue: { type: 'fact', attrs: { factId: 'f-ingested' } },
    } as never);

    await notifyCommentFeedback({
      comment: {
        id: 13,
        body: 'Source?',
        parentId: null,
        parameter: 'fact:f-ingested',
        drugId: null,
        wikiPageId: page!.id,
        createdBy: bob,
      },
      url: '/wiki/ingested',
    });

    expect(await inbox(alice)).toEqual([]);
  });

  it('finds a fact’s author through its approved wiki_fact edit', async () => {
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'public-topic',
        title: 'Public topic',
        status: 'published',
        createdBy: bob,
        updatedBy: bob,
      } as never)
      .returning({ id: wikiPages.id });
    await db.insert(pendingEdits).values({
      editType: 'wiki_fact',
      status: 'approved',
      submittedBy: alice,
      targetId: page!.id,
      proposedValue: { type: 'fact', attrs: { factId: 'f-123' } },
    } as never);

    await notifyCommentFeedback({
      comment: {
        id: 7,
        body: 'Is this still current?',
        parentId: null,
        parameter: 'fact:f-123',
        drugId: null,
        wikiPageId: page!.id,
        createdBy: bob,
      },
      url: '/wiki/topic',
    });

    expect(await inbox(alice)).toEqual([
      {
        type: 'comment_on_contribution',
        audience: 'author',
        bodyMd: 'Is this still current?',
        url: '/wiki/topic',
      },
    ]);
  });

  it('looks the fact author up on the thread’s own page only', async () => {
    const pages = await db
      .insert(wikiPages)
      .values([
        { slug: 'topic-a', title: 'A', status: 'published', createdBy: bob, updatedBy: bob },
        { slug: 'topic-b', title: 'B', status: 'published', createdBy: bob, updatedBy: bob },
      ] as never)
      .returning({ id: wikiPages.id });
    // The same factId on two pages; the other page's edit is the newer one.
    await db.insert(pendingEdits).values([
      {
        editType: 'wiki_fact',
        status: 'approved',
        submittedBy: alice,
        targetId: pages[0]!.id,
        reviewedAt: new Date('2026-09-01T00:00:00Z'),
        proposedValue: { type: 'fact', attrs: { factId: 'f-shared' } },
      },
      {
        editType: 'wiki_fact',
        status: 'approved',
        submittedBy: carol,
        targetId: pages[1]!.id,
        reviewedAt: new Date('2026-09-20T00:00:00Z'),
        proposedValue: { type: 'fact', attrs: { factId: 'f-shared' } },
      },
    ] as never);

    await notifyCommentFeedback({
      comment: {
        id: 8,
        body: 'Which study?',
        parentId: null,
        parameter: 'fact:f-shared',
        drugId: null,
        wikiPageId: pages[0]!.id,
        createdBy: bob,
      },
      url: '/wiki/topic-a',
    });

    expect((await inbox(alice)).map((r) => r.type)).toEqual(['comment_on_contribution']);
    expect(await inbox(carol)).toEqual([]);
  });

  it('does not take someone who only reordered a fact for its author', async () => {
    const [page] = await db
      .insert(wikiPages)
      .values({ slug: 'reordered', title: 'R', status: 'published', createdBy: bob, updatedBy: bob } as never)
      .returning({ id: wikiPages.id });
    await db.insert(pendingEdits).values([
      {
        editType: 'wiki_fact',
        status: 'approved',
        submittedBy: alice,
        targetId: page!.id,
        factOperation: 'add',
        reviewedAt: new Date('2026-09-01T00:00:00Z'),
        proposedValue: { type: 'fact', attrs: { factId: 'f-moved' } },
      },
      {
        editType: 'wiki_fact',
        status: 'approved',
        submittedBy: carol,
        targetId: page!.id,
        factOperation: 'reorder',
        factTargetAnchor: { factId: 'f-moved' },
        reviewedAt: new Date('2026-09-20T00:00:00Z'),
        proposedValue: {},
      },
    ] as never);

    await notifyCommentFeedback({
      comment: {
        id: 12,
        body: 'Source?',
        parentId: null,
        parameter: 'fact:f-moved',
        drugId: null,
        wikiPageId: page!.id,
        createdBy: bob,
      },
      url: '/wiki/reordered',
    });

    expect((await inbox(alice)).map((r) => r.type)).toEqual(['comment_on_contribution']);
    expect(await inbox(carol)).toEqual([]);
  });

  it('finds the author of a fact on a drug’s monograph page', async () => {
    const drugId = await seedDrug(db);
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'drug-monograph',
        title: 'Drug',
        pageType: 'drug_monograph',
        drugCid: drugId,
        status: 'published',
        createdBy: bob,
        updatedBy: bob,
      } as never)
      .returning({ id: wikiPages.id });
    await db.insert(pendingEdits).values({
      editType: 'wiki_fact',
      status: 'approved',
      submittedBy: alice,
      targetId: page!.id,
      proposedValue: { type: 'fact', attrs: { factId: 'f-drug' } },
    } as never);

    await notifyCommentFeedback({
      comment: {
        id: 11,
        body: 'Dose-dependent?',
        parentId: null,
        parameter: 'fact:f-drug',
        drugId,
        wikiPageId: null,
        createdBy: bob,
      },
      url: '/wiki/drug',
    });

    expect((await inbox(alice)).map((r) => r.type)).toEqual(['comment_on_contribution']);
  });

  it('ignores a parent from another parameter’s thread on the same drug', async () => {
    const drugId = await seedDrug(db);
    const [otherThread] = await db
      .insert(drugParameterDiscussions)
      .values({ drugId, parameter: 'tmax', body: 'Unrelated', createdBy: alice })
      .returning({ id: drugParameterDiscussions.id });

    await notifyCommentFeedback({
      comment: {
        id: 9,
        body: 'Hi',
        parentId: otherThread!.id,
        parameter: 'halfLife',
        drugId,
        wikiPageId: null,
        createdBy: bob,
      },
      url: '/wiki/drug',
    });

    expect(await inbox(alice)).toEqual([]);
  });

  it('tells nobody who can no longer read an unpublished topic page', async () => {
    const editor = await seedUser(db, { email: 'ed@example.com', username: 'ed', role: 'editor' });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'hidden-topic',
        title: 'Hidden topic',
        status: 'draft',
        createdBy: editor,
        updatedBy: editor,
      } as never)
      .returning({ id: wikiPages.id });
    // Alice (a contributor) wrote the fact while the page was public.
    await db.insert(pendingEdits).values({
      editType: 'wiki_fact',
      status: 'approved',
      submittedBy: alice,
      targetId: page!.id,
      proposedValue: { type: 'fact', attrs: { factId: 'f-hidden' } },
    } as never);
    const [parent] = await db
      .insert(drugParameterDiscussions)
      .values({
        wikiPageId: page!.id,
        parameter: 'fact:f-hidden',
        body: 'Source?',
        createdBy: carol,
      })
      .returning({ id: drugParameterDiscussions.id });

    await notifyCommentFeedback({
      comment: {
        id: 10,
        body: 'Internal note on a draft page',
        parentId: parent!.id,
        parameter: 'fact:f-hidden',
        drugId: null,
        wikiPageId: page!.id,
        createdBy: editor,
      },
      url: '/wiki/hidden-topic',
    });

    // Neither the fact author nor the replied-to commenter may read a draft.
    expect(await inbox(alice)).toEqual([]);
    expect(await inbox(carol)).toEqual([]);
  });

  it('ignores a parent id from a different thread', async () => {
    const drugA = await seedDrug(db);
    const drugB = await seedDrug(db, { slug: 'other-drug' });
    const [elsewhere] = await db
      .insert(drugParameterDiscussions)
      .values({ drugId: drugA, parameter: null, body: 'Unrelated', createdBy: alice })
      .returning({ id: drugParameterDiscussions.id });

    await notifyCommentFeedback({
      comment: {
        id: 8,
        body: 'Hi',
        parentId: elsewhere!.id,
        parameter: null,
        drugId: drugB,
        wikiPageId: null,
        createdBy: bob,
      },
      url: '/wiki/b',
    });

    expect(await inbox(alice)).toEqual([]);
  });
});

describe('fanOutDisputeNotification audience', () => {
  it('follows the current dispute.queue.read tier, not fixed role names', async () => {
    const contributor = await seedUser(db, {
      email: 'c2@example.com',
      username: 'c2',
      role: 'contributor',
    });
    const editor = await seedUser(db, { email: 'e@example.com', username: 'e', role: 'editor' });
    const fanOut = () =>
      fanOutDisputeNotification({
        type: 'dispute_opened',
        disputeId: null as never,
        targetType: 'pending_edit',
        targetId: 1,
        actorUserId: alice,
        targetAuthorUserId: bob,
        title: 'Dispute opened',
        url: '/review?id=1',
      });

    try {
      // Shipped default: editors and admins read the queue.
      resetPermissionOverridesForTests();
      await fanOut();
      expect((await inbox(editor)).map((r) => r.audience)).toEqual(['reviewer']);
      expect(await inbox(contributor)).toEqual([]);
      expect((await inbox(bob)).map((r) => r.audience)).toEqual(['author']);

      // An admin lowers the capability to contributors: they join the queue
      // audience, and so become eligible for reviewer email.
      await db
        .insert(permissionOverrides)
        .values({ capability: 'dispute.queue.read', minTier: 'contributor' });
      // An agent's backing user holds the contributor role too, but agents
      // read the dispute feed, never the inbox.
      await db.update(users).set({ role: 'contributor' }).where(eq(users.id, carol));
      await db.insert(agents).values({ userId: carol, name: 'Carol bot', slug: 'carol-bot' });
      resetPermissionOverridesForTests();
      await fanOut();
      expect((await inbox(contributor)).map((r) => r.audience)).toEqual(['reviewer']);
      expect(await inbox(carol)).toEqual([]);
    } finally {
      await db.delete(permissionOverrides);
      resetPermissionOverridesForTests();
    }
  });
});

describe('listNotifications excerpt visibility', () => {
  async function commentNotice(args: { pageStatus: 'published' | 'draft' }) {
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: `page-${args.pageStatus}`,
        title: 'Page',
        status: args.pageStatus,
        createdBy: bob,
        updatedBy: bob,
      } as never)
      .returning({ id: wikiPages.id });
    const [comment] = await db
      .insert(drugParameterDiscussions)
      .values({ wikiPageId: page!.id, parameter: null, body: 'Text', createdBy: bob })
      .returning({ id: drugParameterDiscussions.id });
    await db.insert(notifications).values({
      userId: alice,
      type: 'comment_reply',
      title: 'New reply to your comment',
      bodyMd: 'Text',
      url: '/wiki/page',
      audience: 'author',
      targetType: 'drug_discussion',
      targetId: comment!.id,
    });
    return { pageId: page!.id, commentId: comment!.id };
  }

  it('keeps the excerpt while the reader can see the page', async () => {
    await commentNotice({ pageStatus: 'published' });
    const [row] = await listNotifications({ userId: alice, role: 'contributor', limit: 10 });
    expect(row!.bodyMd).toBe('Text');
  });

  it('withholds the excerpt once the page is unpublished for this reader', async () => {
    await commentNotice({ pageStatus: 'draft' });
    const [row] = await listNotifications({ userId: alice, role: 'contributor', limit: 10 });
    expect(row!.title).toBe('New reply to your comment');
    expect(row!.bodyMd).toBeNull();
  });

  it('withholds the excerpt once the comment is deleted', async () => {
    const { commentId } = await commentNotice({ pageStatus: 'published' });
    await db.delete(drugParameterDiscussions).where(eq(drugParameterDiscussions.id, commentId));
    const [row] = await listNotifications({ userId: alice, role: 'contributor', limit: 10 });
    expect(row!.bodyMd).toBeNull();
  });
});

describe('listNotifications review-queue excerpts', () => {
  async function reviewerNotice() {
    await db.insert(notifications).values({
      userId: alice,
      type: 'dispute_opened',
      title: 'Dispute opened',
      bodyMd: 'The dispute reason',
      url: '/review?id=1',
      audience: 'reviewer',
      targetType: 'pending_edit',
      targetId: 1,
    });
  }

  it('keeps the excerpt for someone who may read the queue', async () => {
    await reviewerNotice();
    const [row] = await listNotifications({ userId: alice, role: 'editor', limit: 10 });
    expect(row!.bodyMd).toBe('The dispute reason');
  });

  it('withholds it once the caller may no longer read the queue', async () => {
    await reviewerNotice();
    const [row] = await listNotifications({ userId: alice, role: 'contributor', limit: 10 });
    expect(row!.title).toBe('Dispute opened');
    expect(row!.bodyMd).toBeNull();
  });

  it('keeps it for the disputed target’s author, even on a row stored as reviewer', async () => {
    // A row the previous build wrote during the deploy window: 'reviewer' by
    // default, though Alice is the author of the disputed edit.
    const [edit] = await db
      .insert(pendingEdits)
      .values({ editType: 'wiki_fact', status: 'pending', submittedBy: alice, proposedValue: {} } as never)
      .returning({ id: pendingEdits.id });
    const [dispute] = await db
      .insert(disputes)
      .values({
        targetType: 'pending_edit',
        targetId: edit!.id,
        createdBy: bob,
        source: 'human',
        reasonMd: 'The dispute reason',
      })
      .returning({ id: disputes.id });
    await db.insert(notifications).values({
      userId: alice,
      type: 'dispute_opened',
      title: 'Dispute opened',
      bodyMd: 'The dispute reason',
      audience: 'reviewer',
      targetType: 'pending_edit',
      targetId: edit!.id,
      disputeId: dispute!.id,
    });

    const [row] = await listNotifications({ userId: alice, role: 'contributor', limit: 10 });
    expect(row!.bodyMd).toBe('The dispute reason');
  });
});

describe('contributionAuthorUserId', () => {
  let seq = 0;
  async function revision(values: {
    createdBy: number;
    editSummary?: string;
    pendingEdit?: { submittedBy: number; reviewedBy: number | null };
  }) {
    const drugId = await seedDrug(db, { slug: `drug-${++seq}` });
    let pendingEditId: number | undefined;
    if (values.pendingEdit) {
      const [edit] = await db
        .insert(pendingEdits)
        .values({ editType: 'parameter', status: 'approved', proposedValue: {}, ...values.pendingEdit } as never)
        .returning({ id: pendingEdits.id });
      pendingEditId = edit!.id;
    }
    const [rev] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId,
        parameter: 'halfLife',
        createdBy: values.createdBy,
        editSummary: values.editSummary ?? null,
        pendingEditId,
      })
      .returning({ id: drugParameterRevisions.id });
    return contributionAuthorUserId({ targetType: 'drug_parameter_revision', targetId: rev!.id });
  }

  it('credits a parameter revision to whoever submitted it for review', async () => {
    expect(await revision({ createdBy: alice, pendingEdit: { submittedBy: alice, reviewedBy: bob } })).toBe(alice);
  });

  it('credits nobody for a recompute, a direct write or import, or a self-approved item', async () => {
    expect(
      await revision({
        createdBy: alice,
        editSummary: 'auto:param_entries_recomputed:2',
        pendingEdit: { submittedBy: bob, reviewedBy: alice },
      }),
    ).toBeNull();
    expect(await revision({ createdBy: alice, editSummary: 'Seeded from deep-research output' })).toBeNull();
    expect(await revision({ createdBy: alice, pendingEdit: { submittedBy: alice, reviewedBy: alice } })).toBeNull();
  });
});

describe('dispute notices that are feedback on the recipient’s own work', () => {
  async function disputeOnImportedRevision() {
    const drugId = await seedDrug(db);
    const [rev] = await db
      .insert(drugParameterRevisions)
      .values({ drugId, parameter: 'halfLife', createdBy: alice, editSummary: 'auto:param_entries_recomputed:2' })
      .returning({ id: drugParameterRevisions.id });
    const [dispute] = await db
      .insert(disputes)
      .values({
        targetType: 'drug_parameter_revision',
        targetId: rev!.id,
        createdBy: bob,
        source: 'human',
        reasonMd: 'Reference 1610 points at the wrong compound.',
      })
      .returning({ id: disputes.id });
    return { revisionId: rev!.id, disputeId: dispute!.id };
  }

  it('moves a queued notice off "your contribution" for someone who only triggered a recompute', async () => {
    const { revisionId, disputeId } = await disputeOnImportedRevision();
    await db.insert(notifications).values({
      userId: alice,
      type: 'dispute_opened',
      title: 'Dispute opened',
      audience: 'author',
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
      disputeId,
    });
    await reclassifyTargetAuthorNotices();
    expect((await inbox(alice)).map((r) => r.audience)).toEqual(['reviewer']);
  });

  it('tells the person who raised a dispute how it was ruled, as their own feedback', async () => {
    const { revisionId, disputeId } = await disputeOnImportedRevision();
    const editor = await seedUser(db, { email: 'ed@example.com', username: 'ed', role: 'editor' });
    resetPermissionOverridesForTests();
    await fanOutDisputeNotification({
      type: 'dispute_resolved',
      disputeId,
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
      actorUserId: editor,
      targetAuthorUserId: null,
      raisedByUserId: bob,
      title: 'Dispute upheld',
    });
    expect((await inbox(bob)).map((r) => [r.type, r.audience])).toEqual([
      ['dispute_resolved', 'author'],
    ]);
    // Alice only triggered the recompute: not told at all as a contributor.
    expect(await inbox(alice)).toEqual([]);
    // And the reclassifier agrees the raiser's copy is theirs.
    await reclassifyTargetAuthorNotices();
    expect((await inbox(bob)).map((r) => r.audience)).toEqual(['author']);
  });
});
