// Run the standalone meSpeak synthesizer off the UI thread for custom lyrics.
self.module = { exports: {} };
importScripts('./vendor/mespeak/ESpeak.js');
const Engine = self.module.exports;
self.require = () => Engine;
self.module = { exports: {} };
importScripts('./vendor/mespeak/index.js');
const speech = self.module.exports;
let ready;
const variants = { 'zh-HK-HiuMaanNeural': 'f2', 'zh-HK-HiuGaaiNeural': 'f4', 'zh-HK-WanLungNeural': 'm1' };

async function resource(name) {
  const response = await fetch('./vendor/mespeak/' + name);
  if (!response.ok) throw new Error('粤语合成音色读取失败，请重试。');
  return response.json();
}
async function initialize() {
  const [config, voice] = await Promise.all([resource('mespeak_config.json'), resource('zh-yue.json')]);
  // The voice provides a Jyutping input mode in addition to English spelling.
  voice.voice = btoa(atob(voice.voice).replace('dictrules 1', 'dictrules 2'));
  speech.loadConfig(config);
  speech.loadVoice(voice);
}
self.onmessage = async ({ data }) => {
  try {
    ready ??= initialize().catch(error => { ready = null; throw error; });
    await ready;
    const wav = speech.speak(data.syllables, {
      voice: 'zh-yue', variant: variants[data.voice], speed: 150, rawdata: 'arraybuffer',
    });
    if (!wav || wav.byteLength <= 44) throw new Error('未能生成粤语朗读。');
    self.postMessage({ id: data.id, wav }, [wav]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || '粤语合成失败，请重试。' });
  }
};
