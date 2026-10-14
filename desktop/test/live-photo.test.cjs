'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { writeLivePhoto, validateLivePhoto } = require('../core/live-photo.cjs');

const run = promisify(execFile);
const repo = path.resolve(__dirname, '../..');
function binary(name) {
  if (process.env['RELIVE_' + name.toUpperCase()]) return process.env['RELIVE_' + name.toUpperCase()];
  const bundled = path.join(repo, 'Resources', 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  return existsSync(bundled) ? bundled : name;
}
const ffmpeg = binary('ffmpeg'), ffprobe = binary('ffprobe');
let directory, source, image, verifier;
const outputs = [];
async function hash(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function probe(file, extra = []) {
  return JSON.parse((await run(ffprobe, ['-v', 'error', ...extra, '-of', 'json', file], { maxBuffer: 8 * 1024 * 1024 })).stdout);
}
async function decodedHash(file, stream) {
  return (await run(ffmpeg, ['-v', 'error', '-i', file, '-map', stream, '-f', 'hash', '-hash', 'sha256', '-'])).stdout.trim();
}

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'Relive-node-test-'));
  source = path.join(directory, 'source.mov'); image = path.join(directory, 'cover.jpg');
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
  await run(ffmpeg, ['-v', 'error', '-ss', '0.433333333333', '-i', source, '-frames:v', '1', image]);
  if (process.env.RELIVE_APPLE_VERIFY) verifier = process.env.RELIVE_APPLE_VERIFY;
  else if (process.platform === 'darwin') {
    verifier = path.join(directory, 'verify-live-photo');
    await run('clang', ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'Photos', path.join(__dirname, 'verify-live-photo.m'), '-o', verifier]);
  }
});
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });

test('first, arbitrary and last frame markers decode as Live Photos without changing media', async () => {
  const sourceHash = await hash(source), imageHash = await hash(image);
  const videoHash = await decodedHash(source, '0:v:0'), audioHash = await decodedHash(source, '0:a:0');
  for (const [name, coverTime] of [['first', 0], ['arbitrary', 13 / 30], ['last', 35 / 30]]) {
    const result = await writeLivePhoto({ jpegPath: image, movPath: source, outputDir: directory, name, coverTime, fps: 30 });
    outputs.push(result);
    const validated = await validateLivePhoto(result);
    assert.equal(validated.identifier, result.identifier);
    assert.ok(Math.abs(validated.coverTime - coverTime) <= 1 / 60000);
    const metadata = await probe(result.moviePath, ['-show_streams', '-show_packets', '-select_streams', 'd']);
    assert.equal(metadata.streams.length, 1);
    assert.equal(metadata.streams[0].codec_tag_string, 'mebx');
    assert.equal(metadata.packets.length, 1);
    assert.ok(Math.abs(Number(metadata.packets[0].pts_time) - coverTime) <= 1 / 60000);
    assert.equal(metadata.packets[0].size, '9');
    assert.equal(await decodedHash(result.moviePath, '0:v:0'), videoHash, 'all decoded video pixels must be preserved');
    assert.equal(await decodedHash(result.moviePath, '0:a:0'), audioHash, 'all decoded audio samples must be preserved');
    if (verifier) assert.match((await run(verifier, [result.imagePath, result.moviePath], { timeout: 30000 })).stdout, /PASS/);
  }
  assert.equal(await hash(source), sourceHash, 'input MOV must be unchanged');
  assert.equal(await hash(image), imageHash, 'input JPEG must be unchanged');
});

test('movie with moov at the end and no audio preserves pixels', async () => {
  const silent = path.join(directory, 'silent.mov');
  await run(ffmpeg, ['-v', 'error', '-i', source, '-map', '0:v:0', '-c:v', 'copy', silent]);
  const result = await writeLivePhoto({ jpegPath: image, movPath: silent, outputDir: directory, name: 'silent', coverTime: 0.2, fps: 30 });
  const metadata = await probe(result.moviePath, ['-show_streams']);
  assert.equal(metadata.streams.filter(s => s.codec_type === 'audio').length, 0);
  assert.equal(await decodedHash(result.moviePath, '0:v:0'), await decodedHash(silent, '0:v:0'));
  if (verifier) assert.match((await run(verifier, [result.imagePath, result.moviePath], { timeout: 30000 })).stdout, /PASS/);
});

test('invalid names, times and inputs refuse export; existing packages are never overwritten', async () => {
  const base = { jpegPath: image, movPath: source, outputDir: directory, name: 'first', coverTime: 0, fps: 30 };
  const existing = await hash(outputs[0].moviePath);
  await assert.rejects(writeLivePhoto(base), /同名/);
  assert.equal(await hash(outputs[0].moviePath), existing);
  await fs.mkdir(path.join(directory, 'empty.pvt'));
  await assert.rejects(writeLivePhoto({ ...base, name: 'empty' }), /同名/);
  assert.deepEqual(await fs.readdir(path.join(directory, 'empty.pvt')), []);
  for (const name of ['../bad', 'CON', 'a/b', 'a\\b', 'bad.', 'bad ']) await assert.rejects(writeLivePhoto({ ...base, name }), /名称/);
  for (const coverTime of [-1, NaN, Infinity, 9]) await assert.rejects(writeLivePhoto({ ...base, coverTime, name: 'bad' }));
  const invalid = path.join(directory, 'invalid.mov'); await fs.writeFile(invalid, 'not a movie');
  await assert.rejects(writeLivePhoto({ ...base, movPath: invalid, name: 'invalid' }));
  assert.equal((await fs.readdir(directory)).some(n => n.startsWith('.relive-')), false, 'staging folders must be cleaned');
});

test('validation rejects a missing timed marker and a mismatched pairing identifier', async () => {
  const result = outputs[1], original = await fs.readFile(result.moviePath);
  const missing = Buffer.from(original), marker = missing.indexOf(Buffer.from('com.apple.quicktime.still-image-time'));
  assert.ok(marker > 0); missing[marker] = 0x78;
  await fs.writeFile(result.moviePath, missing);
  await assert.rejects(validateLivePhoto(result), /封面时间/);
  const mismatched = Buffer.from(original), identifier = mismatched.indexOf(Buffer.from(result.identifier));
  assert.ok(identifier > 0); mismatched[identifier] = result.identifier.startsWith('0') ? 0x31 : 0x30;
  await fs.writeFile(result.moviePath, mismatched);
  await assert.rejects(validateLivePhoto(result), /配对标记/);
  await fs.writeFile(result.moviePath, original);
  const originalJPEG = await fs.readFile(result.imagePath), brokenJPEG = Buffer.from(originalJPEG);
  const tiff = brokenJPEG.indexOf(Buffer.from('Exif\0\0')) + 6;
  brokenJPEG.writeUInt32BE(0xffffffff, tiff + 4);
  await fs.writeFile(result.imagePath, brokenJPEG);
  await assert.rejects(validateLivePhoto(result), /EXIF/);
  await fs.writeFile(result.imagePath, originalJPEG);
});
