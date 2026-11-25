import { Component, createRef, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Check, ChevronDown, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { LINEAR_ISSUE_DRAG, LINEAR_STATUSES, linearScopeId, sanitizeLinearBoard } from '../../electron/linearModel.mjs';
import { useBoard } from '../context/BoardContext.jsx';
import useLinearIssues from '../hooks/useLinearIssues.js';
import useT from '../hooks/useT.js';
import { LinearFeedback, LinearIssueCard, sortIssuesByHierarchy } from './LinearIssues.jsx';
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

function ScopeDropdown({
  label,
  value,
  onChange,
  items = [],
  allLabel,
  autoFocus = false,
  formatItem = (item) => ({ title: item.name, badge: item.state }),
}) {
  const t = useT();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customMode, setCustomMode] = useState(false);

  const selectedItem = items?.find((item) => item.id === value);
  const isCustomValue = Boolean(value && !selectedItem);

  useEffect(() => {
    if (isCustomValue) setCustomMode(true);
  }, [isCustomValue]);

  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const key = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  if (!items || items.length === 0) {
    return (
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          value={value}
          placeholder={t('linear.orCustomId')}
          maxLength={128}
          onChange={(event) => onChange(event.target.value)}
          autoFocus={autoFocus}
        />
      </label>
    );
  }

  if (customMode) {
    return (
      <div className="field">
        <div className="linear-field-header">
          <span className="field-label">{label}</span>
          <button
            type="button"
            className="linear-mode-toggle"
            onClick={() => {
              setCustomMode(false);
              onChange('');
            }}
          >
            {t('linear.chooseFromList')}
          </button>
        </div>
        <div className="linear-custom-input-wrap">
          <input
            value={value}
            placeholder={t('linear.orCustomId')}
            maxLength={128}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
          />
        </div>
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (!q) return true;
    const { title, badge } = formatItem(item);
    return title.toLowerCase().includes(q) || (badge && badge.toLowerCase().includes(q));
  });

  const display = selectedItem ? formatItem(selectedItem) : { title: allLabel, badge: null };

  return (
    <div className="field linear-scope-field" ref={ref}>
      <span className="field-label">{label}</span>
      <div className="linear-scope-control">
        <button
          type="button"
          className="linear-scope-trigger"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setSearch('');
          }}
        >
          <div className="linear-scope-trigger-content">
            <span className="linear-scope-label" title={display.title}>
              {display.title}
            </span>
            {display.badge && (
              <span className="linear-scope-badge" data-state={display.badge}>
                {display.badge}
              </span>
            )}
          </div>
          <ChevronDown size={14} className="linear-scope-chevron" aria-hidden="true" />
        </button>

        {open && (
          <div className="context-menu linear-scope-menu thin-scrollbar nodrag nopan nowheel">
            {items.length > 4 && (
              <div className="linear-scope-search">
                <Search size={13} aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  placeholder={t('linear.searchScopes')}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
                {search && (
                  <button
                    type="button"
                    className="icon-button linear-search-clear"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSearch('');
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
            <div className="linear-scope-list thin-scrollbar">
              <button
                type="button"
                className={`menu-item linear-scope-item${!value ? ' selected' : ''}`}
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                <span className="menu-label">{allLabel}</span>
                {!value && <Check size={14} className="linear-scope-check" />}
              </button>
              <div className="menu-separator" />
              {filtered.map((item) => {
                const { title, badge } = formatItem(item);
                const isSelected = item.id === value;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`menu-item linear-scope-item${isSelected ? ' selected' : ''}`}
                    onClick={() => {
                      onChange(item.id);
                      setOpen(false);
                    }}
                  >
                    <span className="menu-label" title={title}>
                      {title}
                    </span>
                    {badge && (
                      <span className="linear-scope-badge" data-state={badge}>
                        {badge}
                      </span>
                    )}
                    {isSelected && <Check size={14} className="linear-scope-check" />}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="linear-scope-empty">
                  {t('linear.searchEmpty') || '—'}
                </div>
              )}
              <div className="menu-separator" />
              <button
                type="button"
                className="menu-item linear-scope-item linear-scope-custom-action"
                onClick={() => {
                  setCustomMode(true);
                  setOpen(false);
                }}
              >
                <span className="menu-label">{t('linear.orCustomId')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LinearFilters({ data, onSave }) {
  const t = useT();
  const [projectId, setProjectId] = useState(data.projectId ?? '');
  const [teamId, setTeamId] = useState(data.teamId ?? '');
  const [scopes, setScopes] = useState(null);

  useEffect(() => {
    let active = true;
    window.linearBoard?.fetchScopes?.().then((res) => {
      if (active && !res?.error) setScopes(res);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const invalid = (projectId.trim() && !linearScopeId(projectId)) || (teamId.trim() && !linearScopeId(teamId));
  return <form className="linear-filters nodrag nopan nowheel" onSubmit={(event) => {
    event.preventDefault();
    if (!invalid) onSave(sanitizeLinearBoard({ projectId, teamId }));
  }}>
    <ScopeDropdown
      label={t('linear.projectId')}
      value={projectId}
      onChange={setProjectId}
      items={scopes?.projects}
      allLabel={t('linear.allProjects')}
      autoFocus
      formatItem={(p) => ({ title: p.name, badge: p.state })}
    />
    <ScopeDropdown
      label={t('linear.teamId')}
      value={teamId}
      onChange={setTeamId}
      items={scopes?.teams}
      allLabel={t('linear.allTeams')}
      formatItem={(tm) => ({
        title: tm.key ? `${tm.key} · ${tm.name}` : tm.name,
        badge: null,
      })}
    />
    <p className="hint">{t(invalid ? 'linear.error.invalidScope' : 'linear.filterHint')}</p>
    <div className="linear-filters-actions">
      <button type="submit" className="text-button" disabled={!!invalid}>{t('common.save')}</button>
    </div>
  </form>;
}

function LinearBoardContent({ id, data, onSave }) {
  const t = useT();
  const { boardId, prepareLinearMove, onOpenLinearSettings } = useBoard();
  const { snapshot, error, loading, refresh } = useLinearIssues(data);
  const [filters, setFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState(null);
  const rawColumns = snapshot?.columns ?? EMPTY_COLUMNS;
  const columns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return Object.fromEntries(LINEAR_STATUSES.map((status) => {
      const list = (rawColumns[status] ?? []).filter((issue) => {
        if (!q) return true;
        return issue.identifier.toLowerCase().includes(q) ||
          issue.title.toLowerCase().includes(q) ||
          (issue.parent?.identifier ?? '').toLowerCase().includes(q) ||
          (issue.projectName ?? '').toLowerCase().includes(q) ||
          (issue.assignee?.name ?? '').toLowerCase().includes(q);
      });
      return [status, sortIssuesByHierarchy(list)];
    }));
  }, [rawColumns, searchQuery]);

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
      <div className="linear-board-search nodrag nopan">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={searchQuery}
          placeholder="Filtrar issues..."
          onChange={(e) => setSearchQuery(e.target.value)}
        />
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
