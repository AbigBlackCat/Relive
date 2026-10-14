'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CONTENT_IDENTIFIER = 'com.apple.quicktime.content.identifier';
const STILL_IMAGE_TIME = 'com.apple.quicktime.still-image-time';
const TIMESCALE = 60000;
const MAX_MOOV = 64 * 1024 * 1024;
const PLIST = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>PFVideoComplementMetadataVersionKey</key><string>1</string></dict></plist>\n';

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; }
function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(payload.length + 8), typeof type === 'number' ? u32(type) : Buffer.from(type, 'latin1'), payload]);
}
function fullBox(type, ...parts) { return box(type, u32(0), ...parts); }

function atoms(buffer, start = 0, end = buffer.length) {
  const result = [];
  while (start < end) {
    if (end - start < 8) throw new Error('视频 atom 头部不完整。');
    let size = buffer.readUInt32BE(start), header = 8;
    if (size === 1) {
      if (end - start < 16) throw new Error('视频扩展 atom 头部不完整。');
      size = Number(buffer.readBigUInt64BE(start + 8)); header = 16;
    } else if (size === 0) size = end - start;
    if (!Number.isSafeInteger(size) || size < header || start + size > end) throw new Error('视频 atom 长度无效。');
    result.push({ type: buffer.toString('latin1', start + 4, start + 8), start, size, header,
      data: buffer.subarray(start, start + size), payload: buffer.subarray(start + header, start + size) });
    start += size;
  }
  return result;
}
function child(parent, type) {
  const result = atoms(parent.payload).find(a => a.type === type);
  if (!result) throw new Error(`视频缺少 ${type} atom。`);
  return result;
}
function headerFields(atom, type) {
  const p = atom.payload, version = p[0];
  if (version !== 0 && version !== 1) throw new Error(`不支持的 ${type} 版本。`);
  const timeOffset = version === 1 ? 20 : 12;
  const durationOffset = type === 'tkhd' ? (version === 1 ? 28 : 20) : timeOffset + 4;
  if (p.length < durationOffset + (version === 1 ? 8 : 4)) throw new Error(`${type} 头部不完整。`);
  return { version, timeOffset, durationOffset,
    timescale: type === 'tkhd' ? null : p.readUInt32BE(timeOffset),
    duration: version === 1 ? p.readBigUInt64BE(durationOffset) : BigInt(p.readUInt32BE(durationOffset)) };
}
function scaled(value, from, to) { return (value * BigInt(to) + BigInt(Math.floor(from / 2))) / BigInt(from); }

function rescaleHeader(atom, type, from, to) {
  const fields = headerFields(atom, type), p = atom.payload;
  const duration = scaled(fields.duration, from, to);
  const version = fields.version === 1 || duration > 0xffffffffn ? 1 : 0;
  const creation = fields.version === 1 ? p.readBigUInt64BE(4) : BigInt(p.readUInt32BE(4));
  const modified = fields.version === 1 ? p.readBigUInt64BE(12) : BigInt(p.readUInt32BE(8));
  const prefix = Buffer.from(p.subarray(0, 4)); prefix[0] = version;
  const fieldsBeforeDuration = type === 'tkhd' ? p.subarray(fields.timeOffset, fields.durationOffset) : u32(to);
  return box(type, prefix, version ? u64(creation) : u32(Number(creation)),
    version ? u64(modified) : u32(Number(modified)), fieldsBeforeDuration,
    version ? u64(duration) : u32(Number(duration)),
    p.subarray(fields.durationOffset + (fields.version === 1 ? 8 : 4)));
}
function rescaleEdits(edts, from, to) {
  return box('edts', ...atoms(edts.payload).map(a => {
    if (a.type !== 'elst') return a.data;
    const p = a.payload, version = p[0], count = p.readUInt32BE(4);
    if (version !== 0 && version !== 1) throw new Error('不支持的编辑列表版本。');
    const width = version === 1 ? 20 : 12;
    if (p.length !== 8 + count * width) throw new Error('视频编辑列表不完整。');
    const entries = Array.from({ length: count }, (_, i) => {
      const offset = 8 + i * width;
      return { duration: scaled(version ? p.readBigUInt64BE(offset) : BigInt(p.readUInt32BE(offset)), from, to),
        mediaTime: version ? p.readBigInt64BE(offset + 8) : BigInt(p.readInt32BE(offset + 4)),
        rate: p.subarray(offset + width - 4, offset + width) };
    });
    const newVersion = version === 1 || entries.some(e => e.duration > 0xffffffffn) ? 1 : 0;
    const prefix = Buffer.from(p.subarray(0, 4)); prefix[0] = newVersion;
    return box('elst', prefix, u32(count), ...entries.map(e => {
      const mediaTime = Buffer.alloc(newVersion ? 8 : 4);
      if (newVersion) mediaTime.writeBigInt64BE(e.mediaTime); else mediaTime.writeInt32BE(Number(e.mediaTime));
      return Buffer.concat([newVersion ? u64(e.duration) : u32(Number(e.duration)), mediaTime, e.rate]);
    }));
  }));
}
function trackType(track) { return child(child(track, 'mdia'), 'hdlr').payload.toString('latin1', 8, 12); }
function trackID(track) {
  const tkhd = child(track, 'tkhd');
  return tkhd.payload.readUInt32BE(tkhd.payload[0] === 1 ? 20 : 12);
}

