import { Component, createRef, useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import { LINEAR_ISSUE_DRAG, LINEAR_STATUSES, linearScopeId, sanitizeLinearBoard } from '../../electron/linearModel.mjs';
import { useBoard } from '../context/BoardContext.jsx';
import useLinearIssues from '../hooks/useLinearIssues.js';
import useT from '../hooks/useT.js';
import { LinearFeedback, LinearIssueCard } from './LinearIssues.jsx';
import LinearLogo from './LinearLogo.jsx';

const EMPTY_COLUMNS = Object.fromEntries(LINEAR_STATUSES.map((status) => [status, []]));

// Capture the old positions before React reparents cards into their new columns.
class LinearColumns extends Component {
  grid = createRef();

  getSnapshotBeforeUpdate(previous) {
    if (previous.columns === this.props.columns) return null;
    const moves = new Map();
    const current = new Map(Object.values(this.props.columns).flat().map((issue) => [issue.id, issue.status]));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const card of this.grid.current.querySelectorAll('[data-issue-id]')) {
      const next = current.get(card.dataset.issueId);
      if (next && next !== card.closest('[data-linear-status]').dataset.linearStatus) {
        moves.set(card.dataset.issueId, { rect: reduced ? null : card.getBoundingClientRect(), focused: card.contains(document.activeElement) });
      }
    }
    return moves.size ? moves : null;
  }

  componentDidUpdate(_props, _state, moves) {
    if (!moves) return;
    const grid = this.grid.current;
    const zoom = grid.getBoundingClientRect().width / grid.offsetWidth;
    for (const card of grid.querySelectorAll('[data-issue-id]')) {
      const move = moves.get(card.dataset.issueId);
      if (!move) continue;
      if (move.rect && zoom) {
        const next = card.getBoundingClientRect();
        const x = (move.rect.left - next.left) / zoom;
        const y = (move.rect.top - next.top) / zoom;
        card.style.setProperty('--linear-move-x', `${x}px`);
        card.style.setProperty('--linear-move-y', `${y}px`);
        card.classList.add('linear-arriving');
      }
      if (move.focused) card.querySelector('[data-linear-move]')?.focus({ preventScroll: true });
    }
  }

  render() {
    const { columns, t, busy, dragging, dropTarget, loaded, onDrag, onDragOver, onDrop, onDragLeave, onMove } = this.props;
    return <div className="linear-columns nodrag nopan nowheel thin-scrollbar" ref={this.grid}>
      {LINEAR_STATUSES.map((status) => <section key={status} className={`linear-column${dropTarget === status ? ' is-drop-target' : ''}`}
        data-linear-status={status} onDragOver={(event) => onDragOver(event, status)}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onDragLeave(); }}
        onDrop={(event) => onDrop(event, status)}>
        <h3 className="linear-column-heading">
          <span className="linear-status-mark" aria-hidden="true" />{t(`linear.${status}`)}
          {loaded && <span className="linear-column-count">{columns[status].length}</span>}
        </h3>
        <div className="linear-column-cards">
          {columns[status].map((issue) => <LinearIssueCard key={issue.id} issue={issue} onMove={onMove}
            busy={busy} dragging={dragging?.id === issue.id} onDrag={onDrag} />)}
          {loaded && !columns[status].length && <p className="linear-empty">{t('linear.noIssues')}</p>}
        </div>
      </section>)}
    </div>;
  }
}

function LinearFilters({ data, onSave }) {
  const t = useT();
  const [projectId, setProjectId] = useState(data.projectId ?? '');
  const [teamId, setTeamId] = useState(data.teamId ?? '');
  const invalid = (projectId.trim() && !linearScopeId(projectId)) || (teamId.trim() && !linearScopeId(teamId));
  return <form className="linear-filters nodrag nopan nowheel" onSubmit={(event) => {
    event.preventDefault();
    if (!invalid) onSave(sanitizeLinearBoard({ projectId, teamId }));
  }}>
    <label className="field"><span className="field-label">{t('linear.projectId')}</span>
      <input value={projectId} maxLength={128} onChange={(event) => setProjectId(event.target.value)} autoFocus /></label>
    <label className="field"><span className="field-label">{t('linear.teamId')}</span>
      <input value={teamId} maxLength={128} onChange={(event) => setTeamId(event.target.value)} /></label>
    <p className="hint">{t(invalid ? 'linear.error.invalidScope' : 'linear.filterHint')}</p>
    <button type="submit" className="text-button" disabled={!!invalid}>{t('common.save')}</button>
  </form>;
}

