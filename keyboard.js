/**
 * keyboard.js — 仮想ピアノ鍵盤 + PCキーボード入力 + 録音
 *
 * 停止中: ステップ入力（プレイヘッドが quantize 分ずつ進む）
 * 再生中: リアルタイム録音（押した瞬間〜離した瞬間のビート数で音符長を算出）
 *
 * PCキーマップ（1オクターブ, baseOctave 起点）:
 *   白鍵: A S D F G H J K → C D E F G A B C(+1oct)
 *   黒鍵: W E   T Y U     → C# D# F# G# A#
 *
 * オクターブ切替: 画面上の「◀ oct -」「oct + ▶」ボタン
 */

import { engine } from './engine.js';
import {
  getActiveTrack, getPlayheadBeat, setPlayheadBeat,
  addNotesToActiveTrack,
} from './editor.js';
import { generateId } from './storage.js';

/* ===== 定数 ===== */
const WHITE_W = 36;   // 白鍵の幅 (px)
const WHITE_H = 100;  // 白鍵の高さ (px)
const BLACK_W = 22;   // 黒鍵の幅 (px)
const BLACK_H = 62;   // 黒鍵の高さ (px)

// 1オクターブ内の白鍵/黒鍵のセミトーンオフセット（C=0 基準）
const WHITE_SEMITONES       = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const BLACK_SEMITONES       = [1, 3, 6, 8, 10];        // C# D# F# G# A#
// 各黒鍵の左端の計算に使う「その直前の白鍵のオクターブ内インデックス」
const BLACK_AFTER_WHITE_IDX = [0, 1, 3, 4, 5];

// PCキー → C(baseOctave) からのセミトーンオフセット
const PC_KEY_MAP = {
  a: 0, w: 1, s: 2, e: 3, d: 4,
  f: 5, t: 6, g: 7, y: 8, h: 9,
  u: 10, j: 11, k: 12,
};

/* ===== 状態 ===== */
let baseOctave = 4;    // デフォルト C4（MIDI60）
let isVisible  = false;

// key → { beat: number, pitch: number }
const activeNotes = new Map();

/* ===== MIDI ピッチ計算 ===== */
// MIDI 60 = C4 = (4+1)*12 = 60 ✓
function pitchOf(semitoneOffset) {
  return (baseOctave + 1) * 12 + semitoneOffset;
}

/* ===== 初期化 ===== */
(function init() {
  document.getElementById('tool-keyboard')
    ?.addEventListener('click', toggleKeyboard);

  document.getElementById('kb-oct-down')
    ?.addEventListener('click', () => {
      baseOctave = Math.max(1, baseOctave - 1);
      updateOctaveLabel();
      renderKeys();
    });

  document.getElementById('kb-oct-up')
    ?.addEventListener('click', () => {
      baseOctave = Math.min(7, baseOctave + 1);
      updateOctaveLabel();
      renderKeys();
    });

  document.addEventListener('keydown', onPCKeyDown);
  document.addEventListener('keyup',   onPCKeyUp);

  renderKeys();
})();

/* ===== 表示トグル ===== */
function toggleKeyboard() {
  isVisible = !isVisible;
  document.getElementById('kb-panel')
    ?.classList.toggle('visible', isVisible);
  document.getElementById('tool-keyboard')
    ?.classList.toggle('active', isVisible);
}

/* ===== オクターブラベル更新 ===== */
function updateOctaveLabel() {
  const el = document.getElementById('kb-oct-label');
  if (el) el.textContent = 'C' + baseOctave;
}

