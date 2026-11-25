import { getJyutpingList } from './vendor/to-jyutping.mjs';

let clips;
let worker;
let serial = 0;
const waiting = new Map();

function synthesize(text, voice) {
  if (!worker) {
    worker = new Worker(new URL('./pages-speech-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
      const job = waiting.get(data.id);
      if (!job) return;
      waiting.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(URL.createObjectURL(new Blob([data.wav], { type: 'audio/wav' })));
    };
    worker.onerror = () => {
      for (const job of waiting.values()) job.reject(new Error('粤语合成组件未能加载，请重试。'));
      waiting.clear();
      worker.terminate();
      worker = null;
    };
  }
  const syllables = getJyutpingList(text).map(([characters, reading]) => reading || characters).join(' ');
  const id = ++serial;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, syllables, voice });
  });
}

export async function pagesApi(route, body) {
  if (route === '/api/annotate') return body.texts.map(text => getJyutpingList(text));
  if (route !== '/api/speech') throw new Error('未知操作。');
  const text = body.text.trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.voice + '\n' + text));
  const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  clips ??= fetch(new URL('./audio-index.json', import.meta.url)).then(async response => {
    if (!response.ok) throw new Error('朗读目录读取失败，请重试。');
    return new Set(await response.json());
  }).catch(error => { clips = null; throw error; });
  if ((await clips).has(key)) return { url: new URL('./audio/' + key + '.mp3', import.meta.url).href };
  return { url: await synthesize(text, body.voice) };
}
