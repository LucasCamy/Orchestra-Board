const { selectableReplayLines } = require('./workerReplayHunks.cjs');
const { sequenceMatches } = require('./workerReplayInline.cjs');
const { StringDecoder } = require('node:string_decoder');

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const words = new Intl.Segmenter('und', { granularity: 'word' });
const MAX_CONFLICT_DETAILS = 12;
const MAX_EXCERPT_BYTES = 240;

function applyChanges(source, changes) {
  const chunks = [];
  let offset = 0;
  for (const { start, end, data } of changes) {
    chunks.push(source.subarray(offset, start), data);
    offset = end;
  }
  chunks.push(source.subarray(offset));
  return Buffer.concat(chunks);
}

function trimSharedText(source, change) {
  const before = source.subarray(change.start, change.end).toString('utf8');
  const after = change.data.toString('utf8');
  const segments = (value) => [...graphemes.segment(value)].map(({ segment }) => segment);
  const left = segments(before);
  const right = segments(after);
  let prefix = 0;
  let suffix = 0;
  const shortest = Math.min(left.length, right.length);
  while (prefix < shortest && left[prefix] === right[prefix]) prefix++;
  while (suffix < shortest && left.at(-1 - suffix) === right.at(-1 - suffix)) suffix++;
  if (prefix + suffix > shortest) return change;
  return {
    start: change.start + Buffer.byteLength(left.slice(0, prefix).join('')),
    end: change.end - Buffer.byteLength(left.slice(left.length - suffix).join('')),
    data: Buffer.from(right.slice(prefix, right.length - suffix).join('')),
    anchorStart: change.start,
    anchorEnd: change.end,
  };
}

function refineLine(source, change) {
  const before = source.subarray(change.start, change.end).toString('utf8');
  const after = change.data.toString('utf8');
  // Multi-line replacements need line anchors. Do not guess where a removed line belonged.
  if (before.slice(0, -1).includes('\n') || after.slice(0, -1).includes('\n')) return [change];
  const left = [...words.segment(before)].map(({ segment }) => segment);
  const right = [...words.segment(after)].map(({ segment }) => segment);
  const reverse = new Map(sequenceMatches(left.toReversed(), right.toReversed())
    .map(([i, j]) => [left.length - 1 - i, right.length - 1 - j]));
  // Stable word anchors isolate independent edits even when matching letters within a word is ambiguous.
  const anchors = sequenceMatches(left, right).filter(([i, j]) => reverse.get(i) === j);
  const refined = [];
  let row = 0;
  let column = 0;
  let start = change.start;
  for (const [i, j] of [...anchors, [left.length, right.length]]) {
    const end = start + Buffer.byteLength(left.slice(row, i).join(''));
    if (row !== i || column !== j) {
      // Keep a replacement between anchors whole so a conflict cannot leave a hybrid word behind.
      refined.push(trimSharedText(source, { start, end, data: Buffer.from(right.slice(column, j).join('')) }));
    }
    start = end + Buffer.byteLength(left[i] ?? '');
    row = i + 1;
    column = j + 1;
  }
  return refined;
}

function refineChange(source, change) {
  const split = (bytes) => bytes.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = split(source.subarray(change.start, change.end));
  const right = split(change.data);
  if (left.length !== right.length || left.length < 2) return refineLine(source, change);
  const changes = [];
  let start = change.start;
  for (const [index, line] of left.entries()) {
    const end = start + Buffer.byteLength(line);
    if (line !== right[index]) changes.push(...refineLine(source, { start, end, data: Buffer.from(right[index]) }));
    start = end;
  }
  return changes;
}

function replayChanges(before, after, diff) {
  if (before.equals(after)) return [];
  const catalog = selectableReplayLines(before, after, diff);
  if (!catalog) return null;
  const groups = [];
  for (const { from: [start, end], to } of catalog.edits) {
    const data = to ? after.subarray(to[0], to[1]) : Buffer.alloc(0);
    const previous = groups.at(-1);
    if (previous?.end === start) {
      previous.end = end;
      previous.parts.push(data);
    } else groups.push({ start, end, parts: [data] });
  }
  const changes = [];
  for (const { start, end, parts } of groups) {
    const data = Buffer.concat(parts);
    if (start === end || !data.length) {
      const moved = start === end ? data : before.subarray(start, end);
      // Identical neighbouring lines make the original position of an insertion or deletion ambiguous.
      if (moved.equals(before.subarray(Math.max(0, start - moved.length), start)) ||
          moved.equals(before.subarray(end, end + moved.length))) return null;
    }
    changes.push(...refineChange(before, { start, end, data }));
  }
  return applyChanges(before, changes).equals(after) ? changes : null;
}