/* ===== 鍵盤HTML生成（2オクターブ = 14白鍵） ===== */
function renderKeys() {
  const container = document.getElementById('kb-keys');
  if (!container) return;
  container.innerHTML = '';

  // コンテナサイズ
  container.style.width  = (14 * WHITE_W + 2) + 'px';
  container.style.height = (WHITE_H + 2) + 'px';

  // ── 白鍵（z-index 低い方を先に追加）──
  for (let oct = 0; oct < 2; oct++) {
    WHITE_SEMITONES.forEach((semi, wi) => {
      const pitch    = pitchOf(oct * 12 + semi);
      const globalWi = oct * 7 + wi;

      const el = document.createElement('div');
      el.className    = 'kb-white';
      el.dataset.pitch = pitch;
      el.style.left   = (globalWi * WHITE_W) + 'px';
      el.style.width  = (WHITE_W - 1) + 'px';
      el.style.height = WHITE_H + 'px';

      // PCキーラベルは第1オクターブのみ表示
      if (oct === 0) {
        const pcKey = Object.keys(PC_KEY_MAP).find(k => PC_KEY_MAP[k] === semi);
        if (pcKey) {
          const lbl = document.createElement('span');
          lbl.className   = 'kb-label';
          lbl.textContent = pcKey.toUpperCase();
          el.appendChild(lbl);
        }
      }

      attachKeyEvents(el, pitch);
      container.appendChild(el);
    });
  }

  // ── 黒鍵（白鍵より手前に重ねるため後から追加）──
  for (let oct = 0; oct < 2; oct++) {
    BLACK_SEMITONES.forEach((semi, bi) => {
      const pitch      = pitchOf(oct * 12 + semi);
      const afterWhite = oct * 7 + BLACK_AFTER_WHITE_IDX[bi];

      const el = document.createElement('div');
      el.className    = 'kb-black';
      el.dataset.pitch = pitch;
      el.style.left   = (afterWhite * WHITE_W + WHITE_W - Math.floor(BLACK_W / 2)) + 'px';
      el.style.width  = BLACK_W + 'px';
      el.style.height = BLACK_H + 'px';

      attachKeyEvents(el, pitch);
      container.appendChild(el);
    });
  }
}

/* ===== マウスイベント ===== */
function attachKeyEvents(el, pitch) {
  const noteKey = 'mouse_' + pitch;
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    startNote(noteKey, pitch);
  });
  el.addEventListener('mouseup',    () => endNote(noteKey));
  el.addEventListener('mouseleave', () => {
    if (activeNotes.has(noteKey)) endNote(noteKey);
  });
}

/* ===== 音符開始 ===== */
function startNote(noteKey, pitch) {
  if (activeNotes.has(noteKey)) return;
  if (pitch < 24 || pitch > 107) return; // ピアノロール表示範囲外は無視

  // プレビュー再生
  const track = getActiveTrack();
  engine.previewNote(pitch, track?.instrument ?? 'sine');

  // 開始ビートを記憶（再生中なら現在ビート、停止中ならプレイヘッド）
  const beat = engine.isPlaying ? engine.currentBeat : getPlayheadBeat();
  activeNotes.set(noteKey, { beat, pitch });

  // 視覚フィードバック
  setKeyHighlight(pitch, true);
}

/* ===== 音符終了 ===== */
function endNote(noteKey) {
  if (!activeNotes.has(noteKey)) return;
  const { beat, pitch } = activeNotes.get(noteKey);
  activeNotes.delete(noteKey);
  setKeyHighlight(pitch, false);

  let duration;
  if (engine.isPlaying) {
    // リアルタイム録音: 押している間のビート数、最小16分音符に丸める
    const raw = Math.max(0, engine.currentBeat - beat);
    duration  = Math.max(0.0625, Math.round(raw / 0.0625) * 0.0625);
  } else {
    // ステップ入力: 現在の量子化値を音符長として使用
    const qEl = document.getElementById('quantize');
    duration  = qEl ? parseFloat(qEl.value) : 0.25;
    // プレイヘッドを1音符分前進
    setPlayheadBeat(beat + duration);
  }

  addNotesToActiveTrack([{
    id: generateId(),
    pitch,
    beat,
    duration,
    velocity: 100,
  }]);
}

/* ===== キーのハイライト切替 ===== */
function setKeyHighlight(pitch, on) {
  document.querySelectorAll('[data-pitch="' + pitch + '"]').forEach(el => {
    el.classList.toggle('kb-active', on);
  });
}

/* ===== PCキーボードイベント ===== */
function onPCKeyDown(e) {
  if (!isVisible) return;
  // 入力フィールドでの操作は無視
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  // 修飾キー付きは無視
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // キーリピートは無視（最初の押下のみ）
  if (e.repeat) return;

  const semi = PC_KEY_MAP[e.key.toLowerCase()];
  if (semi === undefined) return;

  e.preventDefault(); // スクロールなどのデフォルト動作を防ぐ
  startNote('pc_' + e.key.toLowerCase(), pitchOf(semi));
}

function onPCKeyUp(e) {
  if (!isVisible) return;
  const semi = PC_KEY_MAP[e.key.toLowerCase()];
  if (semi === undefined) return;
  endNote('pc_' + e.key.toLowerCase());
}
