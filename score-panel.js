import { scoreAudio } from './scoring.js?v=1';

const $ = id => document.getElementById(id);

function drawPitch(curves) {
  const canvas = $('scorePlot');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const left = 34, right = width - 12, top = 12, bottom = height - 24;
  const range = Math.max(4, Math.ceil(Math.max(...curves.flat().filter(Number.isFinite).map(Math.abs))));
  const y = pitch => (bottom + top) / 2 - pitch * (bottom - top) / (2 * range);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#4c624f';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const pitch of [-range, 0, range]) {
    ctx.fillText(String(pitch), 0, y(pitch) + 4);
    ctx.strokeStyle = '#d6ddce';
    ctx.beginPath(); ctx.moveTo(left, y(pitch)); ctx.lineTo(right, y(pitch)); ctx.stroke();
  }
  ctx.fillText('句首', left, height - 3);
  ctx.fillText('句尾', right - 30, height - 3);
  curves.forEach((curve, index) => {
    ctx.strokeStyle = index ? '#9b5325' : '#315c42';
    ctx.lineWidth = 2.4;
    ctx.setLineDash(index ? [6, 3] : []);
    ctx.beginPath();
    let connected = false;
    curve.forEach((value, i) => {
      if (value === null) { connected = false; return; }
      const x = left + (right - left) * i / (curve.length - 1);
      if (connected) ctx.lineTo(x, y(value));
      else ctx.moveTo(x, y(value));
      connected = true;
    });
    ctx.stroke();
  });
}

export function createScorePanel({ speechUrl, useTakeFile }) {
  let line, voice, voiceName, rate, take, reference, referenceUrl, job, curves;
  const resize = new ResizeObserver(() => { if (curves) drawPitch(curves); });
  resize.observe($('scorePlot'));
  const canScore = () => Boolean(take && take.line === line);
  function clearResult() {
    job?.abort();
    job = null;
    curves = null;
    $('scoreResult').hidden = true;
    $('scoreStatus').textContent = '';
    $('scoreTake').disabled = !canScore();
  }
  function selectReference(file) {
    reference = file;
    const player = $('referencePreview');
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (referenceUrl) URL.revokeObjectURL(referenceUrl);
    referenceUrl = file ? URL.createObjectURL(file) : null;
    if (file) player.src = referenceUrl;
    else $('referenceFile').value = '';
    player.hidden = $('resetReference').hidden = !file;
  }
  function describeReference() {
    $('scoreReference').textContent = reference ? '评分参照 · 清唱 / ' + reference.name :
      '评分参照 · 本句粤语朗读 / ' + voiceName + ' / ' + rate + ' 倍速';
  }
  function updateContext(nextLine, nextVoice, nextName, nextRate) {
    if (line === nextLine && voice === nextVoice && rate === nextRate) return;
    if (nextLine !== line) {
      selectReference(null);
      $('takeFile').value = '';
    }
    line = nextLine; voice = nextVoice; voiceName = nextName; rate = nextRate;
    clearResult();
    describeReference();
  }
  async function run() {
    clearResult();
    if (!canScore()) return;
    const controller = new AbortController();
    const { signal } = controller;
    job = controller;
    $('scorePanel').open = true;
    $('scoreTake').disabled = true;
    $('scoreStatus').textContent = '正在对比本句示范和你的录音…';
    try {
      let example = reference;
      if (!example) {
        const url = await speechUrl(line.text, voice);
        signal.throwIfAborted();
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error('示范音频读取失败，请重新评分。');
        example = await response.blob();
      }
      signal.throwIfAborted();
      const result = await scoreAudio(example, take.blob, reference ? 1 : rate, signal);
      signal.throwIfAborted();
      $('scoreTotal').textContent = result.total;
      $('scorePitch').textContent = '音高走向 ' + result.pitch;
      $('scoreRhythm').textContent = '时长与停顿 ' + result.rhythm;
      $('scoreTip').textContent = result.tip;
      $('scoreStatus').textContent = '已评分。有效时长：示范 ' + result.referenceSeconds.toFixed(1) + ' 秒，你的录音 ' + result.takeSeconds.toFixed(1) + ' 秒。';
      $('scoreResult').hidden = false;
      curves = result.curves;
      drawPitch(curves);
    } catch (error) {
      if (!signal.aborted) $('scoreStatus').textContent = error.message || '评分失败，请重试。';
    } finally {
      if (job === controller) { job = null; $('scoreTake').disabled = !canScore(); }
    }
  }
  $('scoreTake').onclick = run;
  $('takeFile').onchange = () => {
    const file = $('takeFile').files[0];
    if (file) useTakeFile(file);
  };
  function changeReference(file) {
    selectReference(file);
    describeReference();
    run();
  }
  $('referenceFile').onchange = () => {
    const file = $('referenceFile').files[0];
    if (file) changeReference(file);
  };
  $('resetReference').onclick = () => changeReference(null);
  return {
    updateContext,
    clearResult,
    acceptTake(sourceLine, blob, scoreNow) {
      take = { line: sourceLine, blob };
      if (line === sourceLine && scoreNow) run();
      else clearResult();
    },
  };
}
