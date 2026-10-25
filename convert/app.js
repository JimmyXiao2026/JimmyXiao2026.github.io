/* 格式转换 —— 入口：标签切换与各模块懒初始化 */

import { $, $$, toast } from './lib/ui.js';
import { initImage } from './lib/image.js';
import { initVideo } from './lib/video.js';
import { initAnim } from './lib/anim.js';
import { initAudio } from './lib/audio.js';
import { initNcmBatch } from './lib/ncm-batch.js';
import { initDoc } from './lib/doc.js';
import { initFavicon } from './lib/favicon.js';

const TABS = {
  image: { init: initImage, title: '图片转换' },
  video: { init: initVideo, title: '视频转码' },
  anim: { init: initAnim, title: '视频与动图互转' },
  audio: { init: () => { initAudio(); initNcmBatch(); }, title: '音频转换与裁剪' },
  doc: { init: initDoc, title: '文档与 PDF 互转' },
  favicon: { init: initFavicon, title: '图片转 favicon' },
};

const inited = new Set();
let current = '';

function activate(name) {
  if (!TABS[name]) name = 'image';
  if (name === current) return;
  current = name;

  for (const key of Object.keys(TABS)) {
    const tab = document.getElementById('tab-' + key);
    const panel = document.getElementById('panel-' + key);
    const on = key === name;
    if (tab) tab.setAttribute('aria-selected', String(on));
    if (panel) panel.classList.toggle('active', on);
  }

  if (!inited.has(name)) {
    inited.add(name);
    try {
      TABS[name].init();
    } catch (err) {
      console.error(err);
      toast('这个模块初始化失败：' + err.message, 'error');
    }
  }

  document.title = TABS[name].title + ' · 格式转换 · JimmyXiao';
  if (location.hash.slice(1) !== name) {
    history.replaceState(null, '', '#' + name);
  }
}

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activate(tab.dataset.tab));
});

// 标签支持左右方向键切换（role=tablist 的键盘习惯）
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const names = Object.keys(TABS);
  const i = names.indexOf(current);
  const next = names[(i + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length];
  activate(next);
  document.getElementById('tab-' + next).focus();
});

window.addEventListener('hashchange', () => activate(location.hash.slice(1)));
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  toast('出错了：' + msg, 'error');
});

activate(location.hash.slice(1) || 'image');
