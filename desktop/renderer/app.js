'use strict';

const bridge = window.relive;
const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'app', 'import-button', 'empty-import-button', 'media-list', 'media-count', 'sidebar-empty',
  'svg-duration', 'svg-background', 'preview', 'preview-empty', 'preview-name', 'play-button',
  'play-icon', 'previous-frame', 'next-frame', 'mark-cover', 'timecode', 'timeline', 'filmstrip',
  'media-metadata', 'current-frame', 'cover-summary', 'first-cover', 'current-cover', 'cover-frame',
  'apply-cover', 'cover-hint', 'cover-error', 'start-frame', 'end-frame', 'trim-start', 'trim-end',
  'reset-trim', 'clip-hint', 'clip-error', 'max-side', 'keep-audio', 'choose-directory',
  'output-directory', 'progress-area', 'progress-stage', 'progress-percent', 'progress',
  'cancel-button', 'export-button', 'export-result', 'result-name', 'reveal-result', 'open-result',
  'error-banner', 'error-message', 'close-error', 'status-text', 'drop-overlay',
  'export-format', 'format-hint', 'cover-settings', 'audio-setting', 'inspector-title',
  'export-label', 'result-details', 'live-help', 'webp-help',
].map((id) => [id, byId(id)]));

const state = { items: [], selected: null, currentFrame: 1, coverFrame: 1, outputDir: '', busy: false, result: null, dragDepth: 0, format: 'livePhoto' };

