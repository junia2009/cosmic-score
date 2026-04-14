/**
 * editor.js — ピアノロール Canvas 描画・編集 + アプリ全体の状態管理
 *
 * 座標系:
 *   X軸 = ビート (1beat = BEAT_WIDTH px)
 *   Y軸 = MIDIピッチ 降順 (127 → 0)
 *         表示範囲: PITCH_MIN(24) 〜 PITCH_MAX(108)
 *
 * ツール: draw / select / erase
 */

import { engine }                       from './engine.js';
import { loadCurrentSong, saveSong, saveCurrentId, loadAllSongs, createDefaultTrack, generateId } from './storage.js';

/* ========== 定数 ========== */
const PITCH_MIN   = 24;   // C1
const PITCH_MAX   = 107;  // B7
const PITCH_COUNT = PITCH_MAX - PITCH_MIN + 1;  // 84
const NOTE_HEIGHT = 12;
const BEAT_WIDTH  = 40;   // px per beat
const KEY_WIDTH   = 48;   // 鍵盤幅
const HEADER_H    = 28;   // タイムライン高さ
const TOTAL_BEATS = 64;   // 表示ビート数 (4/4拍子 × 16小節)
const BEATS_PER_BAR = 4;

const TRACK_COLORS = [
  '#7c5cfc','#c084fc','#34d399','#f87171',
  '#fbbf24','#38bdf8','#fb7185','#a3e635',
];

/* ========== 状態 ========== */
let song      = null;
let activeTrackIdx = 0;
let tool      = 'draw';     // 'draw' | 'select' | 'erase'
let quantize  = 0.25;
let isDragging = false;
let dragNote  = null;     // 描画中の仮ノート
let selectionRect = null; // 選択範囲
let selectedNoteIds = new Set();
let playheadBeat = 0;

/* ========== Canvas / Context ========== */
const canvas   = document.getElementById('roll-canvas');
const ctx2d    = canvas.getContext('2d');
const wrap     = document.getElementById('canvas-wrap');

/* ========== 初期化 ========== */
function init() {
  song = loadCurrentSong();
  syncUI();
  resizeCanvas();
  render();
  bindEvents();
  bindUIEvents();
}

/* ========== キャンバスサイズ ========== */
function resizeCanvas() {
  const totalW = KEY_WIDTH + BEAT_WIDTH * TOTAL_BEATS;
  const totalH = HEADER_H  + NOTE_HEIGHT * PITCH_COUNT;
  canvas.width  = totalW;
  canvas.height = totalH;
}

/* ========== UI同期 ========== */
function syncUI() {
  document.getElementById('song-name').value = song.name;
  document.getElementById('bpm').value       = song.bpm;
  renderTrackList();
}

/* ========== トラックリスト描画 ========== */
function renderTrackList() {
  const list = document.getElementById('track-list');
  list.innerHTML = '';
  song.tracks.forEach((track, idx) => {
    const div = document.createElement('div');
    div.className = 'track-item' + (idx === activeTrackIdx ? ' active' : '');
    div.dataset.idx = idx;

    const dot = document.createElement('div');
    dot.className = 'track-color';
    dot.style.background = track.color;

    const name = document.createElement('div');
    name.className = 'track-name';
    name.textContent = track.name;
    name.contentEditable = true;
    name.spellcheck = false;
    name.addEventListener('blur', () => { track.name = name.textContent.trim() || 'Track'; saveSong(song); });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });

    const muteBtn = document.createElement('button');
    muteBtn.className = 'track-mute' + (track.muted ? ' muted' : '');
    muteBtn.textContent = 'M';
    muteBtn.title = 'ミュート';
    muteBtn.addEventListener('click', e => {
      e.stopPropagation();
      track.muted = !track.muted;
      muteBtn.classList.toggle('muted', track.muted);
      saveSong(song);
    });

    const soloBtn = document.createElement('button');
    soloBtn.className = 'track-solo' + (track.solo ? ' soloed' : '');
    soloBtn.textContent = 'S';
    soloBtn.title = 'ソロ';
    soloBtn.addEventListener('click', e => {
      e.stopPropagation();
      track.solo = !track.solo;
      soloBtn.classList.toggle('soloed', track.solo);
      saveSong(song);
    });

    div.append(dot, name, muteBtn, soloBtn);
    div.addEventListener('click', () => {
      activeTrackIdx = idx;
      renderTrackList();
      render();
      updateStatus();
    });
    list.appendChild(div);
  });
}

