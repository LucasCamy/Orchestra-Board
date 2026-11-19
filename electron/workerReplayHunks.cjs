const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const lf = Buffer.from('\n');
const crlf = Buffer.from('\r\n');
const hasBom = (bytes) => bytes.subarray(0, bom.length).equals(bom);

function lineOffsets(bytes, ranges) {
  const boundaries = [...new Set(ranges.flat())].sort((a, b) => a - b);
  const offsets = new Map();
  let line = 0;
  let offset = 0;
  for (const boundary of boundaries) {
    while (line < boundary) {
      if (offset === bytes.length) return null;
      const next = bytes.indexOf(10, offset);
      offset = next === -1 ? bytes.length : next + 1;
      line++;
    }
    offsets.set(boundary, offset);
  }
  return offsets;
}

function applyReplayLines(before, after, edits, selected, overrides) {
  const included = new Set(selected);
  const parts = [];
  const originalBom = hasBom(before);
  const targetBom = hasBom(after);
  let keepBom = originalBom && targetBom;
  const originalEol = before.indexOf(10);
  const targetEol = after.indexOf(10);
  const separator = (originalEol !== -1 ? before[originalEol - 1] : after[targetEol - 1]) === 13 ? crlf : lf;
  const append = (bytes, start, end, withBom) => {
    if (start === end) return;
    if (start === 0 && withBom) {
      keepBom = true;
      start += bom.length;
    }
    if (start === end) return;
    // A retained EOF line can become an interior line when an addition is selected independently.
    if (parts.length && parts.at(-1).at(-1) !== 10) parts.push(separator);
    parts.push(bytes.subarray(start, end));
  };
  let offset = 0;
  for (const [index, { from, to }] of edits.entries()) {
    append(before, offset, from[0], originalBom);
    if (overrides?.has(index)) {
      const line = overrides.get(index);
      if (line) append(line.bytes, 0, line.bytes.length, line.bom);
    } else {
      if (to && included.has(index)) append(after, to[0], to[1], targetBom);
      if (!to && !included.has(index)) append(before, from[0], from[1], originalBom);
    }
    offset = from[1];
  }
  append(before, offset, before.length, originalBom);
  return Buffer.concat(keepBom ? [bom, ...parts] : parts);
}

function lineRange(start, count = '1') {
  const length = Number(count);
  const first = Number(start) - Number(length > 0);
  return [first, first + length];
}

function inlineGroups(hunks) {
  const groups = new Map();
  for (const { rows } of hunks) {
    let removed = [];
    let added = [];
    const flush = () => {
      if (added.length && added.length === removed.length) {
        for (const [index, line] of added.entries()) groups.set(line, { removed: removed[index], added: line });
      } else {
        for (const line of removed) groups.set(line, { removed: line });
        for (const line of added) groups.set(line, { added: line });
      }
      removed = [];
      added = [];
    };
    for (const row of rows) {
      if (row.text[0] === '-') removed.push(row.index);
      if (row.text[0] === '+') added.push(row.index);
      if (row.text[0] === ' ') flush();
    }
    flush();
  }
  return groups;
}

function selectableReplayLines(before, after, { diff, truncated }) {
  if (truncated || !diff) return null;
  const chunks = diff.split(/\n(?=@@ )/);
  const hunks = [];
  const edits = [];
  let lastBefore = 0;
  let lastAfter = 0;
  for (const chunk of chunks) {
    const [caption, ...body] = chunk.split('\n');
    const match = header.exec(caption);
    if (!match) return null;
    const [startBefore, endBefore] = lineRange(match[1], match[2]);
    const [startAfter, endAfter] = lineRange(match[3], match[4]);
    if (startBefore < lastBefore || startAfter < lastAfter) return null;
    let oldLine = startBefore;
    let newLine = startAfter;
    const rows = [];
    const indexes = [];
    for (const text of body) {
      const row = { text };
      switch (text[0]) {
        case '-':
          row.index = edits.length;
          row.number = oldLine + 1;
          edits.push({ from: [oldLine, ++oldLine], to: null });
          indexes.push(row.index);
          break;
        case '+':
          row.index = edits.length;
          row.number = newLine + 1;
          edits.push({ from: [oldLine, oldLine], to: [newLine, ++newLine] });
          indexes.push(row.index);
          break;
        case ' ':
          oldLine++;
          newLine++;
          break;
        case '\\':
          break;
        default:
          return null;
      }
      rows.push(row);
    }
    if (!indexes.length || oldLine !== endBefore || newLine !== endAfter) return null;
    lastBefore = oldLine;
    lastAfter = newLine;
    hunks.push({ caption, rows, indexes });
  }
  if (!edits.length) return null;
  const from = lineOffsets(before, edits.map((item) => item.from));
  const to = lineOffsets(after, edits.flatMap((item) => item.to ? [item.to] : []));
  if (!from || !to) return null;
  const byteEdits = edits.map((item) => ({
    from: item.from.map((line) => from.get(line)),
    to: item.to && item.to.map((line) => to.get(line)),
  }));
  if (!applyReplayLines(before, after, byteEdits, byteEdits.keys()).equals(after) ||
      !applyReplayLines(before, after, byteEdits, []).equals(before)) return null;
  return { hunks, edits: byteEdits, groups: inlineGroups(hunks) };
}

module.exports = { applyReplayLines, selectableReplayLines };
