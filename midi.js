/**
 * midi.js — Standard MIDI File (.mid) エクスポート
 *
 * Format 1 (multi-track):
 *   Track 0: テンポ
 *   Track 1..N: 曲のトラックごとにノートイベント
 *
 * 依存: editor.js (getActiveSong)
 */

import { getActiveSong } from './editor.js';

const TICKS = 480; // ticks per quarter note (標準値)

// instrument → General MIDI program number
const GM_PROGRAM = {
  sine:     0,   // Acoustic Grand Piano
  square:   80,  // Lead 1 (square)
  sawtooth: 81,  // Lead 2 (sawtooth)
  triangle: 84,  // Lead 5 (charang)
  marimba:  12,  // Marimba
  bass:     32,  // Acoustic Bass
};

/* ===== ユーティリティ ===== */

/** 可変長エンコード (MIDI variable-length quantity) */
function varLen(val) {
  val = Math.max(0, Math.floor(val));
  const bytes = [val & 0x7f];
  val >>= 7;
  while (val > 0) {
    bytes.unshift((val & 0x7f) | 0x80);
    val >>= 7;
  }
  return bytes;
}

/** 4バイト ビッグエンディアン */
function int32(v) {
  return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** 2バイト ビッグエンディアン */
function int16(v) {
  return [(v >> 8) & 0xff, v & 0xff];
}

/** チャンクを組み立てる（ID 4文字 + length + data） */
function makeChunk(id, data) {
  const idBytes = [...id].map(c => c.charCodeAt(0));
  return [...idBytes, ...int32(data.length), ...data];
}

/* ===== テンポトラック ===== */

function tempoTrack(bpm) {
  const us = Math.round(60_000_000 / bpm); // microseconds per beat
  const events = [
    // Set Tempo: delta=0, FF 51 03 tt tt tt
    0, 0xff, 0x51, 0x03,
    (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff,
    // End of Track
    0, 0xff, 0x2f, 0x00,
  ];
  return makeChunk('MTrk', events);
}

/* ===== ノートトラック ===== */

function noteTrack(track, channel) {
  // 全ノートを Note On / Note Off イベントに展開（絶対tick）
  const evts = [];
  for (const note of track.notes) {
    const pitch   = Math.max(0, Math.min(127, note.pitch));
    const vel     = Math.max(1, Math.min(127, note.velocity ?? 100));
    const onTick  = Math.round(note.beat * TICKS);
    const offTick = Math.round((note.beat + note.duration) * TICKS);
    evts.push({ tick: onTick,  type: 'on',  pitch, vel });
    evts.push({ tick: offTick, type: 'off', pitch });
  }
  // 同じtickではNote Offを先に並べる（重なりを防ぐ）
  evts.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  const bytes = [];

  // Program Change: delta=0
  const prog = GM_PROGRAM[track.instrument] ?? 0;
  bytes.push(0, 0xc0 | channel, prog);

  let prevTick = 0;
  for (const e of evts) {
    const delta = e.tick - prevTick;
    prevTick = e.tick;
    bytes.push(...varLen(delta));
    if (e.type === 'on') {
      bytes.push(0x90 | channel, e.pitch, e.vel);
    } else {
      bytes.push(0x80 | channel, e.pitch, 0);
    }
  }

  // End of Track
  bytes.push(0, 0xff, 0x2f, 0x00);
  return makeChunk('MTrk', bytes);
}

/* ===== メインエクスポート関数 ===== */

export function exportMidi() {
  const song = getActiveSong();
  if (!song) return;

  const activeTracks = song.tracks.filter(t => t.notes.length > 0);
  if (activeTracks.length === 0) {
    alert('音符がありません。先に音符を入力してください。');
    return;
  }

  // Header: format=1, numTracks=1(tempo)+N, ticks=480
  const header = makeChunk('MThd', [
    ...int16(1),
    ...int16(1 + activeTracks.length),
    ...int16(TICKS),
  ]);

  const trackChunks = activeTracks.flatMap((track, i) => {
    // チャンネル9はGM規格でドラム専用なのでスキップ
    const ch = i < 9 ? i : i + 1;
    return noteTrack(track, ch % 16);
  });

  const allBytes = [...header, ...tempoTrack(song.bpm), ...trackChunks];

  const blob = new Blob([new Uint8Array(allBytes)], { type: 'audio/midi' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (song.name?.trim() || 'cosmic-score') + '.mid';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ===== ボタンバインド ===== */
document.getElementById('btn-export-midi')
  ?.addEventListener('click', exportMidi);