function insertionOverlaps({ start, anchorStart = start, anchorEnd = start }, replacement) {
  if (start === replacement.start || start === replacement.end) {
    // An insertion attached to a replaced word conflicts even at the edge of the replacement.
    return anchorStart < replacement.end && replacement.start < anchorEnd;
  }
  return replacement.start < start && start < replacement.end;
}

function overlap(a, b) {
  if (a.start === a.end) return b.start === b.end ? a.start === b.start : insertionOverlaps(a, b);
  if (b.start === b.end) return insertionOverlaps(b, a);
  return a.start < b.end && b.start < a.end;
}

function replayExcerpt(bytes) {
  if (bytes.length <= MAX_EXCERPT_BYTES) return bytes.toString('utf8');
  return new StringDecoder('utf8').write(bytes.subarray(0, MAX_EXCERPT_BYTES)) + '…';
}

const editOrder = (a, b) => a.start - b.start || a.end - b.end;

function conflictRegions(base, ordered, conflicts) {
  const groups = [];
  for (const conflict of conflicts.sort(editOrder)) {
    const previous = groups.at(-1);
    if (previous && conflict.start <= previous.end) {
      previous.end = Math.max(previous.end, conflict.end);
      previous.intended.push(...conflict.intended);
      for (const edit of conflict.local) previous.local.add(edit);
    } else groups.push(conflict);
  }
  let index = 0;
  let delta = 0;
  let line = 1;
  let lineOffset = 0;
  return groups.map(({ start, end, local, intended }) => {
    const take = () => {
      const edit = ordered[index++];
      delta += edit.data.length - (edit.end - edit.start);
      return edit;
    };
    while (index < ordered.length && ordered[index].end <= start && !local.has(ordered[index])) take();
    const projectedStart = start + delta;
    const selected = [...intended];
    while (index < ordered.length && (ordered[index].start < end || local.has(ordered[index]))) {
      const edit = take();
      if (!local.has(edit)) selected.push(edit);
    }
    for (; lineOffset < start; lineOffset++) if (base[lineOffset] === 10) line++;
    return { start: projectedStart, end: end + delta, line,
      selected: applyChanges(base.subarray(start, end), selected.sort(editOrder)
        .map((edit) => ({ start: edit.start - start, end: edit.end - start, data: edit.data }))) };
  });
}

function mergeReplayChanges(base, local, intended, describeConflicts = false) {
  if (!local || !intended) return null;
  const extra = [];
  const overlapping = [];
  let conflicts = 0;
  let first = 0;
  for (const change of intended) {
    while (first < local.length && local[first].end < change.start) first++;
    const touching = [];
    for (let index = first; index < local.length && local[index].start <= change.end; index++) {
      if (overlap(change, local[index])) touching.push(local[index]);
    }
    if (touching.length === 1 && touching[0].start === change.start && touching[0].end === change.end &&
        touching[0].data.equals(change.data)) continue;
    if (touching.length) {
      conflicts++;
      if (describeConflicts) overlapping.push({ start: Math.min(change.start, touching[0].start),
        end: Math.max(change.end, touching.at(-1).end), local: new Set(touching), intended: [change] });
    } else extra.push(change);
  }
  const ordered = [...local, ...extra].sort(editOrder);
  const data = applyChanges(base, ordered);
  if (!describeConflicts) return { data, conflicts };
  const regions = conflictRegions(base, ordered, overlapping);
  const details = regions.slice(0, MAX_CONFLICT_DETAILS).map(({ start, end, line, selected }) => ({
    line, local: replayExcerpt(data.subarray(start, end)), selected: replayExcerpt(selected),
  }));
  return { data, conflicts: regions.length, details, regions };
}

module.exports = { replayChanges, mergeReplayChanges, applyChanges, MAX_CONFLICT_DETAILS };
