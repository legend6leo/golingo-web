import {
  parseLyrics, segmentWords, carryWordPractice, dueWords, nextWordReview,
  playbackGroups, practiceWords, reconcileTermMarks,
} from './course.js?v=5';
import { libraryKey, loadLibrary, readLyricsMetadata } from './library.js';
import { createScorePanel } from './score-panel.js';

const $ = id => document.getElementById(id);
const hosted = Boolean(document.querySelector('meta[name="golingo-pages"]'));
const sample = [{ text: '差不多冬至', words: [
  { text: '差不多', jyutping: 'caa1 bat1 do1', meaning: '快到、接近' },
  { text: '冬至', jyutping: 'dung1 zi3', meaning: '冬至节气' },
] }];
const songPreviews = [
  { id: 'best-friend-preview', title: '最佳损友', artist: '陈奕迅', words: [
    { text: '最佳', jyutping: 'zeoi3 gaai1' }, { text: '损友', jyutping: 'syun2 jau5' },
  ], source: 'https://lrclib.net/api/get/3029588' },
  { id: 'chunjiao-preview', title: '春娇与志明', artist: '街道办GDC、欧阳耀莹', words: [
    { text: '春娇', jyutping: 'ceon1 giu1' }, { text: '与', jyutping: 'jyu5' }, { text: '志明', jyutping: 'zi3 ming4' },
  ], source: 'https://lrclib.net/api/get/7088699' },
  { id: 'sing-with-back-preview', title: '用背脊唱情歌', artist: 'Gareth.T', words: [
    { text: '用', jyutping: 'jung6' }, { text: '背脊', jyutping: 'bui3 zek3' },
    { text: '唱', jyutping: 'coeng3' }, { text: '情歌', jyutping: 'cing4 go1' },
  ], source: 'https://lrclib.net/api/get/22592143' },
];
const library = loadLibrary(localStorage, sample);
for (const preview of songPreviews) {
  if (library.songs.some(song => titleKey(song.title) === titleKey(preview.title))) continue;
  library.songs.push({
    id: preview.id, title: preview.title, artist: preview.artist, demo: true,
    lines: [{ text: preview.title, words: preview.words }], index: 0, done: [], difficult: [],
  });
}
let state = library.songs.find(song => song.id === library.activeId);
const voiceSelect = $('voice');
const voicePreferenceKey = 'golingo-voice-v1';
try {
  $('roman').checked = localStorage.getItem('golingo-show-jyutping') !== 'false';
  const savedVoice = localStorage.getItem(voicePreferenceKey);
  if ([...voiceSelect.options].some(option => option.value === savedVoice)) voiceSelect.value = savedVoice;
} catch {}
let selected = null;
let reviewQueue = [];
let recordingRequest = 0;
let generation = 0;
let playback = null;
let reading = false;
let loopTimer;
let recorder;
let recordingUrl;
let latestTake = 0;
let prepareJob = null;
const speechUrls = new Map();
const message = text => $('status').textContent = text;
const visibleIndex = () => reviewQueue[0]?.lineIndex ?? state.index;
const current = () => state.lines[visibleIndex()];
const scorePanel = createScorePanel({
  speechUrl,
  useTakeFile(file) {
    stopPracticeAudio();
    latestTake++;
    showRecording(file, current(), state.title);
  },
});
function updateScoreContext() {
  scorePanel.updateContext(current(), voiceSelect.value, voiceSelect.selectedOptions[0].textContent, Number($('rate').value));
}

function stopPracticeAudio() {
  stop(false);
  recordingRequest++;
  if (recorder?.state === 'recording') recorder.stop();
}

