// Both clips are decoded at this rate before being sent to the analysis worker.
export const sampleRate = 12000;
export const maxSeconds = 30;
const hop = 240;
const windowSize = 320;
const minLag = 14;  // about 860 Hz
const maxLag = 185; // about 65 Hz
const frameSize = windowSize + maxLag;

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

// YIN cumulative mean normalized difference. An aperiodic frame has no pitch.
function framePitch(samples, start, differences) {
  let sum = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let difference = 0;
    for (let i = start; i < start + windowSize; i++) {
      const delta = samples[i] - samples[i + lag];
      difference += delta * delta;
    }
    sum += difference;
    differences[lag] = sum > 0 ? difference * lag / sum : 1;
    const prev = lag - 1;
    if (prev >= minLag && differences[prev] < 0.16 && differences[lag] >= differences[prev]) {
      const left = differences[prev - 1], mid = differences[prev], right = differences[lag];
      const curvature = left + right - 2 * mid;
      const offset = curvature > 0 ? (left - right) / (2 * curvature) : 0;
      return 12 * Math.log2(sampleRate / (prev + offset));
    }
  }
  return null;
}

export function analyze(samples, label) {
  if (samples.length > maxSeconds * sampleRate) throw new Error(label + '超过 30 秒，请选取单句片段。');
  const rms = [];
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    let energy = 0;
    for (let i = start; i < start + frameSize; i++) energy += samples[i] * samples[i];
    rms.push(Math.sqrt(energy / frameSize));
  }
  const peak = Math.max(0, ...rms);
  if (peak < 0.001) throw new Error(label + '太短或音量太低，请录清楚完整的一句。');
  const threshold = Math.max(0.0007, peak * 0.055);
  const first = rms.findIndex(value => value >= threshold);
  const last = rms.findLastIndex(value => value >= threshold);
  const frames = [];
  const differences = new Float64Array(maxLag + 1);
  for (let i = first; i <= last; i++) {
    const active = rms[i] >= threshold;
    const pitch = active ? framePitch(samples, i * hop, differences) : null;
    frames.push({ pitch, active, energy: rms[i] });
  }
  // Smooth within voiced runs. Never join contours across unvoiced consonants.
  const raw = frames.map(f => f.pitch);
  for (let i = 0; i < frames.length; i++) {
    if (raw[i] === null) continue;
    const nearby = [raw[i]];
    for (const direction of [-1, 1]) {
      for (let offset = 1; offset <= 2; offset++) {
        const value = raw[i + direction * offset];
        if (value == null) break;
        nearby.push(value);
      }
    }
    frames[i].pitch = nearby.length === 1 ? null : quantile(nearby, 0.5);
  }
  const pitches = frames.map(f => f.pitch).filter(Number.isFinite);
  if (pitches.length < 7 || pitches.length < frames.length * 0.15) {
    throw new Error(label + '中可辨认的音高太少，请用清楚的单人声音再试。');
  }
  const center = quantile(pitches, 0.5);
  const loud = quantile(frames.filter(f => f.active).map(f => f.energy), 0.9);
  for (const frame of frames) {
    if (frame.pitch !== null) frame.pitch -= center;
    frame.energy = Math.min(1, frame.energy / loud);
  }
  return { frames, duration: ((frames.length - 1) * hop + frameSize) / sampleRate };
}

const boundedScore = value => Math.round(Math.max(0, Math.min(100, value)));

// Banded dynamic time warping tolerates small onset shifts without matching
// a syllable to a different part of the sentence. Timing is scored separately.
function alignFrames(a, b, radius) {
  const count = a.length, width = 2 * radius + 1;
  const steps = new Uint8Array(count * width);
  let previous = new Float64Array(count + 1).fill(Infinity);
  let row = new Float64Array(count + 1).fill(Infinity);
  previous[0] = 0;
  for (let i = 0; i < count; i++) {
    const lo = Math.max(0, i - radius), hi = Math.min(count - 1, i + radius);
    row[lo] = Infinity;
    for (let j = lo; j <= hi; j++) {
      const x = a[i], y = b[j];
      let distance = Math.abs(x.energy - y.energy) + Number(x.active !== y.active);
      if (x.pitch !== null && y.pitch !== null) distance += Math.min(1, Math.abs(x.pitch - y.pitch) / 6);
      else if (x.pitch !== y.pitch) distance += 0.9;
      const diagonal = previous[j], up = previous[j + 1] + 0.35, left = row[j] + 0.35;
      const best = Math.min(diagonal, up, left);
      steps[i * width + j - i + radius] = best === diagonal ? 0 : best === up ? 1 : 2;
      row[j + 1] = best + distance;
    }
    if (hi + 2 <= count) row[hi + 2] = Infinity;
    [row, previous] = [previous, row];
  }
  const pairs = [];
  let i = count - 1, j = count - 1;
  while (i >= 0 && j >= 0) {
    pairs.push([i, j]);
    const step = steps[i * width + j - i + radius];
    if (step !== 2) i--;
    if (step !== 1) j--;
  }
  return pairs;
}

