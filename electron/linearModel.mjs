export const LINEAR_BOARD_DRAG = 'application/x-orchestra-linear';
export const LINEAR_ISSUE_DRAG = 'application/x-orchestra-linear-issue';
export const LINEAR_DRAG_HANDLE = '.linear-board-header';
export const LINEAR_STATUSES = ['todo', 'inProgress', 'inReview', 'done'];
const BOARD_SIZE = { width: 960, height: 494 };

export function linearScopeId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return /^[\w-]{1,128}$/.test(id) ? id : '';
}

export function sanitizeLinearBoard(data) {
  const projectId = linearScopeId(data?.projectId);
  const teamId = linearScopeId(data?.teamId);
  return { ...(projectId && { projectId }), ...(teamId && { teamId }) };
}

export function createLinearBoardNode(center, id = 'linear-' + crypto.randomUUID()) {
  return {
    id,
    type: 'linearBoard',
    position: { x: center.x - BOARD_SIZE.width / 2, y: center.y - BOARD_SIZE.height / 2 },
    style: { ...BOARD_SIZE },
    dragHandle: LINEAR_DRAG_HANDLE,
    selected: true,
    data: {},
  };
}