function save() {
  try {
    localStorage.setItem(libraryKey, JSON.stringify(library));
    return true;
  } catch {
    message('设备存储空间不足，曲库或进度暂时无法保存。');
    return false;
  }
}
function stop(announce = true) {
  generation++;
  clearTimeout(loopTimer);
  resetReading();
  $('recording').querySelector('audio')?.pause();
  $('referencePreview')?.pause();
  if (announce) message('播放已停止');
}
function resetReading() {
  reading = false;
  if (!playback) return;
  playback.onended = null;
  playback.onerror = null;
  playback.pause();
  playback = null;
}
function scheduleRepeat(action, token) {
  if ($('loop').checked) loopTimer = setTimeout(() => {
    if (generation === token && $('loop').checked) action();
  }, 1800);
}
async function api(route, body) {
  if (hosted) {
    const { pagesApi } = await import('./pages-api.js');
    return pagesApi(route, body);
  }
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '处理失败，请重试。');
  return data;
}
async function speechUrl(text, voice) {
  const key = JSON.stringify([voice, text]);
  if (speechUrls.has(key)) return speechUrls.get(key);
  const data = await api('/api/speech', { text, voice });
  speechUrls.set(key, data.url);
  return data.url;
}
async function speak(text, lineIndex = null) {
  if (recorder?.state === 'recording') return message('请先结束录音，再播放示范。');
  stop(false);
  const token = generation;
  reading = true;
  message('正在准备粤语朗读…');
  try {
    const url = await speechUrl(text, voiceSelect.value);
    if (token !== generation) return;
    const audio = new Audio(url);
    playback = audio;
    audio.playbackRate = Number($('rate').value);
    audio.preservesPitch = true;
    audio.onerror = () => { if (token === generation) message('朗读文件加载失败，点词可重试。'); };
    audio.onended = () => {
      if (token !== generation) return;
      playback = null;
      if (lineIndex !== null) {
        const nextIndex = lineIndex + 1;
        reading = nextIndex < state.lines.length;
        if (!reading) return message('已读到最后一句。');
        message('轮到你了，跟读后会自动播放下一句。');
        loopTimer = setTimeout(() => {
          if (generation !== token) return;
          showLine(nextIndex);
          speak(state.lines[nextIndex].text, nextIndex);
        }, Number($('followPause').value) * 1000);
        return;
      }
      reading = $('loop').checked;
      message('轮到你了，跟着读一遍。');
      scheduleRepeat(() => speak(text), token);
    };
    await audio.play();
    if (token === generation) message('正在播放粤语朗读');
  } catch (error) {
    if (token !== generation) return;
    resetReading();
    message(error.message || '朗读播放失败，请重试。');
  }
}
function navigate(index) {
  stopPracticeAudio();
  reviewQueue = [];
  showLine(index);
  message('');
}
function showLine(index) {
  state.index = index;
  selected = null;
  save();
  render();
}
function openSong(song) {
  if (song.id === state.id) return;
  stopPracticeAudio();
  if (prepareJob) prepareJob.canceled = true;
  $('prepareStatus').textContent = '';
  $('lyricDirectory').open = false;
  state = song;
  library.activeId = song.id;
  beginPractice();
  save();
  if (hosted && song.demo) loadCompleteSong();
}
function beginPractice() {
  selected = null;
  reviewQueue = dueWords(state);
  render();
  message('');
}
function startReview() {
  stopPracticeAudio();
  beginPractice();
  if (reviewQueue.length) $('reviewHeading').focus();
}
function leaveReview(note) {
  stopPracticeAudio();
  reviewQueue = [];
  selected = null;
  render();
  message(note);
  $('speak').focus({ preventScroll: true });
}
function rateWord(remembered) {
  const item = reviewQueue[0];
  if (!item) return;
  const word = practiceWords(current())[item.wordIndex];
  const previous = word.review;
  word.review = nextWordReview(previous, remembered);
  if (!save()) { word.review = previous; return; }
  stopPracticeAudio();
  reviewQueue.shift();
  if (!remembered && !item.retried) reviewQueue.push({ ...item, retried: true });
  const note = remembered ? `「${word.text}」下次复习：${formatDue(word.review.due)}。` :
    item.retried ? `「${word.text}」下次打开再练。` : `「${word.text}」本轮再练一次。`;
  if (!reviewQueue.length) return leaveReview(`本轮复习完成。${note}`);
  selected = null;
  render();
  message(note);
  $('reviewHeading').focus({ preventScroll: true });
}
const formatDue = time => new Date(time).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
function renderReview() {
  const item = reviewQueue[0];
  const inReview = Boolean(item);
  $('reviewHeader').hidden = $('reviewFooter').hidden = !inReview;
  $('lessonFooter').hidden = $('startRead').hidden = $('lyricsTools').hidden = $('difficult').hidden = inReview;
  const marked = state.lines.flatMap(practiceWords).filter(word => word.review);
  $('reviewEntry').hidden = inReview || !marked.length;
  if (item) {
    $('reviewHeading').textContent = `难词复习 · ${practiceWords(current())[item.wordIndex].text}`;
    $('reviewPrompt').textContent = `把标出的词放回这句唱一遍。本轮还剩 ${reviewQueue.length} 个。`;
  } else if (marked.length) {
    const count = dueWords(state).length;
    $('startReview').hidden = !count;
    $('startReview').textContent = `收尾复习 · ${count} 个难词`;
    $('reviewDate').textContent = count ? '' : `下次难词复习 · ${formatDue(Math.min(...marked.map(word => word.review.due)))}`;
  }
}
$('startReview').onclick = startReview;
$('leaveReview').onclick = () => leaveReview('');
$('remembered').onclick = () => rateWord(true);
$('again').onclick = () => rateWord(false);
function renderLibrary() {
  const list = $('songList');
  const focusId = list.contains(document.activeElement) ? document.activeElement.dataset.songId : null;
  list.replaceChildren();
  library.songs.forEach(song => {
    const button = document.createElement('button');
    button.className = 'song-item';
    button.dataset.songId = song.id;
    if (song.id === state.id) button.setAttribute('aria-current', 'true');
    const title = document.createElement('strong');
    title.textContent = song.title;
    const progress = document.createElement('small');
    progress.textContent = [song.artist, song.demo ? '试读 · 待导入完整歌词' : `已练 ${song.done.length}/${song.lines.length} 句`].filter(Boolean).join(' · ');
    button.append(title, progress);
    button.onclick = () => openSong(song);
    list.append(button);
    if (song.id === focusId) button.focus({ preventScroll: true });
  });
}
function renderWordTools() {
  const chosen = selected?.word;
  const hint = $('roman').checked ? '点汉字听词语，点下方粤拼听对应读音。' : '点汉字听词语，再点标记可加入难词。';
  $('meaning').textContent = chosen?.meaning || (!reviewQueue.length && !chosen ? hint : '');
  $('markWord').hidden = !chosen || Boolean(reviewQueue.length);
  if (chosen) $('markWord').textContent = chosen.review ? `移除难词「${chosen.text}」` : `标记难词「${chosen.text}」`;
}

