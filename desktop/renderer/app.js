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
  'export-label', 'result-details', 'live-help', 'webp-help', 'quality-label', 'quality-hint',
  'media-help', 'media-help-title', 'media-help-text', 'preview-stage', 'aspect-label',
  'edit-crop', 'crop-overlay', 'crop-selection', 'crop-toolbar', 'crop-summary', 'reset-crop', 'done-crop', 'crop-button-label',
].map((id) => [id, byId(id)]));

const state = { items: [], selected: null, currentFrame: 1, coverFrame: 1, outputDir: '', busy: false, result: null, dragDepth: 0, format: 'livePhoto', cropEditing: false, cropDrag: null };
const formats = {
  livePhoto: { label: 'Live Photo', kind: 'live', hint: '选取独立封面，可保留原声音。' },
  webp: { label: 'WebP 动图', kind: 'image', hint: '按片段原序循环播放，从首帧开始；无声音。' },
  gif: { label: 'GIF 动图', kind: 'image', hint: '按片段原序循环播放；无声音。GIF 最多支持 256 色。', help: 'GIF 适合需要兼容传统动图的场景，颜色细节有限，文件也可能较大。单帧片段可导出为静态 GIF。' },
  mp4: { label: 'MP4 视频', kind: 'video', hint: '导出常用 MP4 视频，可保留原声音。', help: 'MP4 适合在多数播放器与应用中播放。清晰度控制画面尺寸与编码质量，默认保留所选片段的声音。' },
  mov: { label: 'MOV 视频', kind: 'video', hint: '导出 MOV 视频，可保留原声音。', help: 'MOV 适合支持 QuickTime 的播放器与编辑软件。此处输出普通视频；如需实况图，请选择 Live Photo。' },
  mkv: { label: 'MKV 视频', kind: 'video', hint: '导出 MKV 视频，可保留原声音。', help: 'MKV 适合支持该格式的本地播放器。导出所选片段的一路视频与声音，字幕及额外轨道不会一并保留。' },
  webm: { label: 'WebM 视频', kind: 'video', hint: '导出 WebM 视频，可保留原声音。', help: 'WebM 适合支持 WebM 的网页与播放器。转换会重新编码，请按需要选择清晰度与文件体积。' },
  mp3: { label: 'MP3 音频', kind: 'audio', hint: '仅提取所选片段的声音，不包含画面。', help: 'MP3 是压缩音频格式，适合常见播放器。素材须包含音轨；静音视频与图片无法提取声音。' },
  wav: { label: 'WAV 音频', kind: 'audio', hint: '仅提取所选片段的声音，不包含画面。', help: 'WAV 输出未压缩音频，文件通常较大。转换不能恢复原素材已经丢失的声音细节。' },
};
const qualityPresets = {
  0: { quality: 'original', label: '原画质', audioLabel: '最高音质' },
  1920: { quality: 'high', label: '高清', audioLabel: '高音质' },
  1080: { quality: 'standard', label: '标准', audioLabel: '标准' },
  720: { quality: 'small', label: '省空间', audioLabel: '省空间' },
};

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
function isLivePhoto() { return state.format === 'livePhoto'; }
function isAudio() { return formats[state.format].kind === 'audio'; }
function qualityConfig() {
  const maxSide = Number(ui['max-side'].value);
  return { maxSide, quality: qualityPresets[maxSide].quality };
}
function resultPath() { return state.result?.filePath || state.result?.packagePath; }
function fileSize(bytes) {
  const unit = bytes < 1000 ? 0 : Math.min(3, Math.floor(Math.log(bytes) / Math.log(1000)));
  return `${(bytes / 1000 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
function updateFormat() {
  state.format = Object.hasOwn(formats, ui['export-format'].value) ? ui['export-format'].value : 'livePhoto';
  state.result = null;
  ui['export-result'].hidden = true;
  const format = formats[state.format], live = isLivePhoto();
  ui['cover-settings'].hidden = !live;
  ui['audio-setting'].hidden = !live && format.kind !== 'video';
  ui['mark-cover'].hidden = !live;
  ui['cover-summary'].hidden = !live;
  ui['live-help'].hidden = !live;
  ui['webp-help'].hidden = !isWebP();
  ui['media-help'].hidden = !format.help;
  ui['media-help-title'].textContent = `关于${format.label}导出`;
  ui['media-help-text'].textContent = format.help || '';
  ui['open-result'].hidden = !live;
  ui['inspector-title'].textContent = ui['export-label'].textContent = `导出 ${format.label}`;
  ui['format-hint'].textContent = format.hint;
  if (isAudio()) state.cropEditing = false;
  updateCover();
  updateQuality();
  renderCrop();
  status(`${format.label} · ${live ? '可逐帧选取封面' : isAudio() ? '仅导出声音' : '保留片段原播放顺序'}`);
}

function updateQuality() {
  if (state.format === 'wav' && ui['max-side'].value === '1920') ui['max-side'].value = '0';
  const audio = isAudio(), preset = qualityPresets[Number(ui['max-side'].value)];
  ui['quality-label'].textContent = state.format === 'wav' ? '音频规格' : audio ? '音质' : '清晰度';
  for (const option of ui['max-side'].options) {
    option.textContent = qualityPresets[Number(option.value)][audio ? 'audioLabel' : 'label'];
    option.hidden = state.format === 'wav' && option.value === '1920';
    option.disabled = option.hidden;
    if (state.format === 'wav' && !option.hidden) option.textContent = option.value === '0' ? '24 位 PCM' : option.value === '720' ? '省空间（16 位 / 32 kHz）' : '16 位 PCM';
  }
  if (state.format === 'wav') {
    ui['quality-hint'].textContent = preset.quality === 'small'
      ? '16 位 PCM / 32 kHz，保留原声道并减小体积。转换不会恢复已丢失的声音细节。'
      : `${preset.quality === 'original' ? '24' : '16'} 位 PCM，保留原采样率与声道。转换不会恢复已丢失的声音细节。`;
  } else if (audio) {
    const bitrate = { original: 320, high: 256, standard: 192, small: 96 }[preset.quality];
    ui['quality-hint'].textContent = `${bitrate} kbps MP3，保留原采样率与声道；有损编码不会改善原素材音质。`;
  } else if (preset.quality === 'original') {
    const item = current(), crop = item?.crop;
    const width = item && Math.round((item.sourceWidth || item.width) * (crop?.width || 1));
    const height = item && Math.round((item.sourceHeight || item.height) * (crop?.height || 1));
    ui['quality-hint'].textContent = `${item ? `保留${crop ? '裁后' : '素材'}约 ${width} × ${height} 分辨率` : '保留原始分辨率'}，仍会重新编码；尺寸可能按编码要求微调。`;
  } else {
    ui['quality-hint'].textContent = `最长边不超过 ${ui['max-side'].value} 像素，不放大素材；${preset.quality === 'small' ? '优先减小文件体积。' : '兼顾清晰度与体积。'}`;
  }
}

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function cropRect(item = current()) { return item?.crop || { x: 0, y: 0, width: 1, height: 1 }; }
function setCrop(rect) {
  const item = current();
  if (!item) return;
  const width = clamp(rect.width, 0.000001, 1), height = clamp(rect.height, 0.000001, 1);
  const crop = { x: clamp(rect.x, 0, 1 - width), y: clamp(rect.y, 0, 1 - height), width, height };
  item.crop = crop.x < 0.000001 && crop.y < 0.000001 && crop.width > 0.999999 && crop.height > 0.999999 ? undefined : crop;
  renderCrop();
  updateQuality();
}

function renderCrop() {
  const item = current(), visible = item && !isAudio() && (state.cropEditing || item.crop);
  ui['crop-toolbar'].hidden = !state.cropEditing;
  ui['crop-overlay'].hidden = !visible;
  ui['crop-overlay'].classList.toggle('is-editing', state.cropEditing);
  ui['edit-crop'].setAttribute('aria-pressed', String(state.cropEditing));
  ui['crop-button-label'].textContent = item?.crop ? '调整裁切' : '裁切画面';
  ui['aspect-label'].textContent = item?.crop && !isAudio() ? '已裁切画面' : '原始比例';
  ui['crop-selection'].tabIndex = state.cropEditing ? 0 : -1;
  if (!visible) return;
  const video = ui.preview.getBoundingClientRect(), stage = ui['preview-stage'].getBoundingClientRect();
  const aspect = (ui.preview.videoWidth || item.width) / (ui.preview.videoHeight || item.height);
  const width = Math.min(video.width, video.height * aspect), height = width / aspect;
  const overlay = ui['crop-overlay'];
  overlay.style.left = `${video.left - stage.left + (video.width - width) / 2}px`;
  overlay.style.top = `${video.top - stage.top + (video.height - height) / 2}px`;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  const rect = cropRect(item), selection = ui['crop-selection'];
  selection.style.left = `${rect.x * 100}%`;
  selection.style.top = `${rect.y * 100}%`;
  selection.style.width = `${rect.width * 100}%`;
  selection.style.height = `${rect.height * 100}%`;
  const pixelsWide = Math.round((item.sourceWidth || item.width) * rect.width);
  const pixelsHigh = Math.round((item.sourceHeight || item.height) * rect.height);
  selection.setAttribute('aria-label', `裁切约 ${pixelsWide} × ${pixelsHigh} 像素。方向键移动，聚焦边角后方向键调整大小。`);
  ui['crop-summary'].textContent = `约 ${pixelsWide} × ${pixelsHigh} · 拖动边角调整，Shift 拖动重新框选`;
}

function cropPoint(event) {
  const rect = ui['crop-overlay'].getBoundingClientRect();
  return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
}

function cropMinimum() {
  const item = current();
  return { x: Math.min(1, Math.max(0.01, 2 / (item.sourceWidth || item.width))), y: Math.min(1, Math.max(0.01, 2 / (item.sourceHeight || item.height))) };
}

function resizeCrop(rect, handle, dx, dy) {
  const min = cropMinimum();
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - min.x);
  if (handle.includes('e')) right = clamp(right + dx, left + min.x, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - min.y);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min.y, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function finishCropDrag() {
  const drag = state.cropDrag;
  if (drag && ui['crop-overlay'].hasPointerCapture(drag.pointerId)) ui['crop-overlay'].releasePointerCapture(drag.pointerId);
  state.cropDrag = null;
}

function beginCrop(event) {
  if (!state.cropEditing || state.busy || event.button !== 0 || !current()) return;
  const handle = event.target.closest('[data-crop-handle]');
  const mode = event.shiftKey ? 'new' : handle ? handle.dataset.cropHandle : event.target.closest('#crop-selection') ? 'move' : 'new';
  state.cropDrag = { pointerId: event.pointerId, point: cropPoint(event), rect: { ...cropRect() }, mode };
  ui['crop-overlay'].setPointerCapture(event.pointerId);
  (handle || ui['crop-selection']).focus({ preventScroll: true });
  event.preventDefault();
}

function moveCrop(event) {
  const drag = state.cropDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const point = cropPoint(event), dx = point.x - drag.point.x, dy = point.y - drag.point.y, rect = drag.rect;
  if (drag.mode === 'move') {
    setCrop({ ...rect, x: clamp(rect.x + dx, 0, 1 - rect.width), y: clamp(rect.y + dy, 0, 1 - rect.height) });
  } else if (drag.mode === 'new') {
    const min = cropMinimum();
    const width = Math.max(min.x, Math.abs(dx)), height = Math.max(min.y, Math.abs(dy));
    setCrop({ x: Math.min(drag.point.x, point.x), y: Math.min(drag.point.y, point.y), width, height });
  } else {
    setCrop(resizeCrop(rect, drag.mode, dx, dy));
  }
  event.preventDefault();
}

function cropKeyboard(event) {
  if (!state.cropEditing || state.busy) return;
  if (event.key === 'Escape' || event.key === 'Enter') {
    event.preventDefault();
    state.cropEditing = false;
    finishCropDrag();
    renderCrop();
    ui['edit-crop'].focus();
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const step = event.shiftKey ? 0.001 : 0.01, rect = cropRect();
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  const handle = event.target.closest('[data-crop-handle]');
  setCrop(handle ? resizeCrop(rect, handle.dataset.cropHandle, dx, dy) : { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.width), y: clamp(rect.y + dy, 0, 1 - rect.height) });
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
  if (isLivePhoto() && (state.coverFrame < start || state.coverFrame > end)) return '封面须位于所选片段内，请调整片段或重新选取封面。';
  if (isAudio() && item.hasAudio === false) return '此素材没有音轨，请选择带声音的素材或改用其他输出格式。';
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
  ui['edit-crop'].hidden = isAudio();
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
    state.cropEditing = false;
    finishCropDrag();
    renderCrop();
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
      button.classList.toggle('is-cover', isLivePhoto() && index === nearest);
      button.querySelector('.cover-tag').hidden = !isLivePhoto() || index !== nearest;
    });
  }
  updateClip();
}

function setCover(frame, seek = false) {
  const item = current();
  if (!item || state.busy || !isLivePhoto()) return;
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
  state.cropEditing = false;
  finishCropDrag();
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
  ui['media-metadata'].textContent = `${item.sourceWidth || item.width} × ${item.sourceHeight || item.height} · ${Number(item.fps.toFixed(3))} fps`;
  renderMediaList();
  renderFilmstrip(item);
  updateCover();
  updatePlayback();
  updateQuality();
  renderCrop();
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
    metadata.textContent = `${String(item.kind).toUpperCase()} · ${item.sourceWidth || item.width} × ${item.sourceHeight || item.height}`;
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
    setBusy(true, `正在导出 ${formats[state.format].label}…`);
    const config = {
      id: item.id, startFrame: integerInput(ui['start-frame']),
      endFrame: integerInput(ui['end-frame']), ...qualityConfig(),
      outputDir: state.outputDir, crop: isAudio() ? undefined : item.crop,
    };
    const result = isLivePhoto()
      ? await bridge.exportLivePhoto({ ...config, coverFrame: state.coverFrame, keepAudio: ui['keep-audio'].checked })
      : isWebP() ? await bridge.exportWebP(config)
        : await bridge.exportMedia({ ...config, format: state.format, keepAudio: isAudio() || ui['keep-audio'].checked });
    state.result = result;
    ui['result-name'].textContent = `已导出：${filename(resultPath())}`;
    ui['result-name'].title = resultPath();
    const details = [];
    if (!isAudio() && Number.isFinite(result.width) && Number.isFinite(result.height)) details.push(`${result.width} × ${result.height}`);
    if (isWebP() && !result.isAnimated) details.push('静态 WebP');
    else if (Number.isFinite(result.duration)) details.push(`${Number(result.duration.toFixed(3))} 秒`);
    if (Number.isFinite(result.byteSize)) details.push(fileSize(result.byteSize));
    details.push(ui['max-side'].selectedOptions[0].textContent);
    if (isLivePhoto()) details.push('已完成配对检查。请在 iPhone 相册确认 LIVE。');
    ui['result-details'].textContent = details.join(' · ');
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
ui.preview.addEventListener('loadedmetadata', renderCrop);
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
ui['max-side'].addEventListener('change', updateQuality);
ui['edit-crop'].addEventListener('click', () => {
  if (!current() || state.busy || isAudio()) return;
  ui.preview.pause();
  state.cropEditing = !state.cropEditing;
  renderCrop();
  if (state.cropEditing) ui['crop-selection'].focus({ preventScroll: true });
});
ui['reset-crop'].addEventListener('click', () => {
  if (state.busy) return;
  finishCropDrag();
  setCrop({ x: 0, y: 0, width: 1, height: 1 });
});
ui['done-crop'].addEventListener('click', () => {
  if (state.busy) return;
  state.cropEditing = false;
  finishCropDrag();
  renderCrop();
});
ui['crop-overlay'].addEventListener('pointerdown', beginCrop);
ui['crop-overlay'].addEventListener('pointermove', moveCrop);
ui['crop-overlay'].addEventListener('pointerup', finishCropDrag);
ui['crop-overlay'].addEventListener('pointercancel', finishCropDrag);
ui['crop-overlay'].addEventListener('lostpointercapture', () => { state.cropDrag = null; });
ui['crop-selection'].addEventListener('keydown', cropKeyboard);
new ResizeObserver(renderCrop).observe(ui['preview-stage']);
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
    const savedPreset = Object.entries(qualityPresets).find(([, preset]) => preset.quality === settings.quality);
    if (savedPreset) ui['max-side'].value = savedPreset[0];
    else if ([0, 720, 1080, 1920].includes(settings.maxSide)) ui['max-side'].value = String(settings.maxSide);
    updateQuality();
    if (typeof settings.keepAudio === 'boolean') ui['keep-audio'].checked = settings.keepAudio;
  } catch (cause) { showError(cause); }
}

initialize();
