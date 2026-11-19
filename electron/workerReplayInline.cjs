const words = new Intl.Segmenter('und', { granularity: 'word' });
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const bom = Buffer.from([0xef, 0xbb, 0xbf]);

function readLine(bytes, range) {
  if (!range) return null;
  const [start, end] = range;
  const raw = bytes.subarray(start, end);
  const prefix = start === 0 && raw.subarray(0, bom.length).equals(bom) ? bom : Buffer.alloc(0);
  const newline = raw.at(-1) === 10;
  const ending = raw.subarray(raw.length - (newline ? raw.at(-2) === 13 ? 2 : 1 : 0));
  return { prefix, ending, text: raw.subarray(prefix.length, raw.length - ending.length).toString('utf8') };
}

function sequenceMatches(before, after) {
  const width = after.length + 1;
  if ((before.length + 1) * width > 160_000) return [];
  const lengths = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const index = i * width + j;
      lengths[index] = before[i] === after[j]
        ? 1 + lengths[index + width + 1]
        : Math.max(lengths[index + width], lengths[index + 1]);
    }
  }
  const matches = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const index = i * width + j;
    if (before[i] === after[j]) matches.push([i++, j++]);
    else if (lengths[index + width] >= lengths[index + 1]) i++;
    else j++;
  }
  return matches;
}

function createInlineReview(before, after, edits, group) {
  const original = readLine(before, edits[group.removed]?.from);
  const target = readLine(after, edits[group.added]?.to);
  const tokens = (line) => [...words.segment(line?.text ?? '')].map(({ segment }) => segment);
  const left = tokens(original);
  const right = tokens(target);
  const parts = [];
  const pieces = [];
  const piece = (kind, text) => {
    if (!text) return;
    const index = parts.length;
    parts.push({ index, kind, text });
    pieces.push({ text, index, kind });
  };
  const changed = (beforeText, afterText) => {
    const a = [...graphemes.segment(beforeText)].map(({ segment }) => segment);
    const b = [...graphemes.segment(afterText)].map(({ segment }) => segment);
    let start = 0;
    let end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    if (start) pieces.push({ text: a.slice(0, start).join('') });
    piece('remove', a.slice(start, a.length - end).join(''));
    piece('add', b.slice(start, b.length - end).join(''));
    if (end) pieces.push({ text: a.slice(-end).join('') });
  };
  let i = 0;
  let j = 0;
  for (const [a, b] of [...sequenceMatches(left, right), [left.length, right.length]]) {
    changed(left.slice(i, a).join(''), right.slice(j, b).join(''));
    if (a < left.length) pieces.push({ text: left[a] });
    i = a + 1;
    j = b + 1;
  }
  return { group, parts, pieces, original, target };
}

function validateInlineRanges(parts, ranges) {
  if (!Array.isArray(ranges) || ranges.length > parts.reduce((length, part) => length + part.text.length, 0)) return null;
  const selected = new Map();
  for (const range of ranges) {
    const { index, start, end } = range ?? {};
    const part = Number.isSafeInteger(index) && parts[index];
    if (!part || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end <= start || end > part.text.length) return null;
    if (!selected.has(index)) selected.set(index, []);
    selected.get(index).push({ start, end });
  }
  for (const [index, intervals] of selected) {
    const text = parts[index].text;
    const boundaries = new Set([text.length]);
    for (const segment of graphemes.segment(text)) boundaries.add(segment.index);
    const merged = [];
    for (const { start, end } of intervals.sort((a, b) => a.start - b.start)) {
      const previous = merged.at(-1);
      if (!boundaries.has(start) || !boundaries.has(end) || (previous && start < previous.end)) return null;
      if (previous?.end === start) previous.end = end;
      else merged.push({ start, end });
    }
    selected.set(index, merged);
  }
  return selected;
}

function projectInlineLine({ original, target, pieces }, selected) {
  const text = pieces.map(({ text: content, index, kind }) => {
    if (index === undefined) return content;
    const ranges = selected.get(index) ?? [];
    if (kind === 'add') return ranges.map(({ start, end }) => content.slice(start, end)).join('');
    const retained = [];
    let offset = 0;
    for (const { start, end } of ranges) {
      retained.push(content.slice(offset, start));
      offset = end;
    }
    retained.push(content.slice(offset));
    return retained.join('');
  }).join('');
  if (!text && (!original || !target)) return null;
  const { prefix, ending } = original ?? target;
  return { bytes: Buffer.concat([prefix, Buffer.from(text), ending]), bom: prefix.length !== 0 };
}

module.exports = { createInlineReview, validateInlineRanges, projectInlineLine, sequenceMatches };