/* ========== Canvas描画 ========== */
function render() {
  const w = canvas.width;
  const h = canvas.height;
  const c = ctx2d;

  c.clearRect(0, 0, w, h);

  // --- 背景グリッド ---
  c.fillStyle = '#0a0a14';
  c.fillRect(KEY_WIDTH, HEADER_H, w - KEY_WIDTH, h - HEADER_H);

  // 行（ピッチ）背景
  for (let pi = 0; pi < PITCH_COUNT; pi++) {
    const pitch = PITCH_MAX - pi;
    const y = HEADER_H + pi * NOTE_HEIGHT;
    const note = pitch % 12;
    const isBlack = [1,3,6,8,10].includes(note);
    c.fillStyle = isBlack ? '#0d0d1e' : '#11112a';
    c.fillRect(KEY_WIDTH, y, w - KEY_WIDTH, NOTE_HEIGHT);
    // C音の強調
    if (note === 0) {
      c.fillStyle = '#1a1a3a';
      c.fillRect(KEY_WIDTH, y, w - KEY_WIDTH, 1);
    }
  }

  // 縦グリッド（ビート・小節）
  for (let beat = 0; beat <= TOTAL_BEATS; beat++) {
    const x = KEY_WIDTH + beat * BEAT_WIDTH;
    const isBar = beat % BEATS_PER_BAR === 0;
    c.strokeStyle = isBar ? '#2a2a55' : '#181830';
    c.lineWidth = isBar ? 1 : 0.5;
    c.beginPath(); c.moveTo(x, HEADER_H); c.lineTo(x, h); c.stroke();
  }

  // --- タイムラインヘッダ ---
  c.fillStyle = '#12121f';
  c.fillRect(KEY_WIDTH, 0, w - KEY_WIDTH, HEADER_H);
  c.fillStyle = '#1a1a2e';
  c.fillRect(0, 0, KEY_WIDTH, HEADER_H);
  c.strokeStyle = '#2a2a45';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, HEADER_H); c.lineTo(w, HEADER_H); c.stroke();

  c.fillStyle = '#7c85a0';
  c.font = '10px Segoe UI, sans-serif';
  c.textAlign = 'center';
  for (let beat = 0; beat <= TOTAL_BEATS; beat += BEATS_PER_BAR) {
    const bar = beat / BEATS_PER_BAR + 1;
    const x = KEY_WIDTH + beat * BEAT_WIDTH;
    c.fillText(`${bar}`, x, HEADER_H - 6);
  }

  // --- 鍵盤 ---
  drawPianoKeys(c);

  // --- ノート描画（全トラック） ---
  song.tracks.forEach((track, ti) => {
    const isActive = ti === activeTrackIdx;
    track.notes.forEach(note => {
      const selected = selectedNoteIds.has(note.id);
      drawNote(c, note, track.color, isActive, selected);
    });
  });

  // --- ドラッグ中のプレビューノート ---
  if (dragNote) {
    const activeTrack = song.tracks[activeTrackIdx];
    drawNote(c, dragNote, activeTrack?.color ?? '#7c5cfc', true, false, 0.6);
  }

  // --- 選択範囲 ---
  if (selectionRect) {
    c.strokeStyle = '#a78bfa';
    c.lineWidth   = 1;
    c.setLineDash([4, 3]);
    c.strokeRect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
    c.fillStyle = 'rgba(124,92,252,0.12)';
    c.fillRect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
    c.setLineDash([]);
  }

  // --- 再生ヘッド ---
  const phX = KEY_WIDTH + playheadBeat * BEAT_WIDTH;
  c.strokeStyle = '#fbbf24';
  c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(phX, 0); c.lineTo(phX, h); c.stroke();
  // 三角マーカー
  c.fillStyle = '#fbbf24';
  c.beginPath();
  c.moveTo(phX - 6, 0);
  c.lineTo(phX + 6, 0);
  c.lineTo(phX, 10);
  c.closePath(); c.fill();
}

