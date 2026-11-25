export const libraryKey = 'golingo-library-v1';

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readStoredValue(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function hasLyrics(value) {
  return Array.isArray(value?.lines) && value.lines.length > 0 &&
    value.lines.every(line => trimmedString(line?.text));
}

function normalizeProgress(song) {
  const lastIndex = song.lines.length - 1;
  const index = Number.isInteger(song.index) ? Math.max(0, Math.min(song.index, lastIndex)) : 0;
  const validIndexes = values => Array.isArray(values)
    ? [...new Set(values.filter(value => Number.isInteger(value) && value >= 0 && value <= lastIndex))]
    : [];
  return { ...song, index, done: validIndexes(song.done), difficult: validIndexes(song.difficult) };
}

export function loadLibrary(storage, sampleLines) {
  const saved = readStoredValue(storage, libraryKey);
  const ids = new Set();
  const songs = [];
  for (const song of Array.isArray(saved?.songs) ? saved.songs : []) {
    const id = trimmedString(song?.id);
    const title = trimmedString(song?.title);
    if (!id || !title || ids.has(id) || !hasLyrics(song)) continue;
    ids.add(id);
    songs.push(normalizeProgress({ ...song, id, title, artist: trimmedString(song.artist) }));
  }
  if (songs.length) {
    const activeId = ids.has(saved.activeId) ? saved.activeId : songs[0].id;
    return { activeId, songs };
  }

  const legacy = readStoredValue(storage, 'golingo-v1');
  const previous = hasLyrics(legacy) ? legacy : { lines: structuredClone(sampleLines) };
  const song = normalizeProgress({
    id: 'legacy-song',
    title: '葡萄成熟时',
    artist: '陈奕迅',
    lines: previous.lines,
    index: previous.index,
    done: previous.done,
    difficult: previous.difficult,
    demo: !hasLyrics(legacy) ||
      (previous.lines.length === 1 && previous.lines[0].text.trim() === '差不多冬至'),
  });
  return { activeId: song.id, songs: [song] };
}

export function readLyricsMetadata(input, filename = '') {
  const content = trimmedString(input);
  const fallbackTitle = trimmedString(filename).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim();
  let title = '';
  let artist = '';

  if (content.startsWith('{')) {
    try {
      const data = JSON.parse(content);
      title = trimmedString(data?.trackName) || trimmedString(data?.name);
      artist = trimmedString(data?.artistName);
    } catch {
      // The lyrics parser reports malformed JSON during import.
    }
  } else {
    title = trimmedString(/\[ti\s*:([^\]]*)\]/i.exec(content)?.[1]);
    artist = trimmedString(/\[ar\s*:([^\]]*)\]/i.exec(content)?.[1]);
  }

  return { title: title || fallbackTitle, artist };
}