function timecode(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const hundredths = Math.floor(safe * 100 + 0.0001);
  return `${String(Math.floor(hundredths / 6000)).padStart(2, '0')}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}

function filename(path) { return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path); }
function current() { return state.items.find((item) => item.id === state.selected) || null; }
function frameAtTime(item, seconds) { return Math.max(1, Math.min(item.frameCount, Math.floor(seconds * item.fps + 0.0001) + 1)); }
function frameTime(item, frame) { return (frame - 1) / item.fps; }
function integerInput(input) { return /^\d+$/.test(input.value.trim()) ? Number(input.value) : NaN; }
function status(message) { ui['status-text'].textContent = message; }
function isWebP() { return state.format === 'webp'; }
function resultPath() { return state.result?.filePath || state.result?.packagePath; }
function fileSize(bytes) {
  const unit = bytes < 1000 ? 0 : Math.min(3, Math.floor(Math.log(bytes) / Math.log(1000)));
  return `${(bytes / 1000 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
function updateFormat() {
  state.format = ui['export-format'].value === 'webp' ? 'webp' : 'livePhoto';
  state.result = null;
  ui['export-result'].hidden = true;
  const webp = isWebP();
  ui['cover-settings'].hidden = webp;
  ui['audio-setting'].hidden = webp;
  ui['mark-cover'].hidden = webp;
  ui['cover-summary'].hidden = webp;
  ui['live-help'].hidden = webp;
  ui['webp-help'].hidden = !webp;
  ui['open-result'].hidden = webp;
  ui['inspector-title'].textContent = ui['export-label'].textContent = webp ? '导出 WebP 动图' : '导出 Live Photo';
  ui['format-hint'].textContent = webp ? '按片段原序循环播放，从首帧开始；无声音。' : '选取独立封面，可保留原声音。';
  updateCover();
  status(webp ? 'WebP 动图 · 保留片段原播放顺序' : 'Live Photo · 可逐帧选取封面');
}

function error(message) {
  ui['error-message'].textContent = message ? String(message) : '';
  ui['error-banner'].hidden = !message;
}

function showError(cause) {
  error(cause instanceof Error ? cause.message : String(cause));
  status('处理未完成，可调整后重试');
}

function clipValidation() {
  const item = current();
  if (!item) return '';
  const start = integerInput(ui['start-frame']);
  const end = integerInput(ui['end-frame']);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > item.frameCount || start > end) {
    return `请输入 1 到 ${item.frameCount} 之间的帧号，结束帧须不早于开始帧。`;
  }
  if (!isWebP() && (state.coverFrame < start || state.coverFrame > end)) return '封面须位于所选片段内，请调整片段或重新选取封面。';
  return '';
}

function updateControls() {
  const item = current();
  document.querySelectorAll('[data-edit]').forEach((element) => {
    element.disabled = state.busy || (element.hasAttribute('data-media') && !item);
  });
  ui['previous-frame'].disabled ||= state.currentFrame <= 1;
  ui['next-frame'].disabled ||= !item || state.currentFrame >= item.frameCount;
  ui['export-button'].disabled ||= !state.outputDir || Boolean(clipValidation());
  ui['reveal-result'].disabled ||= !state.result;
  ui['open-result'].disabled ||= !state.result;
}

function setBusy(busy, message = '') {
  state.busy = busy;
  ui.app.classList.toggle('is-busy', busy);
  ui.app.setAttribute('aria-busy', String(busy));
  ui['progress-area'].hidden = !busy;
  ui['export-button'].hidden = busy;
  ui['export-result'].hidden = busy || !state.result;
  ui['cancel-button'].disabled = false;
  ui['drop-overlay'].hidden = true;
  state.dragDepth = 0;
  if (busy) {
    ui.preview.pause();
    ui.progress.value = 0;
    ui['progress-percent'].textContent = '0%';
    ui['progress-stage'].textContent = message || '正在处理…';
    error('');
  }
  if (message) status(message);
  updateControls();
}

function updatePlayback() {
  const item = current();
  ui['play-icon'].setAttribute('href', ui.preview.paused ? '#i-play' : '#i-pause');
  ui['play-button'].setAttribute('aria-label', ui.preview.paused ? '播放' : '暂停');
  if (!item) return;
  state.currentFrame = frameAtTime(item, ui.preview.currentTime);
  ui.timeline.value = String(state.currentFrame);
  ui.timeline.setAttribute('aria-valuetext', `第 ${state.currentFrame} 帧，共 ${item.frameCount} 帧`);
  ui.timecode.textContent = `${timecode(frameTime(item, state.currentFrame))} / ${timecode(item.duration)}`;
  ui['current-frame'].textContent = `第 ${state.currentFrame} / ${item.frameCount} 帧`;
  updateControls();
}

function seekFrame(frame) {
  const item = current();
  if (!item || state.busy) return;
  ui.preview.pause();
  state.currentFrame = Math.max(1, Math.min(item.frameCount, frame));
  // Seek inside the frame so floating-point rounding cannot show its predecessor.
  ui.preview.currentTime = frameTime(item, state.currentFrame) + 0.1 / item.fps;
  ui.timeline.value = String(state.currentFrame);
  ui['current-frame'].textContent = `第 ${state.currentFrame} / ${item.frameCount} 帧`;
  ui.timecode.textContent = `${timecode(frameTime(item, state.currentFrame))} / ${timecode(item.duration)}`;
  updateControls();
}

function updateClip() {
  const item = current();
  const message = clipValidation();
  ui['clip-error'].textContent = message;
  ui['clip-error'].hidden = !message;
  ui['start-frame'].setAttribute('aria-invalid', String(Boolean(message)));
  ui['end-frame'].setAttribute('aria-invalid', String(Boolean(message)));
  if (item && !message) {
    const length = (integerInput(ui['end-frame']) - integerInput(ui['start-frame']) + 1) / item.fps;
    ui['clip-hint'].textContent = `导出时长 ${length.toFixed(2)} 秒 · 两端帧均保留`;
  } else {
    ui['clip-hint'].textContent = item ? '可用当前预览帧设置片段起止位置。' : '默认保留完整视频，可选取片段。';
  }
  updateControls();
}

function updateCover() {
  const item = current();
  ui['cover-frame'].value = String(state.coverFrame);
  ui['cover-frame'].setAttribute('aria-invalid', 'false');
  ui['cover-error'].hidden = true;
  ui['cover-error'].textContent = '';
  ui['cover-hint'].textContent = item ? `共 ${item.frameCount} 帧 · 已选第 ${state.coverFrame} 帧` : '首帧从第 1 帧开始计数。';
  ui['cover-summary'].textContent = item ? `封面：第 ${state.coverFrame} 帧` : '首帧从第 1 帧开始';
  if (item && item.thumbnails.length) {
    const coverTime = frameTime(item, state.coverFrame);
    let nearest = 0;
    item.thumbnails.forEach((thumbnail, index) => {
      if (Math.abs(thumbnail.time - coverTime) < Math.abs(item.thumbnails[nearest].time - coverTime)) nearest = index;
    });
    ui.filmstrip.querySelectorAll('.frame-thumbnail').forEach((button, index) => {
      button.classList.toggle('is-cover', !isWebP() && index === nearest);
      button.querySelector('.cover-tag').hidden = isWebP() || index !== nearest;
    });
  }
  updateClip();
}

function setCover(frame, seek = false) {
  const item = current();
  if (!item || state.busy || isWebP()) return;
  if (!Number.isSafeInteger(frame) || frame < 1 || frame > item.frameCount) {
    ui['cover-error'].textContent = `请输入 1 到 ${item.frameCount} 之间的整数帧号。`;
    ui['cover-error'].hidden = false;
    ui['cover-frame'].setAttribute('aria-invalid', 'true');
    return;
  }
  state.coverFrame = frame;
  updateCover();
  if (seek) seekFrame(frame);
}

function renderFilmstrip(item) {
  ui.filmstrip.replaceChildren();
  item.thumbnails.forEach((thumbnail) => {
    const frame = frameAtTime(item, thumbnail.time);
    const button = document.createElement('button');
    button.className = 'frame-thumbnail';
    button.type = 'button';
    button.setAttribute('data-edit', '');
    button.setAttribute('data-media', '');
    button.setAttribute('aria-label', `定位到第 ${frame} 帧，${timecode(thumbnail.time)}`);
    const image = document.createElement('img');
    image.src = thumbnail.url;
    image.alt = '';
    const tag = document.createElement('span');
    tag.className = 'cover-tag';
    tag.textContent = '封面附近';
    tag.hidden = true;
    button.append(image, tag);
    button.addEventListener('click', () => seekFrame(frame));
    ui.filmstrip.append(button);
  });
}

function selectItem(id) {
  if (state.busy) return;
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;
  ui.preview.pause();
  state.selected = id;
  state.currentFrame = 1;
  state.coverFrame = 1;
  state.result = null;
  ui['export-result'].hidden = true;
  ui['preview-name'].textContent = item.name;
  ui['preview-name'].title = item.name;
  ui['preview-empty'].hidden = true;
  ui.preview.hidden = false;
  ui.preview.src = item.previewURL;
  ui.preview.load();
  ui.timeline.max = String(item.frameCount);
  ui.timeline.value = '1';
  for (const field of ['cover-frame', 'start-frame', 'end-frame']) ui[field].max = String(item.frameCount);
  ui['start-frame'].value = '1';
  ui['end-frame'].value = String(item.frameCount);
  ui['media-metadata'].textContent = `${item.width} × ${item.height} · ${Number(item.fps.toFixed(3))} fps`;
  renderMediaList();
  renderFilmstrip(item);
  updateCover();
  updatePlayback();
  status(`已选择：${item.name}`);
}

function renderMediaList() {
  ui['media-count'].textContent = String(state.items.length);
  ui['sidebar-empty'].hidden = state.items.length > 0;
  ui['media-list'].replaceChildren();
  state.items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'media-item';
    button.classList.toggle('is-selected', item.id === state.selected);
    button.setAttribute('data-edit', '');
    button.setAttribute('aria-pressed', String(item.id === state.selected));
    button.setAttribute('aria-label', `${item.name}，${item.kind}，${timecode(item.duration)}`);
    const thumbnail = document.createElement('div');
    thumbnail.className = 'media-thumbnail';
    const image = document.createElement('img');
    image.src = item.thumbnailURL;
    image.alt = '';
    const duration = document.createElement('span');
    duration.className = 'media-duration numeric';
    duration.textContent = timecode(item.duration);
    thumbnail.append(image, duration);
    const name = document.createElement('span');
    name.className = 'media-name ellipsis';
    name.textContent = item.name;
    name.title = item.name;
    const metadata = document.createElement('span');
    metadata.className = 'media-info numeric';
    metadata.textContent = `${String(item.kind).toUpperCase()} · ${item.width} × ${item.height}`;
    button.append(thumbnail, name, metadata);
    button.addEventListener('click', () => selectItem(item.id));
    ui['media-list'].append(button);
  });
  updateControls();
}