async function readExactly(file, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('视频文件不完整。');
  return buffer;
}
async function writeExactly(file, buffer, position) {
  for (let written = 0; written < buffer.length;) {
    const { bytesWritten } = await file.write(buffer, written, buffer.length - written, position + written);
    if (!bytesWritten) throw new Error('视频文件写入中断。');
    written += bytesWritten;
  }
}
async function loadMovie(moviePath) {
  const file = await fs.open(moviePath, 'r');
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size < 16) throw new Error('视频文件长度无效。');
    const top = [];
    for (let offset = 0; offset < size;) {
      const h = await readExactly(file, Math.min(16, size - offset), offset);
      if (h.length < 8) throw new Error('视频 atom 头部不完整。');
      let length = h.readUInt32BE(0), header = 8;
      const toEOF = length === 0;
      if (length === 1) { if (h.length < 16) throw new Error('视频 atom 头部不完整。'); length = Number(h.readBigUInt64BE(8)); header = 16; }
      else if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < header || offset + length > size) throw new Error('视频 atom 长度无效。');
      top.push({ type: h.toString('latin1', 4, 8), start: offset, size: length, header, toEOF });
      offset += length;
    }
    if (top.some(a => a.type === 'moof')) throw new Error('请先将分片视频转成普通 H.264 / AAC MOV。');
    const moovs = top.filter(a => a.type === 'moov');
    if (moovs.length !== 1 || moovs[0].size > MAX_MOOV) throw new Error('视频需要一个有效且小于 64 MB 的 moov。');
    if (!top.some(a => a.type === 'mdat')) throw new Error('视频缺少媒体数据。');
    if (top.some(a => a.toEOF && a.size > 0xffffffff)) throw new Error('不支持超过 4 GB 且没有显式长度的视频 atom。');
    const moovData = await readExactly(file, moovs[0].size, moovs[0].start);
    const moov = atoms(moovData)[0], mvhd = child(moov, 'mvhd'), fields = headerFields(mvhd, 'mvhd');
    if (!fields.timescale || !fields.duration) throw new Error('视频时长无效。');
    const tracks = atoms(moov.payload).filter(a => a.type === 'trak');
    const videos = tracks.filter(t => trackType(t) === 'vide');
    if (videos.length !== 1) throw new Error('请先转换为只有一个画面轨道的视频。');
    const video = videos[0], videoHeader = child(video, 'tkhd'), vf = headerFields(videoHeader, 'tkhd');
    const duration = Number(vf.duration || fields.duration) / fields.timescale;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频画面时长无效。');
    const stsd = child(child(child(child(video, 'mdia'), 'minf'), 'stbl'), 'stsd');
    const codec = atoms(stsd.payload, 8)[0]?.type;
    if (codec !== 'avc1' && codec !== 'hvc1' && codec !== 'hev1') throw new Error('Live Photo 视频必须是 H.264 或 HEVC。');
    return { size, top, moov, fields, tracks, videoID: trackID(video), duration };
  } finally { await file.close(); }
}