export function compare(reference, take, playbackRate = 1) {
  // Work in relative sentence time, retaining actual duration as a separate cue.
  const count = Math.max(reference.frames.length, take.frames.length);
  const resample = clip => Array.from({ length: count }, (_, i) => clip.frames[Math.round(i * (clip.frames.length - 1) / (count - 1))]);
  const aFrames = resample(reference), bFrames = resample(take);
  const radius = Math.min(5, Math.floor(count * 0.1));
  const path = alignFrames(aFrames, bFrames, radius);
  let error = 0, pairs = 0, voiced = 0, envelopeError = 0, pauseMismatch = 0;
  const regions = Array.from({ length: 3 }, () => ({ sum: 0, count: 0 }));
  for (let i = 0; i < count; i++) if (aFrames[i].active !== bFrames[i].active) pauseMismatch++;
  for (const [i, j] of path) {
    const a = aFrames[i], b = bFrames[j];
    envelopeError += Math.abs(a.energy - b.energy);
    if (a.pitch !== null || b.pitch !== null) voiced++;
    if (a.pitch === null || b.pitch === null) continue;
    const delta = Math.abs(a.pitch - b.pitch);
    error += Math.min(delta, 12);
    pairs++;
    const region = regions[Math.floor(i * 3 / count)];
    region.sum += Math.min(delta, 12);
    region.count++;
  }
  if (pairs < 5 || pairs < voiced * 0.25) throw new Error('两段声音同时有音高的部分太少，请确认都是同一句，再录一次。');
  const expected = reference.duration / playbackRate;
  const ratio = take.duration / expected;
  const pitch = boundedScore(100 * Math.exp(-error / pairs / 4) * (0.7 + 0.3 * pairs / voiced));
  const rhythm = boundedScore(100 * Math.exp(-1.4 * Math.abs(Math.log(ratio)) - 1.1 * envelopeError / path.length - 1.3 * pauseMismatch / count));
  const worstRegion = regions.map(r => r.count >= 3 ? r.sum / r.count : 0);
  const worst = Math.max(...worstRegion);
  let tip = '两段的音高起伏和节奏接近，可以回听咬字和收音。';
  if (ratio > 1.22) tip = '这一句比示范长。先听一次示范，留意停顿和尾音的长度。';
  else if (ratio < 0.82) tip = '这一句比示范短。对照听一遍，看看哪里唱快了或提前收了尾。';
  else if (worst > 1.5) tip = '重点回听' + ['句首', '句中', '句尾'][worstRegion.indexOf(worst)] + '，对照两条线再试一次音高的升降。';
  else if (rhythm < 80 || pitch < 80) tip = '先对照听停顿前后的两个音，再跟着示范练一遍。';
  return { total: Math.round(0.6 * pitch + 0.4 * rhythm), pitch, rhythm, tip,
    referenceSeconds: expected, takeSeconds: take.duration,
    curves: [reference, take].map(clip => clip.frames.map(frame => frame.pitch)) };
}

async function decodeClip(blob, label, signal) {
  if (!blob.size || blob.size > 16 * 1024 * 1024) throw new Error(label + '需为 16 MB 以内的有效音频。');
  if (typeof OfflineAudioContext === 'undefined') throw new Error('这个浏览器暂时无法分析录音，请使用支持 Web Audio 的浏览器。');
  const context = new OfflineAudioContext(1, 1, sampleRate);
  let audio;
  try { audio = await context.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error(label + '无法解码，请尝试 WAV 或 MP3 文件。'); }
  signal.throwIfAborted();
  if (audio.duration > maxSeconds) throw new Error(label + '超过 30 秒，请截取同一句再试。');
  // Choose an audible channel; stereo channels can cancel when added together.
  let loudest = -1, channel = 0;
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const samples = audio.getChannelData(c);
    let level = 0;
    for (let i = 0; i < samples.length; i += 31) level += samples[i] * samples[i];
    if (level > loudest) { loudest = level; channel = c; }
  }
  return audio.getChannelData(channel).slice();
}

export async function scoreAudio(referenceBlob, takeBlob, rate, signal) {
  const reference = await decodeClip(referenceBlob, '示范音频', signal);
  const take = await decodeClip(takeBlob, '你的录音', signal);
  signal.throwIfAborted();
  const worker = new Worker(new URL(import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result);
      worker.onerror = () => reject(new Error('音频分析中断，请重新评分。'));
      worker.postMessage({ reference, take, rate }, [reference.buffer, take.buffer]);
    });
  } finally { worker.terminate(); }
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try {
      const reference = analyze(data.reference, '示范音频');
      const take = analyze(data.take, '你的录音');
      self.postMessage({ result: compare(reference, take, data.rate) });
    } catch (error) {
      self.postMessage({ error: error.message });
    }
  };
}