function importOptions() {
  const duration = integerInput(ui['svg-duration']);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 30) throw new Error('SVG 录制时长须为 1 到 30 秒之间的整数。');
  return { svgDuration: duration, background: ui['svg-background'].value };
}

async function importMedia(paths) {
  if (state.busy) return;
  try {
    const options = importOptions();
    setBusy(true, '正在导入素材…');
    const items = paths ? await bridge.importDropped({ paths, ...options }) : await bridge.pickFiles(options);
    for (const item of items) {
      if (!item.id || !Number.isFinite(item.fps) || item.fps <= 0 || !Number.isSafeInteger(item.frameCount) || item.frameCount < 1) {
        throw new Error('素材的帧信息无效，请重新导入。');
      }
      if (!Array.isArray(item.thumbnails)) item.thumbnails = [];
      if (!state.items.some((existing) => existing.id === item.id)) state.items.push(item);
    }
    setBusy(false);
    if (items.length) selectItem(items[0].id);
    else status('未选择文件');
  } catch (cause) {
    showError(cause);
  } finally {
    setBusy(false);
    renderMediaList();
  }
}

async function togglePlayback() {
  const item = current();
  if (!item || state.busy) return;
  if (!ui.preview.paused) ui.preview.pause();
  else {
    if (ui.preview.ended || state.currentFrame === item.frameCount) seekFrame(1);
    try { await ui.preview.play(); } catch (cause) { showError(cause); }
  }
}