const MATRIX = Buffer.from('000100000000000000000000000000000001000000000000000000000000000040000000', 'hex');
function metadataTrack({ id, videoID, coverTicks, frameTicks, sampleOffset }) {
  const movieTicks = coverTicks + frameTicks;
  const timestamp = Math.floor(Date.now() / 1000) + 2082844800;
  const tkhd = box('tkhd', u32(15), u32(timestamp), u32(timestamp), u32(id), u32(0), u32(movieTicks),
    Buffer.alloc(8), Buffer.alloc(8), MATRIX, Buffer.alloc(8));
  const entries = coverTicks ? [u32(coverTicks), Buffer.from('ffffffff00010000', 'hex')] : [];
  entries.push(u32(frameTicks), Buffer.from('0000000000010000', 'hex'));
  const edts = box('edts', fullBox('elst', u32(coverTicks ? 2 : 1), ...entries));
  const mdhd = fullBox('mdhd', u32(timestamp), u32(timestamp), u32(TIMESCALE), u32(frameTicks), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', Buffer.from('mhlrmetaappl', 'ascii'), u32(1), u32(0), Buffer.from('\x13Core Media Metadata', 'latin1'));
  // QTFF timed metadata uses local-key-id 1, SInt8 (65), and a one-byte value 0.
  const keys = box('keys', box(1, box('keyd', Buffer.from('mdta' + STILL_IMAGE_TIME)), box('dtyp', u32(0), u32(65))));
  const mebx = box('mebx', Buffer.alloc(6), u16(1), keys);
  const stbl = box('stbl', fullBox('stsd', u32(1), mebx), fullBox('stts', u32(1), u32(1), u32(frameTicks)),
    fullBox('stsc', u32(1), u32(1), u32(1), u32(1)), fullBox('stsz', u32(9), u32(1)), fullBox('co64', u32(1), u64(sampleOffset)));
  const gmhd = box('gmhd', fullBox('gmin', Buffer.from('004080008000000000000000', 'hex')));
  const dataHandler = fullBox('hdlr', Buffer.from('dhlralisappl'), Buffer.alloc(8), Buffer.from('\x17Core Media Data Handler', 'latin1'));
  const dinf = box('dinf', fullBox('dref', u32(1), box('alis', u32(1))));
  return box('trak', tkhd, edts, box('tref', box('cdsc', u32(videoID))), box('mdia', mdhd, hdlr, box('minf', gmhd, dataHandler, dinf, stbl)));
}
function identifierMetadata(identifier) {
  return box('meta', fullBox('hdlr', u32(0), Buffer.from('mdta'), Buffer.alloc(14)),
    fullBox('keys', u32(1), box('mdta', Buffer.from(CONTENT_IDENTIFIER))),
    box('ilst', box(1, box('data', u32(1), u32(0), Buffer.from(identifier)))));
}

function jpegSegments(jpeg) {
  if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9) throw new Error('封面不是完整的 JPEG。');
  const segments = [], exifSegments = [], sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let dimensions;
  for (let offset = 2; offset < jpeg.length - 2;) {
    const start = offset;
    if (jpeg[offset++] !== 0xff) throw new Error('封面 JPEG 标记无效。');
    while (jpeg[offset] === 0xff) offset++;
    const marker = jpeg[offset++];
    if (marker === 0xda) { segments.push(jpeg.subarray(start)); break; }
    if (offset + 2 > jpeg.length) throw new Error('封面 JPEG 标记不完整。');
    const size = jpeg.readUInt16BE(offset);
    if (size < 2 || offset + size > jpeg.length) throw new Error('封面 JPEG 段长度无效。');
    if (sof.has(marker)) {
      if (size < 8) throw new Error('封面 JPEG 尺寸无效。');
      dimensions = { width: jpeg.readUInt16BE(offset + 5), height: jpeg.readUInt16BE(offset + 3) };
    }
    if (marker === 0xe1 && jpeg.toString('latin1', offset + 2, offset + 8) === 'Exif\0\0') exifSegments.push(jpeg.subarray(offset + 8, offset + size));
    else segments.push(jpeg.subarray(start, offset + size));
    offset += size;
  }
  if (!dimensions?.width || !dimensions.height) throw new Error('无法读取封面 JPEG 尺寸。');
  return { segments, dimensions, exifSegments };
}
function appleIdentifier(exifSegments) {
  if (exifSegments.length !== 1) throw new Error('封面必须包含一个有效的 EXIF。');
  const tiff = exifSegments[0];
  function ifd(buffer, offset) {
    if (offset < 0 || offset + 2 > buffer.length) throw new Error('封面 EXIF 偏移无效。');
    const count = buffer.readUInt16BE(offset), end = offset + 2 + count * 12 + 4;
    if (count > 256 || end > buffer.length) throw new Error('封面 EXIF 条目不完整。');
    return Array.from({ length: count }, (_, i) => {
      const start = offset + 2 + i * 12;
      return { tag: buffer.readUInt16BE(start), type: buffer.readUInt16BE(start + 2),
        count: buffer.readUInt32BE(start + 4), value: buffer.readUInt32BE(start + 8) };
    });
  }
  if (tiff.length < 8 || tiff.toString('latin1', 0, 4) !== 'MM\0*') throw new Error('封面 EXIF 头部无效。');
  const exifPointer = ifd(tiff, tiff.readUInt32BE(4)).find(e => e.tag === 0x8769 && e.type === 4 && e.count === 1);
  const makerEntry = exifPointer && ifd(tiff, exifPointer.value).find(e => e.tag === 0x927c && e.type === 7);
  if (!makerEntry || makerEntry.value + makerEntry.count > tiff.length) throw new Error('封面缺少有效 Apple MakerNote。');
  const maker = tiff.subarray(makerEntry.value, makerEntry.value + makerEntry.count);
  if (maker.toString('latin1', 0, 14) !== 'Apple iOS\0\0\x01MM') throw new Error('封面 Apple MakerNote 头部无效。');
  const entry = ifd(maker, 14).find(e => e.tag === 17 && e.type === 2 && e.count === 37);
  if (!entry || entry.value + entry.count > maker.length || maker[entry.value + 36] !== 0) throw new Error('封面缺少有效 Apple 配对标记。');
  return maker.toString('ascii', entry.value, entry.value + 36);
}
function exifEntry(tag, type, count, value) { return Buffer.concat([u16(tag), u16(type), u32(count), value]); }
function pairedJPEG(jpeg, identifier) {
  const { segments, dimensions } = jpegSegments(jpeg);
  const maker = Buffer.concat([Buffer.from('Apple iOS\0\0\x01MM', 'latin1'), u16(1), exifEntry(17, 2, 37, u32(32)), u32(0), Buffer.from(identifier + '\0')]);
  const ifd0 = Buffer.concat([u16(2), exifEntry(0x112, 3, 1, Buffer.from('00010000', 'hex')), exifEntry(0x8769, 4, 1, u32(38)), u32(0)]);
  const exifIFD = Buffer.concat([u16(4), exifEntry(0x927c, 7, maker.length, u32(92)),
    exifEntry(0xa001, 3, 1, Buffer.from('00010000', 'hex')), exifEntry(0xa002, 4, 1, u32(dimensions.width)),
    exifEntry(0xa003, 4, 1, u32(dimensions.height)), u32(0)]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0MM\0*', 'latin1'), u32(8), ifd0, exifIFD, maker]);
  return Buffer.concat([Buffer.from('ffd8ffe1', 'hex'), u16(exif.length + 2), exif, ...segments]);
}

function validName(name) {
  return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 200 &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[ .]$/.test(name) && name !== '.' && name !== '..' &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
async function publishFile(source, target) {
  try { await fs.link(source, target); }
  catch (error) {
    if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error.code)) throw error;
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

/** Input JPEG must already be the upright cover; MOV must be normalized H.264/HEVC (+ optional AAC). */
async function writeLivePhoto({ jpegPath, movPath, outputDir, name, coverTime, fps }) {
  if (!validName(name)) throw new Error('导出名称不合法，请使用较短的文件名。');
  if (!Number.isFinite(coverTime) || coverTime < 0 || !Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error('封面时间或帧率无效。');
  const movie = await loadMovie(movPath);
  if (coverTime >= movie.duration || coverTime * TIMESCALE > 0xffffffff - 1) throw new Error('封面时间超出视频范围。');
  const coverTicks = Math.round(coverTime * TIMESCALE);
  const frameTicks = Math.min(Math.max(1, Math.round(TIMESCALE / fps)), Math.round(movie.duration * TIMESCALE) - coverTicks);
  if (frameTicks < 1 || coverTicks + frameTicks > 0xffffffff) throw new Error('封面时间超出视频范围。');
  const identifier = randomUUID().toUpperCase();
  const jpegStat = await fs.stat(jpegPath);
  if (!jpegStat.isFile() || jpegStat.size > 64 * 1024 * 1024) throw new Error('封面文件必须是小于 64 MB 的 JPEG。');
  const jpeg = pairedJPEG(await fs.readFile(jpegPath), identifier);
  const nextID = Math.max(...movie.tracks.map(trackID)) + 1;
  if (nextID >= 0xffffffff) throw new Error('视频轨道编号无效。');
  const children = atoms(movie.moov.payload).filter(a => a.type !== 'meta').map(a => {
    if (a.type === 'mvhd') {
      const rewritten = rescaleHeader(a, 'mvhd', movie.fields.timescale, TIMESCALE);
      rewritten.writeUInt32BE(nextID + 1, rewritten.length - 4); return rewritten;
    }
    if (a.type !== 'trak') return a.data;
    return box('trak', ...atoms(a.payload).map(t => t.type === 'tkhd' ? rescaleHeader(t, 'tkhd', movie.fields.timescale, TIMESCALE) :
      t.type === 'edts' ? rescaleEdits(t, movie.fields.timescale, TIMESCALE) : t.data));
  });
  children.push(metadataTrack({ id: nextID, videoID: movie.videoID, coverTicks, frameTicks, sampleOffset: movie.size + 8 }), identifierMetadata(identifier));
  const newMoov = box('moov', ...children), sampleData = box('mdat', box(1, Buffer.from([0])));
  await fs.mkdir(outputDir, { recursive: true });
  const packagePath = path.join(outputDir, name + '.pvt');
  const staging = await fs.mkdtemp(path.join(outputDir, '.relive-'));
  let reserved = false;
  try {
    const stageImage = path.join(staging, name + '.jpg'), stageMovie = path.join(staging, name + '.mov');
    await fs.writeFile(stageImage, jpeg, { flag: 'wx' });
    await fs.copyFile(movPath, stageMovie, constants.COPYFILE_EXCL);
    const output = await fs.open(stageMovie, 'r+');
    try {
      // Keep original chunk offsets stable, including movies with moov before mdat.
      for (const atom of movie.top) {
        if (atom.type === 'moov') {
          const free = Buffer.alloc(atom.size);
          if (atom.header === 16) { free.writeUInt32BE(1); free.writeBigUInt64BE(BigInt(atom.size), 8); }
          else free.writeUInt32BE(atom.size);
          free.write('free', 4, 'latin1'); await writeExactly(output, free, atom.start);
        } else if (atom.toEOF) { await writeExactly(output, u32(atom.size), atom.start); }
      }
      await writeExactly(output, sampleData, movie.size);
      await writeExactly(output, newMoov, movie.size + sampleData.length);
      await output.sync();
    } finally { await output.close(); }
    await fs.writeFile(path.join(staging, 'metadata.plist'), PLIST, { flag: 'wx' });
    await validateLivePhoto({ packagePath: staging });
    // Reserve the directory with mkdir: rename would silently replace an existing empty directory on Unix.
    await fs.mkdir(packagePath); reserved = true;
    for (const filename of [name + '.jpg', name + '.mov', 'metadata.plist']) await publishFile(path.join(staging, filename), path.join(packagePath, filename));
    return { packagePath, imagePath: path.join(packagePath, name + '.jpg'), moviePath: path.join(packagePath, name + '.mov'), identifier };
  } catch (error) {
    if (reserved) await fs.rm(packagePath, { recursive: true, force: true });
    if (error.code === 'EEXIST') throw new Error('已有同名 Live Photo，请换一个名称。');
    throw error;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

/** Structural validation; Apple Photos recognition is checked separately in the macOS integration test. */
async function validateLivePhoto({ packagePath }) {
  const names = await fs.readdir(packagePath), images = names.filter(n => /\.jpg$/i.test(n)), movies = names.filter(n => /\.mov$/i.test(n));
  if (images.length !== 1 || movies.length !== 1) throw new Error('Live Photo 包必须包含一张 JPEG 和一个 MOV。');
  const jpeg = await fs.readFile(path.join(packagePath, images[0]));
  const { dimensions, exifSegments } = jpegSegments(jpeg);
  const identifier = appleIdentifier(exifSegments);
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(identifier)) throw new Error('Live Photo 配对标记无效。');
  const moviePath = path.join(packagePath, movies[0]), movie = await loadMovie(moviePath);
  const metadata = child(movie.moov, 'meta'), keys = child(metadata, 'keys');
  if (keys.payload.toString('utf8', 16) !== CONTENT_IDENTIFIER) throw new Error('视频缺少配对键。');
  const value = child({ payload: child(metadata, 'ilst').payload }, '\0\0\0\x01');
  if (child(value, 'data').payload.toString('utf8', 8) !== identifier) throw new Error('图片和视频的配对标记不一致。');
  const tracks = movie.tracks.filter(t => trackType(t) === 'meta');
  const track = tracks.find(t => t.data.includes(Buffer.from(STILL_IMAGE_TIME)));
  if (!track || child(child(track, 'tref'), 'cdsc').payload.readUInt32BE(0) !== movie.videoID) throw new Error('缺少与视频关联的封面时间轨道。');
  const mdia = child(track, 'mdia'), fields = headerFields(child(mdia, 'mdhd'), 'mdhd'), stbl = child(child(mdia, 'minf'), 'stbl');
  const mebx = atoms(child(stbl, 'stsd').payload, 8)[0];
  if (mebx?.type !== 'mebx') throw new Error('封面时间轨道格式错误。');
  const definition = atoms(child({ payload: mebx.payload.subarray(8) }, 'keys').payload)[0];
  if (child(definition, 'keyd').payload.toString('utf8') !== 'mdta' + STILL_IMAGE_TIME || child(definition, 'dtyp').payload.readUInt32BE(4) !== 65) throw new Error('封面时间类型错误。');
  const sampleSize = child(stbl, 'stsz').payload;
  if (sampleSize.readUInt32BE(4) !== 9 || sampleSize.readUInt32BE(8) !== 1) throw new Error('封面时间样本无效。');
  const offsets = atoms(stbl.payload).find(a => a.type === 'co64' || a.type === 'stco');
  if (!offsets || offsets.payload.readUInt32BE(4) !== 1) throw new Error('封面时间位置无效。');
  const offset = offsets.type === 'co64' ? Number(offsets.payload.readBigUInt64BE(8)) : offsets.payload.readUInt32BE(8);
  const file = await fs.open(moviePath, 'r');
  try { if (!(await readExactly(file, 9, offset)).equals(box(1, Buffer.from([0])))) throw new Error('封面时间数据无效。'); }
  finally { await file.close(); }
  const edits = child(child(track, 'edts'), 'elst').payload;
  const coverTicks = edits.readUInt32BE(4) === 2 ? edits.readUInt32BE(8) : 0;
  const coverTime = coverTicks / movie.fields.timescale;
  if (!fields.timescale || !fields.duration || coverTime >= movie.duration) throw new Error('封面时间超出范围。');
  const plist = await fs.readFile(path.join(packagePath, 'metadata.plist'), 'utf8');
  if (!plist.includes('<key>PFVideoComplementMetadataVersionKey</key><string>1</string>')) throw new Error('Live Photo 包元数据无效。');
  return { identifier, coverTime, markerDuration: Number(fields.duration) / fields.timescale, ...dimensions };
}

module.exports = { writeLivePhoto, validateLivePhoto };