function renderWords() {
  const list = $('words');
  const line = current();
  const target = reviewQueue.length ? practiceWords(line)[reviewQueue[0].wordIndex] : null;
  const groups = playbackGroups(line);
  const targetSpan = target && groups.flatMap(group => [...group.terms, ...group.readings]).find(span => span.word === target);
  list.replaceChildren();
  for (const group of groups) {
    const pair = document.createElement('div');
    pair.className = 'word-pair';
    for (const [row, spans] of Object.entries(group)) {
      if (row === 'readings' && !$('roman').checked) continue;
      const strip = document.createElement('div');
      strip.className = row;
      for (const span of spans) {
        const word = span.word;
        const label = row === 'terms' ? word.text : word.jyutping;
        if (!label) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = row === 'terms' ? 'word' : 'reading';
        button.textContent = label;
        button.setAttribute('aria-label', row === 'terms' ? `听词语「${label}」` : `听粤拼「${label}」`);
        button.classList.toggle('marked', Boolean(word.review));
        button.classList.toggle('target', word === target || Boolean(row === 'terms' && targetSpan && span.start < targetSpan.end && span.end > targetSpan.start));
        button.classList.toggle('selected', selected?.row === row && selected.start === span.start);
        if (word.review) button.setAttribute('aria-description', '已标为难词');
        button.onclick = () => {
          selected = { word, start: span.start, row };
          list.querySelector('.selected')?.classList.remove('selected');
          button.classList.add('selected');
          renderWordTools();
          speak(word.text);
        };
        strip.append(button);
      }
      if (strip.childElementCount) pair.append(strip);
    }
    list.append(pair);
  }
  renderWordTools();
}