function updateDirectory(path) {
  state.outputDir = path;
  ui['output-directory'].textContent = path ? filename(path) : '选择保存文件夹';
  ui['choose-directory'].title = path;
  ui['choose-directory'].setAttribute('aria-label', path ? `选择导出文件夹，目前为 ${path}` : '选择导出文件夹');
  updateControls();
}

async function exportMedia() {
  const item = current();
  if (!item || state.busy) return;
  const message = clipValidation();
  if (message) { updateClip(); return; }
  if (!state.outputDir) { error('请先选择保存文件夹。'); return; }
  try {
    state.result = null;
    setBusy(true, isWebP() ? '正在导出 WebP 动图…' : '正在导出 Live Photo…');
    const config = {
      id: item.id, startFrame: integerInput(ui['start-frame']),
      endFrame: integerInput(ui['end-frame']), maxSide: Number(ui['max-side'].value),
      outputDir: state.outputDir,
    };
    const result = isWebP() ? await bridge.exportWebP(config) : await bridge.exportLivePhoto({ ...config, coverFrame: state.coverFrame, keepAudio: ui['keep-audio'].checked });
    state.result = result;
    ui['result-name'].textContent = `已导出：${filename(resultPath())}`;
    ui['result-name'].title = resultPath();
    ui['result-details'].textContent = isWebP()
      ? `${result.width} × ${result.height} · ${result.isAnimated ? `${Number(result.duration.toFixed(3))} 秒` : '静态 WebP'} · ${fileSize(result.byteSize)}`
      : '已完成文件结构校验。请在 iPhone 相册确认 LIVE。';
    status(`导出完成：${filename(resultPath())}`);
  } catch (cause) {
    showError(cause);
  } finally {
    setBusy(false);
  }
}