function LinearBoardContent({ id, data, onSave }) {
  const t = useT();
  const { boardId, prepareLinearMove, onOpenLinearSettings } = useBoard();
  const { snapshot, error, loading, refresh } = useLinearIssues(data);
  const [filters, setFilters] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState(null);
  const columns = snapshot?.columns ?? EMPTY_COLUMNS;

  function onDrag(issue) {
    setDragging(issue);
    setDropTarget(null);
  }

  async function move(issue, status) {
    if (moving || issue.status === status) return;
    setMoving(true);
    setMoveError(null);
    try {
      const canDelegate = status === 'inProgress' && await prepareLinearMove(id);
      const result = await window.linearBoard.updateIssueStatus({ issueId: issue.id, status, expectedStatus: issue.status }, canDelegate ? { boardId, nodeId: id } : undefined);
      if (result.error) setMoveError(result.error);
      if (result.error === 'issueMoved' || result.error === 'unavailable' || result.changed === false) refresh();
    } catch { setMoveError('unavailable'); }
    finally { setMoving(false); }
  }

  return <>
    <header className="linear-board-header">
      <span className="linear-board-logo"><LinearLogo size={23} /></span>
      <div className="linear-board-heading">
        {snapshot?.title && <span>{t('linear.boardTitle')}</span>}
        <h2 title={snapshot?.title}>{snapshot?.title || t('linear.boardTitle')}</h2>
      </div>
      <div className="linear-header-actions nodrag nopan">
        <button type="button" className="icon-button" title={t('linear.refresh')} aria-label={t('linear.refresh')} disabled={loading}
          onClick={() => { setMoveError(null); refresh(); }}><RefreshCw size={17} aria-hidden="true" /></button>
        <button type="button" className="icon-button" title={t('linear.filters')} aria-label={t('linear.filters')} aria-expanded={filters}
          onClick={() => setFilters(!filters)}><SlidersHorizontal size={17} aria-hidden="true" /></button>
      </div>
      {filters && <LinearFilters data={data} onSave={(scope) => { setFilters(false); onSave(scope); }} />}
    </header>
    <LinearFeedback error={moveError || error} loading={loading} snapshot={snapshot} onSettings={onOpenLinearSettings} />
    <LinearColumns columns={columns} t={t} busy={moving} dragging={dragging} dropTarget={dropTarget} loaded={!!snapshot} onMove={move} onDrag={onDrag}
      onDragOver={(event, status) => {
        if (!dragging || !event.dataTransfer.types.includes(LINEAR_ISSUE_DRAG)) return;
        event.preventDefault();
        event.stopPropagation();
        const allowed = !moving && status !== dragging.status;
        event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
        setDropTarget(allowed ? status : null);
      }} onDragLeave={() => setDropTarget(null)}
      onDrop={(event, status) => {
        if (!dragging || event.dataTransfer.getData(LINEAR_ISSUE_DRAG) !== dragging.id) return;
        event.preventDefault();
        event.stopPropagation();
        const issue = columns[dragging.status].find(({ id }) => id === dragging.id);
        onDrag(null);
        if (issue) void move(issue, status);
      }} />
  </>;
}

export default function LinearBoardNode({ id, data, selected }) {
  const { linkSource, tool } = useBoard();
  const { updateNodeData } = useReactFlow();
  return <section className={`linear-board-node${selected ? ' selected' : ''}${linkSource === id ? ' link-source' : ''}`}>
    <Handle type="source" position={Position.Right} isConnectable={tool === 'select'} />
    <LinearBoardContent key={`${data.projectId ?? ''}/${data.teamId ?? ''}`} id={id} data={data}
      onSave={(scope) => updateNodeData(id, scope, { replace: true })} />
  </section>;
}