function render() {
  updateScoreContext();
  renderLibrary();
  renderReview();
  $('songTitle').textContent = state.title;
  $('songSubtitle').textContent = [state.artist, '粤语歌词跟读'].filter(Boolean).join(' · ');
  const preview = songPreviews.find(song => titleKey(song.title) === titleKey(state.title));
  const source = $('lyricsSource');
  const lyricsUrl = preview?.source ?? (titleKey(state.title) === '葡萄成熟时' ? 'https://lrclib.net/api/get/3029372' : null);
  source.hidden = !lyricsUrl;
  if (lyricsUrl) {
    source.href = lyricsUrl;
    source.textContent = `《${state.title}》同步歌词来源`;
  }
  $('completeSong').hidden = !state.demo;
  $('directoryLabel').textContent = `歌词目录 · ${state.lines.length} 句`;
  $('lessons').replaceChildren();
  state.lines.forEach((line, index) => {
    const button = document.createElement('button');
    button.textContent = `${state.difficult.includes(index) ? '待练 · ' : state.done.includes(index) ? '已练习 · ' : ''}${line.text}`;
    if (index === visibleIndex()) {
      button.className = 'active';
      button.setAttribute('aria-current', 'true');
    }
    button.onclick = () => navigate(index);
    $('lessons').append(button);
  });
  renderWords();
  $('count').textContent = `第 ${visibleIndex() + 1} 句 / 共 ${state.lines.length} 句 · 已练习 ${state.done.length} 句`;
  $('progress').max = state.lines.length;
  $('progress').value = state.done.length;
  $('prev').disabled = state.index === 0;
  $('next').disabled = state.index === state.lines.length - 1;
  $('difficult').textContent = state.difficult.includes(state.index) ? '从待练移除整句' : '整句加入待练';
  $('segments').value = current().words.map(word => word.text).join(' ');
  $('pronunciations').value = current().words.map(word => word.jyutping || '').join('\n');
}
$('speak').onclick = () => { selected = null; render(); speak(current().text); };
$('startRead').onclick = () => { selected = null; render(); speak(current().text, state.index); };
$('stop').onclick = () => stop();
$('roman').onchange = () => {
  render();
  try { localStorage.setItem('golingo-show-jyutping', String($('roman').checked)); }
  catch { message('粤拼显示已切换，本次设置暂时无法保存。'); }
};
$('markWord').onclick = () => {
  const line = current();
  const word = selected?.word;
  if (!word || reviewQueue.length) return;
  const previous = word.review;
  const previousTerms = line.markedTerms;
  if (previous) delete word.review;
  else word.review = nextWordReview(null, false);
  if (!line.words.includes(word)) {
    word.start = selected.start;
    line.markedTerms = previous ? previousTerms.filter(mark => mark !== word) : [...(previousTerms || []), word];
  }
  if (!save()) {
    if (previous) word.review = previous; else delete word.review;
    line.markedTerms = previousTerms;
    return;
  }
  render();
  message(previous ? `已移除「${word.text}」。` : `已标记「${word.text}」，收尾时可以复习。`);
};
let selectedVoice = voiceSelect.value;
function updateVoice() {
  if (selectedVoice === voiceSelect.value) return;
  selectedVoice = voiceSelect.value;
  updateScoreContext();
  if (reading) {
    generation++;
    clearTimeout(loopTimer);
    resetReading();
  }
  if (recorder?.state !== 'recording') message(`已选择${voiceSelect.selectedOptions[0].textContent}，点词或整句试听。`);
  try { localStorage.setItem(voicePreferenceKey, selectedVoice); }
  catch { message('本次可以切换音色，浏览器暂时无法保存选择。'); }
}
voiceSelect.addEventListener('input', updateVoice);
voiceSelect.addEventListener('change', updateVoice);
$('rate').onchange = () => {
  if (playback) playback.playbackRate = Number($('rate').value);
  updateScoreContext();
};
$('prev').onclick = () => navigate(state.index - 1);
$('next').onclick = () => navigate(state.index + 1);
$('done').onclick = () => {
  if (!state.done.includes(state.index)) state.done.push(state.index);
  if (!save()) return;
  if (state.index < state.lines.length - 1) return navigate(state.index + 1);
  if (dueWords(state).length) return startReview();
  stopPracticeAudio();
  render();
  message('已练到最后一句。');
};
$('difficult').onclick = () => {
  const index = state.difficult.indexOf(state.index);
  if (index < 0) state.difficult.push(state.index); else state.difficult.splice(index, 1);
  save(); render();
};
async function annotate(lines) {
  const readings = await api('/api/annotate', { texts: lines.map(line => line.text) });
  return lines.map((line, index) => ({ ...line, readings: readings[index], words: segmentWords(line.text, readings[index]) }));
}
const importMessage = text => $('importStatus').textContent = text;
$('addSong').onclick = () => {
  if (reviewQueue.length) leaveReview('');
  $('lyricsTools').open = true;
  $('importTitle').focus();
};
function loadCompleteSong() {
  if (reviewQueue.length) leaveReview('');
  const originSong = state;
  const { title, artist } = state;
  const source = $('lyricsSource');
  $('lyricsTools').open = true;
  if (source.hidden) {
    $('importTitle').value = title;
    $('importArtist').value = artist;
    $('lyrics').focus();
    return;
  }
  const url = source.href;
  importSong(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('歌词来源暂时无法访问，可以稍后重试或手动导入。');
    return response.text();
  }, title, artist, originSong);
}
$('completeSong').onclick = loadCompleteSong;
function titleKey(text) {
  return text.trim().normalize('NFKC').toLowerCase()
    .replace(/^葡萄成熟時$/, '葡萄成熟时')
    .replace(/^最佳損友$/, '最佳损友')
    .replace(/^春嬌與志明$/, '春娇与志明');
}
async function importSong(loadInput, titleOverride, artistOverride, originSong = null) {
  const button = $('import');
  if (button.disabled) return;
  button.disabled = true;
  $('completeSong').disabled = true;
  importMessage('正在读取歌词…');
  try {
    const input = await loadInput();
    const parsed = parseLyrics(input);
    if (!parsed.length) return importMessage('请先选择歌词文件或粘贴歌词。');
    const metadata = readLyricsMetadata(input);
    const title = titleOverride || metadata.title;
    const artist = artistOverride || metadata.artist;
    if (!title) {
      $('importTitle').focus();
      return importMessage('请填写歌名，再添加到曲库。');
    }
    const existing = library.songs.find(song => {
      if (song.demo || titleKey(song.title) !== titleKey(title)) return false;
      if (!artist || !song.artist || song.artist === artist) return true;
      return song.lines.length === parsed.length && song.lines.every((line, index) => line.text === parsed[index].text);
    });
    if (existing) {
      if (!originSong || state === originSong) openSong(existing);
      return importMessage('曲库中已有这首歌，已打开保存的课程。');
    }
    importMessage(`正在为「${title}」生成粤拼…`);
    const lines = await annotate(parsed);
    const song = { id: crypto.randomUUID(), title, artist, lines, index: 0, done: [], difficult: [] };
    const previousSongs = library.songs;
    const previousActiveId = library.activeId;
    const demo = previousSongs.find(item => item.demo && titleKey(item.title) === titleKey(title));
    if (demo) {
      const sampleLine = demo.lines[0];
      const index = lines.findIndex(line => line.text === sampleLine.text);
      if (index >= 0) {
        if (demo.done.includes(0)) song.done.push(index);
        if (demo.difficult.includes(0)) song.difficult.push(index);
      }
      const matchingLine = index >= 0 ? lines[index] : lines.find(line => line.text.startsWith(sampleLine.text));
      if (matchingLine) {
        matchingLine.words = carryWordPractice(sampleLine.words, matchingLine.words);
        if (sampleLine.markedTerms?.length) {
          matchingLine.markedTerms = structuredClone(sampleLine.markedTerms);
          reconcileTermMarks(matchingLine);
        }
      }
    }
    const openImported = !originSong || state === originSong;
    library.songs = demo ? previousSongs.map(item => item === demo ? song : item) : [...previousSongs, song];
    if (openImported) library.activeId = song.id;
    if (!save()) {
      library.songs = previousSongs;
      library.activeId = previousActiveId;
      return importMessage('曲库保存失败，请检查浏览器存储后重试。');
    }
    if (openImported) openSong(song); else renderLibrary();
    if (!originSong) {
      for (const id of ['importTitle', 'importArtist', 'lyrics', 'lyricsFile']) $(id).value = '';
    } else if (openImported) {
      $('lyricsTools').open = false;
    }
    importMessage(`已添加「${title}」，共 ${lines.length} 句。`);
  } catch (error) {
    const networkError = ['TypeError', 'TimeoutError'].includes(error.name);
    importMessage(networkError ? '歌词暂时读取失败，请重试或手动导入。' : error.message);
  } finally {
    button.disabled = false;
    $('completeSong').disabled = false;
  }
}
$('import').onclick = () => {
  const input = $('lyrics').value;
  importSong(() => input, $('importTitle').value.trim(), $('importArtist').value.trim());
};
$('lyrics').oninput = () => { importMessage(''); };
$('lyricsFile').onchange = async () => {
  const file = $('lyricsFile').files[0];
  if (!file) return;
  if (file.size > 200000) return importMessage('歌词文件过大，请选择 200 KB 以内的文本。');
  try {
    const input = await file.text();
    const { title, artist } = readLyricsMetadata(input, file.name);
    $('lyrics').value = input;
    $('importTitle').value = title;
    $('importArtist').value = artist;
    importMessage('歌词已读取，点击「添加到曲库」保存。');
  } catch { importMessage('文件读取失败，请重试。'); }
};
$('saveSegments').onclick = async () => {
  const song = state;
  const line = current();
  const text = $('segments').value.trim();
  if (text.replace(/\s/g, '') !== line.text.replace(/\s/g, '')) return message('分词后的文字需要与本句歌词一致。');
  $('saveSegments').disabled = true;
  try {
    const [readings] = await api('/api/annotate', { texts: [text] });
    const words = segmentWords(text, readings, true);
    line.words = carryWordPractice(line.words, words);
    reconcileTermMarks(line);
    save();
    if (state === song) { selected = null; render(); message('分词与粤拼已保存，请听音核对。'); }
  } catch (error) { message(error.message); }
  finally { $('saveSegments').disabled = false; }
};
$('savePronunciations').onclick = () => {
  const values = $('pronunciations').value.split('\n');
  if (values.length !== current().words.length) return message('粤拼行数需要与词块数量一致。');
  current().words.forEach((word, index) => word.jyutping = values[index].trim());
  save(); render(); message('粤拼已保存。请试听确认朗读是否符合预期。');
};
$('prepare').onclick = async () => {
  if (prepareJob) return;
  const job = { canceled: false, song: state };
  prepareJob = job;
  const voice = voiceSelect.value;
  const voiceName = voiceSelect.selectedOptions[0].textContent;
  const texts = [...new Set(state.lines.flatMap(line => [
    line.text, ...line.words.map(word => word.text),
    ...playbackGroups(line).flatMap(group => group.terms.map(term => term.word.text)),
  ]))].filter(text => /[\p{L}\p{N}]/u.test(text));
  $('prepare').disabled = true;
  $('cancelPrepare').hidden = false;
  let completed = 0;
  try {
    for (const text of texts) {
      if (job.canceled) break;
      $('prepareStatus').textContent = `正在准备 ${voiceName} 朗读 ${completed + 1} / ${texts.length}`;
      await speechUrl(text, voice);
      completed++;
    }
    if (state === job.song) $('prepareStatus').textContent = job.canceled ? `已停止准备 ${voiceName} 朗读，已缓存 ${completed} 段。` : `已准备好 ${voiceName} 的 ${completed} 段词句朗读。`;
  } catch (error) {
    if (state === job.song) $('prepareStatus').textContent = `已准备 ${voiceName} 的 ${completed} 段朗读。${error.message} 已完成内容会保留。`;
  }
  finally { prepareJob = null; $('prepare').disabled = false; $('cancelPrepare').hidden = true; }
};
$('cancelPrepare').onclick = () => { if (prepareJob) prepareJob.canceled = true; $('prepareStatus').textContent = '正在停止，已生成音频会保留。'; };