function drawPianoKeys(c) {
  for (let pi = 0; pi < PITCH_COUNT; pi++) {
    const pitch = PITCH_MAX - pi;
    const y = HEADER_H + pi * NOTE_HEIGHT;
    const note = pitch % 12;
    const isBlack = [1,3,6,8,10].includes(note);
    c.fillStyle = isBlack ? '#1e1b2e' : '#f1f5f9';
    c.fillRect(0, y, KEY_WIDTH, NOTE_HEIGHT - 1);
    // 音名ラベル (C のみ)
    if (note === 0) {
      const octave = Math.floor(pitch / 12) - 1;
      c.fillStyle = '#7c85a0';
      c.font = '9px Segoe UI, sans-serif';
      c.textAlign = 'left';
      c.fillText(`C${octave}`, 4, y + NOTE_HEIGHT - 3);
    }
  }
  // 鍵盤境界線
  c.strokeStyle = '#2a2a45';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(KEY_WIDTH, 0); c.lineTo(KEY_WIDTH, canvas.height); c.stroke();
}

function drawNote(c, note, color, isActive, selected, alpha = 1) {
  const x = KEY_WIDTH + note.beat * BEAT_WIDTH;
  const y = HEADER_H + (PITCH_MAX - note.pitch) * NOTE_HEIGHT;
  const w = Math.max(note.duration * BEAT_WIDTH - 2, 2);
  const h = NOTE_HEIGHT - 2;

  c.save();
  c.globalAlpha = isActive ? alpha : alpha * 0.5;
  c.fillStyle = selected ? '#f0abfc' : color;

  // 丸矩形
  const r = 3;
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r);
  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);
  c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r);
  c.arcTo(x, y, x + r, y, r);
  c.closePath();
  c.fill();

  // ハイライト
  c.fillStyle = 'rgba(255,255,255,0.25)';
  c.fillRect(x + 2, y + 1, w - 4, 2);

  c.restore();
}

/* ========== 座標→ビート/ピッチ変換 ========== */
function canvasToBeat(canvasX) {
  return (canvasX - KEY_WIDTH) / BEAT_WIDTH;
}
function canvasToPitch(canvasY) {
  return PITCH_MAX - Math.floor((canvasY - HEADER_H) / NOTE_HEIGHT);
}
function snapBeat(beat) {
  return Math.max(0, Math.round(beat / quantize) * quantize);
}

/* ========== マウスイベント ========== */
let mouseDownBeat  = 0;
let mouseDownPitch = 0;
let mouseDownPos   = { x: 0, y: 0 };

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

function bindEvents() {
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup',   onMouseUp);
  canvas.addEventListener('mouseleave', () => { isDragging = false; dragNote = null; selectionRect = null; render(); });
  canvas.addEventListener('contextmenu', e => { e.preventDefault(); });

  // キーボードショートカット
  document.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === '1') setTool('draw');
    if (e.key === '2') setTool('select');
    if (e.key === '3') setTool('erase');
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    if (e.key === 'Escape') { selectedNoteIds.clear(); render(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') { selectAll(); e.preventDefault(); }
  });
}

function onMouseDown(e) {
  const pos = getCanvasPos(e);
  if (pos.x < KEY_WIDTH || pos.y < HEADER_H) return;

  isDragging     = true;
  mouseDownBeat  = canvasToBeat(pos.x);
  mouseDownPitch = canvasToPitch(pos.y);
  mouseDownPos   = pos;

  if (tool === 'draw') {
    const beat = snapBeat(mouseDownBeat);
    const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, mouseDownPitch));
    dragNote = { id: generateId(), beat, pitch, duration: quantize, velocity: 100 };
    render();
  } else if (tool === 'erase') {
    eraseNoteAt(pos);
  } else if (tool === 'select') {
    selectedNoteIds.clear();
    selectionRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
    render();
  }
}

