export function parseLyrics(input) {
  if (input.trimStart().startsWith('{')) {
    let data;
    try { data = JSON.parse(input); }
    catch { throw new Error('同步歌词 JSON 不完整，请复制页面返回的全部内容。'); }
    input = data?.syncedLyrics || data?.plainLyrics;
    if (typeof input !== 'string' || !input.trim()) throw new Error('这个 JSON 里没有可导入的歌词。');
  }
  const lines = [];
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(input)?.[1] || 0) / 1000;
  for (const raw of input.split(/\r?\n/)) {
    const timestamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;
    if (text.length > 500) throw new Error('每句歌词最多 500 字。');
    const starts = timestamps.length ? timestamps.map(match => Math.max(0, Number(match[1]) * 60 + Number(match[2]) + offset)) : [null];
    for (const start of starts) lines.push({ text, start, end: null, words: segmentWords(text) });
  }
  if (lines.length > 400) throw new Error('每次最多导入 400 句。');
  if (lines.every(line => line.start !== null)) lines.sort((a, b) => a.start - b.start);
  lines.forEach((line, index) => {
    if (line.start !== null) line.end = lines.slice(index + 1).find(next => next.start !== null && next.start > line.start)?.start ?? null;
  });
  return lines;
}

const segmenter = new Intl.Segmenter('zh-HK', { granularity: 'word' });

export function segmentWords(text, readings = [], manual = false) {
  const parts = manual ? text.trim().split(/\s+/) : [...segmenter.segment(text)].map(item => item.segment);
  const characters = readings.flatMap(([word, reading]) => [...word].map((character, i) => ({ character, reading: reading?.split(' ')[i] || '' })));
  let cursor = 0;
  return parts.filter(part => part.trim()).map(text => {
    while (characters[cursor] && /\s/.test(characters[cursor].character)) cursor++;
    const pronunciation = characters.slice(cursor, cursor + [...text].length).map(item => item.reading).filter(Boolean).join(' ');
    cursor += [...text].length;
    return { text, jyutping: pronunciation };
  });
}

// Keep a mark attached to the same characters when a learner edits word boundaries.
export function carryWordPractice(before, after) {
  let end = 0;
  const spans = before.map(word => {
    const start = end;
    end += word.text.length;
    return { start, end, word };
  });
  let start = 0;
  return after.map(word => {
    const end = start + word.text.length;
    const overlap = spans.filter(span => span.start < end && start < span.end);
    const exact = overlap.find(span => span.start === start && span.end === end && span.word.text === word.text);
    start = end;
    if (exact) return { ...word, ...exact.word };
    const reviews = overlap.map(span => span.word.review).filter(Boolean);
    if (reviews.length) return { ...word, review: { ...reviews.reduce((a, b) => a.due <= b.due ? a : b) } };
    return word;
  });
}

function wordSpans(words) {
  let offset = 0;
  return words.map(word => {
    const start = offset;
    offset += word.text.length;
    return { start, end: offset, word };
  });
}

export function practiceWords(line) {
  return line.markedTerms?.length ? [...line.words, ...line.markedTerms] : line.words;
}

// Keep both rows together at shared boundaries even when an old reading spans
// multiple words, or one spoken word spans multiple saved readings.
export function playbackGroups(line) {
  const readings = wordSpans(line.words);
  const savedText = line.words.map(word => word.text).join('');
  const source = line.text?.replace(/\s/g, '') === savedText ? line.text : savedText;
  const terms = wordSpans(segmentWords(source));
  const readingsByStart = new Map(readings.map(span => [span.start, span]));
  const marksByStart = new Map((line.markedTerms || []).map(word => [word.start, word]));
  const readingEnds = new Set(readings.map(span => span.end));
  const groups = [];
  let pendingTerms = [];
  let readingIndex = 0;
  for (const term of terms) {
    const reading = readingsByStart.get(term.start);
    const mark = marksByStart.get(term.start);
    if (reading?.end === term.end) term.word = reading.word;
    else if (mark?.text === term.word.text) term.word = mark;
    pendingTerms.push(term);
    if (!readingEnds.has(term.end)) continue;
    const first = readingIndex;
    while (readingIndex < readings.length && readings[readingIndex].end <= term.end) readingIndex++;
    groups.push({ terms: pendingTerms, readings: readings.slice(first, readingIndex) });
    pendingTerms = [];
  }
  return groups;
}

export function reconcileTermMarks(line) {
  if (!line.markedTerms?.length) return;
  const spans = wordSpans(line.words);
  line.markedTerms = line.markedTerms.filter(mark => {
    const match = spans.find(span => span.start === mark.start && span.word.text === mark.text);
    if (!match) return true;
    match.word.review = mark.review;
    return false;
  });
}

export function dueWords(song, now = Date.now()) {
  return song.lines.flatMap((line, lineIndex) => practiceWords(line).flatMap((word, wordIndex) =>
    word.review?.due <= now ? [{ lineIndex, wordIndex }] : []));
}

const intervals = [1, 3, 7, 14, 30];
export function nextWordReview(previous, remembered, now = Date.now()) {
  if (!remembered) return { step: 0, due: now };
  const step = Math.min(previous?.step || 0, intervals.length - 1);
  const date = new Date(now);
  date.setDate(date.getDate() + intervals[step]);
  date.setHours(0, 0, 0, 0);
  return { step: Math.min(step + 1, intervals.length - 1), due: date.getTime() };
}