function showRecording(blob, line, title, scoreNow = true) {
  const holder = $('recording');
  holder.querySelector('audio')?.pause();
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = URL.createObjectURL(blob);
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = recordingUrl;
  audio.setAttribute('aria-label', '回听我的录音');
  audio.onplay = () => {
    if (recorder?.state === 'recording') { audio.pause(); return message('请先结束录音，再回听。'); }
    generation++; clearTimeout(loopTimer);
    resetReading();
    $('referencePreview').pause();
  };
  holder.replaceChildren(audio);
  $('recordingLabel').textContent = `录音对应「${title} · ${line.text}」· 本次页面内保留`;
  scorePanel.acceptTake(line, blob, scoreNow);
}
$('referencePreview').onplay = () => {
  if (recorder?.state === 'recording') { $('referencePreview').pause(); return message('请先结束录音，再播放示范。'); }
  generation++; clearTimeout(loopTimer);
  resetReading();
  $('recording').querySelector('audio')?.pause();
};
$('record').onclick = async () => {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  stop(false);
  const button = $('record');
  const request = ++recordingRequest;
  const takeId = ++latestTake;
  button.disabled = true;
  let stream;
  const line = current();
  const title = state.title;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (request !== recordingRequest) { stream.getTracks().forEach(track => track.stop()); return; }
    stop(false);
    const device = new MediaRecorder(stream);
    recorder = device;
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    device.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (recorder !== device) return;
      button.textContent = '重新录音';
      if (takeId !== latestTake) return;
      if (!chunks.length) return message('没有录到声音，请重新录音。');
      $('takeFile').value = '';
      showRecording(new Blob(chunks, { type: device.mimeType }), line, title, request === recordingRequest);
      if (request === recordingRequest) message('录音完成，可以回听。');
    };
    recorder.onerror = () => { stream.getTracks().forEach(track => track.stop()); button.textContent = '重新录音'; message('录音中断，请重试。'); };
    device.start();
    scorePanel.clearResult();
    button.textContent = '结束录音';
    message('正在录音，请跟读。');
  } catch { stream?.getTracks().forEach(track => track.stop()); message('无法开启麦克风，请检查浏览器权限后重试。'); }
  finally { button.disabled = false; }
};
window.addEventListener('pagehide', stopPracticeAudio);
const entryUrl = new URL(location.href);
const requestedTitle = entryUrl.searchParams.get('song');
if (requestedTitle) {
  const requested = library.songs.find(song => titleKey(song.title) === titleKey(requestedTitle));
  if (requested) {
    state = requested;
    library.activeId = requested.id;
    save();
  }
  entryUrl.searchParams.delete('song');
  history.replaceState(null, '', entryUrl);
}
beginPractice();
if (state.demo && (hosted || (requestedTitle && titleKey(requestedTitle) === titleKey(state.title)))) loadCompleteSong();