function onMouseMove(e) {
  if (!isDragging) return;
  const pos = getCanvasPos(e);

  if (tool === 'draw' && dragNote) {
    const currentBeat = canvasToBeat(pos.x);
    const minDur      = quantize;
    dragNote.duration = Math.max(minDur, snapBeat(currentBeat - dragNote.beat) + quantize);
    render();
  } else if (tool === 'erase') {
    eraseNoteAt(pos);
  } else if (tool === 'select' && selectionRect) {
    selectionRect.w = pos.x - selectionRect.x;
    selectionRect.h = pos.y - selectionRect.y;
    render();
  }
}

function onMouseUp(e) {
  if (!isDragging) return;
  isDragging = false;

  if (tool === 'draw' && dragNote) {
    const track = song.tracks[activeTrackIdx];
    if (track) {
      track.notes.push({ ...dragNote });
      updateStatus();
      autosave();
    }
    dragNote = null;
    render();
  } else if (tool === 'select' && selectionRect) {
    commitSelection();
    selectionRect = null;
    render();
  }
}

function eraseNoteAt(pos) {
  const beat  = canvasToBeat(pos.x);
  const pitch = canvasToPitch(pos.y);
  song.tracks.forEach(track => {
    track.notes = track.notes.filter(n => {
      const hit = n.pitch === pitch && beat >= n.beat && beat < n.beat + n.duration;
      return !hit;
    });
  });
  autosave();
  render();
  updateStatus();
}

function commitSelection() {
  if (!selectionRect) return;
  const r = selectionRect;
  const x1 = Math.min(r.x, r.x + r.w);
  const x2 = Math.max(r.x, r.x + r.w);
  const y1 = Math.min(r.y, r.y + r.h);
  const y2 = Math.max(r.y, r.y + r.h);

  song.tracks[activeTrackIdx]?.notes.forEach(note => {
    const nx = KEY_WIDTH + note.beat * BEAT_WIDTH;
    const ny = HEADER_H  + (PITCH_MAX - note.pitch) * NOTE_HEIGHT;
    const nw = note.duration * BEAT_WIDTH;
    if (nx + nw >= x1 && nx <= x2 && ny + NOTE_HEIGHT >= y1 && ny <= y2) {
      selectedNoteIds.add(note.id);
    }
  });
}

function deleteSelected() {
  if (selectedNoteIds.size === 0) return;
  song.tracks.forEach(track => {
    track.notes = track.notes.filter(n => !selectedNoteIds.has(n.id));
  });
  selectedNoteIds.clear();
  autosave();
  render();
  updateStatus();
}

function selectAll() {
  song.tracks[activeTrackIdx]?.notes.forEach(n => selectedNoteIds.add(n.id));
  render();
}

/* ========== ツール切替 ========== */
function setTool(t) {
  tool = t;
  const map = { draw: 'tool-draw', select: 'tool-select', erase: 'tool-erase' };
  Object.entries(map).forEach(([k, id]) => {
    document.getElementById(id)?.classList.toggle('active', k === t);
  });
  canvas.style.cursor = t === 'erase' ? 'not-allowed' : t === 'select' ? 'crosshair' : 'crosshair';
  document.getElementById('status-info').textContent = `ツール: ${{ draw: '描画', select: '選択', erase: '消去' }[t]}`;
}

