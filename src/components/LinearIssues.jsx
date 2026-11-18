import { useState } from 'react';
import { ChevronsUpDown, UserRound } from 'lucide-react';
import { LINEAR_ISSUE_DRAG, LINEAR_STATUSES } from '../../electron/linearModel.mjs';
import useT from '../hooks/useT.js';

function Assignee({ assignee }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const name = assignee?.name || t('linear.unassigned');
  const initials = assignee?.name?.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join('').toUpperCase();
  return <span className="linear-assignee" role="img" aria-label={name} title={name}>
    {assignee?.avatarUrl && !failed
      ? <img src={assignee.avatarUrl} alt="" draggable={false} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : initials || <UserRound size={13} aria-hidden="true" />}
  </span>;
}

export function LinearIssueCard({ issue, onMove, busy, dragging, onDrag }) {
  const t = useT();
  const draggable = Boolean(onMove && !busy);
  return <article className={`linear-issue nodrag${dragging ? ' is-dragging' : ''}`} data-issue-id={issue.id}
    aria-busy={busy || undefined} draggable={draggable}
    onDragStart={(event) => {
      if (!draggable) return;
      event.stopPropagation();
      event.dataTransfer.setData(LINEAR_ISSUE_DRAG, issue.id);
      event.dataTransfer.effectAllowed = 'move';
      onDrag({ id: issue.id, status: issue.status });
    }} onDragEnd={() => onDrag?.(null)}>
    <div className="linear-issue-meta">
      <span className="linear-issue-id">[{issue.identifier}]</span>
      <Assignee key={issue.assignee?.avatarUrl} assignee={issue.assignee} />
    </div>
    <h4 title={issue.title}>{issue.title}</h4>
    <div className="linear-issue-footer">
      <span className={`linear-priority priority-${issue.priority}`}>{t(`linear.priority.${issue.priority}`)}</span>
      {onMove && <label className="linear-move" title={t('linear.move', { identifier: issue.identifier })}>
        <ChevronsUpDown size={15} aria-hidden="true" />
        <select aria-label={t('linear.move', { identifier: issue.identifier })} data-linear-move
          value={issue.status} aria-disabled={busy || undefined} onChange={(event) => { if (!busy) onMove(issue, event.target.value); }}>
          {LINEAR_STATUSES.map((status) => <option value={status} key={status}>{t(`linear.${status}`)}</option>)}
        </select>
      </label>}
    </div>
  </article>;
}

export function LinearFeedback({ error, loading, snapshot, onSettings }) {
  const t = useT();
  if (error) return <div className="linear-feedback" role="status">
    {t(`linear.error.${error}`)}
    {['notConfigured', 'unauthorized'].includes(error) && <button type="button" className="text-button" onClick={onSettings}>{t('linear.openPreferences')}</button>}
  </div>;
  if (loading && !snapshot) return <p className="linear-feedback" role="status">{t('linear.loading')}</p>;
  return null;
}
