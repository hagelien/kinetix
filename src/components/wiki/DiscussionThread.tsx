import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useCan } from '@/lib/usePermissions';
import {
  fetchDiscussions,
  postDiscussion,
  type DrugDiscussionDTO,
} from '@/lib/drugApi';
import type { DrugParameterId } from '@/lib/drugParameters';
import type {
  DiscussionHost,
  FactDiscussionTargetKey,
} from '@/lib/discussionTargets';
import { linkify } from '@/lib/linkify';
import { UserBadge } from '@/components/ui/UserBadge';
import { ApprovalStamp } from '@/components/ui/ApprovalStamp';

interface DiscussionThreadProps {
  /** Drug monograph (`{ drugId }`) or topic page (`{ wikiPageId }`). */
  host: DiscussionHost;
  /** null => monograph-wide thread. */
  parameter: DrugParameterId | FactDiscussionTargetKey | null;
  /** Optional heading rendered above the thread. */
  heading?: string;
}

interface ThreadNode {
  comment: DrugDiscussionDTO;
  replies: ThreadNode[];
}

/**
 * Group the flat list of comments into a nested tree using parentId. Top-level
 * nodes (parentId === null) ordered oldest-first so a reader scrolls chronologically.
 */
function buildTree(items: DrugDiscussionDTO[]): ThreadNode[] {
  const byId = new Map<number, ThreadNode>();
  for (const c of items) byId.set(c.id, { comment: c, replies: [] });
  const roots: ThreadNode[] = [];
  for (const node of byId.values()) {
    if (node.comment.parentId && byId.has(node.comment.parentId)) {
      byId.get(node.comment.parentId)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  const byDate = (a: ThreadNode, b: ThreadNode) =>
    new Date(a.comment.createdAt).getTime() -
    new Date(b.comment.createdAt).getTime();
  roots.sort(byDate);
  for (const n of byId.values()) n.replies.sort(byDate);
  return roots;
}

function ThreadComment({
  node,
  depth,
  onReply,
  postingReplyTo,
  replyBody,
  setReplyBody,
  onSubmitReply,
  onCancelReply,
  posting,
  canPost,
}: {
  node: ThreadNode;
  depth: number;
  onReply: (id: number) => void;
  postingReplyTo: number | null;
  replyBody: string;
  setReplyBody: (v: string) => void;
  onSubmitReply: (parentId: number) => void;
  onCancelReply: () => void;
  posting: boolean;
  canPost: boolean;
}) {
  const { t } = useTranslation();
  const isReplying = postingReplyTo === node.comment.id;
  return (
    <li className={depth === 0 ? '' : 'ml-4 border-l border-border pl-3'}>
      <div className="group rounded-md border border-border p-3 bg-muted/30 relative">
        <div className="text-xs text-muted-foreground mb-1 flex items-center justify-between gap-2">
          <span>
            <UserBadge user={node.comment.author} /> ·{' '}
            {new Date(node.comment.createdAt).toLocaleString()}
          </span>
          <span>
            <ApprovalStamp
              targetType="drug_discussion"
              targetId={node.comment.id}
              variant="hover"
              initial={
                node.comment.approvals ?? {
                  count: 0,
                  approvers: [],
                  approvedByMe: false,
                }
              }
            />
          </span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">
          {linkify(node.comment.body)}
        </div>
        {canPost && depth < 3 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() =>
                isReplying ? onCancelReply() : onReply(node.comment.id)
              }
              className="text-xs text-primary hover:underline"
            >
              {t('discussion.reply')}
            </button>
          </div>
        )}
        {isReplying && (
          <div className="mt-2 flex flex-col gap-2">
            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              rows={2}
              placeholder={t('discussion.writeReply')}
              className="w-full rounded-md border border-border p-2 text-sm bg-background"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onCancelReply}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => onSubmitReply(node.comment.id)}
                disabled={posting || !replyBody.trim()}
              >
                {t('discussion.post')}
              </Button>
            </div>
          </div>
        )}
      </div>
      {node.replies.length > 0 && (
        <ul className="mt-2 space-y-2">
          {node.replies.map((child) => (
            <ThreadComment
              key={child.comment.id}
              node={child}
              depth={depth + 1}
              onReply={onReply}
              postingReplyTo={postingReplyTo}
              replyBody={replyBody}
              setReplyBody={setReplyBody}
              onSubmitReply={onSubmitReply}
              onCancelReply={onCancelReply}
              posting={posting}
              canPost={canPost}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function DiscussionThread({
  host,
  parameter,
  heading,
}: DiscussionThreadProps) {
  const { t } = useTranslation();
  const [discussions, setDiscussions] = useState<DrugDiscussionDTO[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const canComment = useCan('discussion.comment.create');

  // Stabilise the host object so the load callback's dependency array keys
  // off its contents, not a fresh `{ drugId }` literal each render.
  const hostKey =
    'drugId' in host ? `drug:${host.drugId}` : `page:${host.wikiPageId}`;
  const load = useCallback(() => {
    fetchDiscussions(host, parameter)
      .then((data) => setDiscussions(data.discussions))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey, parameter]);

  useEffect(() => {
    load();
  }, [load]);

  const handlePost = async () => {
    if (!body.trim()) return;
    setPosting(true);
    setError(null);
    try {
      await postDiscussion(host, body.trim(), parameter);
      setBody('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  };

  const handleReply = async (parentId: number) => {
    if (!replyBody.trim()) return;
    setPosting(true);
    setError(null);
    try {
      await postDiscussion(host, replyBody.trim(), parameter, parentId);
      setReplyBody('');
      setReplyingTo(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  };

  const tree = discussions ? buildTree(discussions) : null;

  return (
    <section className="space-y-3">
      {heading && <h3 className="text-base font-semibold">{heading}</h3>}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && discussions === null && (
        <p className="text-sm text-muted-foreground">
          {t('discussion.loading')}
        </p>
      )}
      {tree && tree.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t('discussion.monographEmpty')}
        </p>
      )}
      {tree && tree.length > 0 && (
        <ul className="space-y-2">
          {tree.map((node) => (
            <ThreadComment
              key={node.comment.id}
              node={node}
              depth={0}
              onReply={(id) => {
                setReplyingTo(id);
                setReplyBody('');
              }}
              postingReplyTo={replyingTo}
              replyBody={replyBody}
              setReplyBody={setReplyBody}
              onSubmitReply={handleReply}
              onCancelReply={() => {
                setReplyingTo(null);
                setReplyBody('');
              }}
              posting={posting}
              canPost={canComment}
            />
          ))}
        </ul>
      )}

      {canComment ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder={t('discussion.writeComment')}
            className="w-full rounded-md border border-border p-2 text-sm bg-background"
          />
          <div className="flex justify-end">
            <Button onClick={handlePost} disabled={posting || !body.trim()}>
              {posting ? t('discussion.loading') : t('discussion.post')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('discussion.signInToComment')}
        </p>
      )}
    </section>
  );
}