/* ========== UIイベント ========== */
function bindUIEvents() {
  // Transport
  document.getElementById('btn-play').addEventListener('click', () => {
    if (engine.isPlaying) return;
    engine.play(song, playheadBeat);
    document.getElementById('btn-play').textContent = '▶ Playing...';
    engine.onBeatUpdate = beat => {
      playheadBeat = beat % TOTAL_BEATS;
      render();
      document.getElementById('status-pos').textContent = `位置: ${Math.floor(playheadBeat / BEATS_PER_BAR) + 1}:${Math.floor(playheadBeat % BEATS_PER_BAR) + 1}:${Math.floor((playheadBeat % 1) * 10)}`;
    };
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    engine.stop();
    playheadBeat = 0;
    document.getElementById('btn-play').textContent = '▶ Play';
    render();
    updateStatus();
  });

  // Tools
  document.getElementById('tool-draw').addEventListener('click',   () => setTool('draw'));
  document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
  document.getElementById('tool-erase').addEventListener('click',  () => setTool('erase'));

  // BPM
  document.getElementById('bpm').addEventListener('change', e => {
    const v = parseInt(e.target.value);
    if (v >= 40 && v <= 300) { song.bpm = v; autosave(); }
  });

  // Quantize
  document.getElementById('quantize').addEventListener('change', e => {
    quantize = parseFloat(e.target.value);
  });

  // Clear
  document.getElementById('btn-clear-notes').addEventListener('click', () => {
    if (!confirm('アクティブトラックのノートをすべて削除しますか？')) return;
    song.tracks[activeTrackIdx].notes = [];
    selectedNoteIds.clear();
    autosave();
    render();
    updateStatus();
  });

  // Add Track
  document.getElementById('btn-add-track').addEventListener('click', () => {
    const colorIdx = song.tracks.length % TRACK_COLORS.length;
    const track = createDefaultTrack(`Track ${song.tracks.length + 1}`, TRACK_COLORS[colorIdx]);
    song.tracks.push(track);
    activeTrackIdx = song.tracks.length - 1;
    autosave();
    syncUI();
    render();
  });

  // Song name
  document.getElementById('song-name').addEventListener('input', e => {
    song.name = e.target.value;
    autosave();
  });

  // Save button
  document.getElementById('btn-save').addEventListener('click', () => {
    autosave();
    showToast('保存しました');
  });

  // Load button (簡易: 保存済み曲リストから選択)
  document.getElementById('btn-load').addEventListener('click', () => {
    const songs = loadAllSongs();
    if (songs.length === 0) { showToast('保存済みの曲がありません'); return; }
    const names = songs.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
    const idx = parseInt(prompt(`読み込む曲番号を入力してください:\n${names}`)) - 1;
    if (isNaN(idx) || idx < 0 || idx >= songs.length) return;
    song = songs[idx];
    saveCurrentId(song.id);
    activeTrackIdx = 0;
    selectedNoteIds.clear();
    playheadBeat = 0;
    syncUI();
    render();
    updateStatus();
    showToast(`「${song.name}」を読み込みました`);
  });

  // API Key modal
  document.getElementById('btn-apikey').addEventListener('click', () => {
    const modal = document.getElementById('modal-apikey');
    const input = document.getElementById('apikey-input');
    const { loadApiKey } = window.__storage ?? {};
    modal.classList.remove('hidden');
    // storage経由で取得（循環回避のためimportは動的に参照）
    import('./storage.js').then(m => { input.value = m.loadApiKey(); });
  });
  document.getElementById('btn-apikey-cancel').addEventListener('click', () => {
    document.getElementById('modal-apikey').classList.add('hidden');
  });
  document.getElementById('btn-apikey-save').addEventListener('click', () => {
    import('./storage.js').then(m => {
      m.saveApiKey(document.getElementById('apikey-input').value.trim());
      document.getElementById('modal-apikey').classList.add('hidden');
      showToast('APIキーを保存しました');
    });
  });
}

/* ========== ステータスバー ========== */
function updateStatus() {
  const noteCount = song.tracks.reduce((s, t) => s + t.notes.length, 0);
  document.getElementById('status-notes').textContent = `ノート数: ${noteCount}`;
  const bar  = Math.floor(playheadBeat / BEATS_PER_BAR) + 1;
  const beat = Math.floor(playheadBeat % BEATS_PER_BAR) + 1;
  document.getElementById('status-pos').textContent = `位置: ${bar}:${beat}:0`;
}

/* ========== オートセーブ ========== */
let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSong(song), 600);
}

/* ========== Toast ========== */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

/* ========== AI連携ブリッジ（ai.jsから呼ぶ） ========== */
export function getActiveSong()  { return song; }
export function getActiveTrackIdx() { return activeTrackIdx; }
export function addNotesToActiveTrack(notes) {
  const track = song.tracks[activeTrackIdx];
  if (!track) return;
  notes.forEach(n => { if (!n.id) n.id = generateId(); track.notes.push(n); });
  autosave(); render(); updateStatus();
}
export function replaceActiveTrackNotes(notes) {
  const track = song.tracks[activeTrackIdx];
  if (!track) return;
  track.notes = notes.map(n => ({ ...n, id: n.id || generateId() }));
  autosave(); render(); updateStatus();
}
export { showToast };

/* ========== 起動 ========== */
init();