ui['import-button'].addEventListener('click', () => importMedia());
ui['empty-import-button'].addEventListener('click', () => importMedia());
ui['previous-frame'].addEventListener('click', () => seekFrame(state.currentFrame - 1));
ui['next-frame'].addEventListener('click', () => seekFrame(state.currentFrame + 1));
ui['play-button'].addEventListener('click', togglePlayback);
ui.timeline.addEventListener('input', () => seekFrame(Number(ui.timeline.value)));
ui.preview.addEventListener('timeupdate', updatePlayback);
ui.preview.addEventListener('play', updatePlayback);
ui.preview.addEventListener('pause', updatePlayback);
ui.preview.addEventListener('ended', updatePlayback);
ui.preview.addEventListener('loadedmetadata', updatePlayback);
ui.preview.addEventListener('error', () => {
  if (current()) error('素材预览无法播放，请重新导入；如仍失败，可尝试转换为 MP4 后导入。');
});
ui['first-cover'].addEventListener('click', () => setCover(1, true));
ui['current-cover'].addEventListener('click', () => setCover(state.currentFrame));
ui['mark-cover'].addEventListener('click', () => setCover(state.currentFrame));
ui['apply-cover'].addEventListener('click', () => setCover(integerInput(ui['cover-frame']), true));
ui['cover-frame'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); setCover(integerInput(ui['cover-frame']), true); }
});
ui['start-frame'].addEventListener('input', updateClip);
ui['end-frame'].addEventListener('input', updateClip);
ui['trim-start'].addEventListener('click', () => { ui['start-frame'].value = String(state.currentFrame); updateClip(); });
ui['trim-end'].addEventListener('click', () => { ui['end-frame'].value = String(state.currentFrame); updateClip(); });
ui['reset-trim'].addEventListener('click', () => {
  const item = current();
  if (!item) return;
  ui['start-frame'].value = '1'; ui['end-frame'].value = String(item.frameCount); updateClip();
});
ui['choose-directory'].addEventListener('click', async () => {
  if (state.busy) return;
  try { const path = await bridge.chooseDirectory(); if (path) updateDirectory(path); } catch (cause) { showError(cause); }
});
ui['export-button'].addEventListener('click', exportMedia);
ui['export-format'].addEventListener('change', updateFormat);
ui['cancel-button'].addEventListener('click', () => {
  ui['cancel-button'].disabled = true;
  ui['progress-stage'].textContent = '正在取消…';
  status('正在取消…');
  bridge.cancel();
});
ui['close-error'].addEventListener('click', () => error(''));
ui['reveal-result'].addEventListener('click', async () => {
  if (!state.result || state.busy) return;
  try { await bridge.reveal(resultPath()); } catch (cause) { showError(cause); }
});
ui['open-result'].addEventListener('click', async () => {
  if (!state.result || state.busy) return;
  try { await bridge.openResult(state.result.packagePath); } catch (cause) { showError(cause); }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault(); if (!state.busy) importMedia(); return;
  }
  if (state.busy || !current() || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest('input, select, textarea, button, summary, [contenteditable]')) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); seekFrame(state.currentFrame - 1); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); seekFrame(state.currentFrame + 1); }
});

function hasFileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
document.addEventListener('dragenter', (event) => {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  state.dragDepth += 1;
  if (!state.busy) ui['drop-overlay'].hidden = false;
});
document.addEventListener('dragover', (event) => {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = state.busy ? 'none' : 'copy';
});
document.addEventListener('dragleave', (event) => {
  if (!hasFileDrag(event)) return;
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (!state.dragDepth) ui['drop-overlay'].hidden = true;
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  state.dragDepth = 0;
  ui['drop-overlay'].hidden = true;
  if (state.busy) return;
  try {
    const paths = Array.from(event.dataTransfer?.files || []).map((file) => bridge.pathForFile(file)).filter(Boolean);
    if (paths.length) importMedia(paths);
    else error('请拖入本地视频、GIF 或 SVG 文件。');
  } catch (cause) { showError(cause); }
});

async function initialize() {
  updateFormat();
  updateControls();
  if (!bridge) { error('应用连接不可用，请关闭并重新打开 Relive。'); return; }
  bridge.onProgress((event) => {
    if (!state.busy) return;
    const progress = Number.isFinite(event.progress) ? Math.min(1, Math.max(0, event.progress)) : 0;
    ui.progress.value = progress;
    ui['progress-percent'].textContent = `${Math.round(progress * 100)}%`;
    ui['progress-stage'].textContent = String(event.stage || '正在处理…');
    status(String(event.stage || '正在处理…'));
  });
  try {
    const settings = await bridge.getSettings();
    updateDirectory(settings.outputDir || '');
    if (Number.isInteger(settings.svgDuration) && settings.svgDuration >= 1 && settings.svgDuration <= 30) ui['svg-duration'].value = String(settings.svgDuration);
    if (['#FFFFFF', '#000000'].includes(settings.background)) ui['svg-background'].value = settings.background;
    if ([1080, 1920].includes(settings.maxSide)) ui['max-side'].value = String(settings.maxSide);
    if (typeof settings.keepAudio === 'boolean') ui['keep-audio'].checked = settings.keepAudio;
  } catch (cause) { showError(cause); }
}

initialize();
