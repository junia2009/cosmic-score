/**
 * ai.js — Gemini API 連携
 *
 * 機能:
 *   1. ゼロ生成: 雰囲気ボタンを選んで「生成」→ 新しいノート列をアクティブトラックに追加
 *   2. アレンジ: 既存ノートデータをGeminiに渡して続き/ハモリ等を追加
 *
 * 使用モデル: gemini-2.0-flash
 * APIキー: LocalStorage (cosmic_score_apikey) から取得
 */

import { loadApiKey }                                          from './storage.js';
import { getActiveSong, getActiveTrackIdx, addNotesToActiveTrack, replaceActiveTrackNotes, showToast } from './editor.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/* ======================================================
   Gemini API 呼び出し
   ====================================================== */
async function callGemini(prompt) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    showToast('APIキーを設定してください（右上 🔑）');
    return null;
  }

  const body = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.9,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  };

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message ?? res.statusText;
    showToast(`Gemini エラー: ${msg}`);
    return null;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text;
}

/* ======================================================
   JSON抽出ヘルパー
   ====================================================== */
function extractJson(text) {
  // コードブロック内のJSONを取り出す
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw   = fence ? fence[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch {
    // 配列だけ抽出を試みる
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch {}
    }
    return null;
  }
}

/* ======================================================
   ノートデータのバリデーション
   ====================================================== */
function validateNotes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(n =>
    typeof n.pitch    === 'number' && n.pitch    >= 24 && n.pitch    <= 107 &&
    typeof n.beat     === 'number' && n.beat     >= 0  &&
    typeof n.duration === 'number' && n.duration >  0  &&
    typeof n.velocity === 'number' && n.velocity >= 1  && n.velocity <= 127
  );
}

/* ======================================================
   システムプロンプト共通部分
   ====================================================== */
const NOTE_SCHEMA = `
Note JSON schema (return an array of these):
{
  "pitch":    integer 24–107 (MIDI note number, e.g. 60=C4),
  "beat":     number ≥ 0 (start beat, 0-indexed, 4/4 time),
  "duration": number > 0 (length in beats, e.g. 0.25=16th, 0.5=8th, 1=quarter),
  "velocity": integer 1–127
}
Return ONLY a valid JSON array, no other text. Wrap in triple backticks.
`.trim();

/* ======================================================
   ゼロ生成
   ====================================================== */
const MOOD_DETAILS = {
  bright: '明るく楽しい。長調。C major または G major。テンポ感がある。跳躍を含む',
  dark:   '暗くドラマティック。短調。A minor または D minor。重厚感があり、低音を活用する',
  calm:   '落ち着いた穏やかな雰囲気。長調または自然短調。音域は中程度。ゆったりしたリズム',
  epic:   '壮大でオーケストラ的。長調。高い音域と低い音域を対比させ、スケールを表現する',
};

async function generateFromMood(mood, prompt) {
  const moodDesc = MOOD_DETAILS[mood] ?? '自由な雰囲気';
  const song = getActiveSong();

  const fullPrompt = `
You are music composer AI. Generate a short melodic phrase.
Mood: ${moodDesc}
BPM: ${song.bpm}
Length: 8 beats (2 bars)
${prompt ? `Additional instruction: ${prompt}` : ''}

${NOTE_SCHEMA}
`.trim();

  setLoading(true);
  const text = await callGemini(fullPrompt);
  setLoading(false);
  if (!text) return;

  const parsed = extractJson(text);
  const notes  = validateNotes(parsed);
  if (notes.length === 0) { showToast('ノートデータの取得に失敗しました'); return; }

  addNotesToActiveTrack(notes);
  showToast(`✨ ${notes.length}ノートを生成しました`);
}

/* ======================================================
   アレンジ（既存ノートを渡して続き/ハモリ）
   ====================================================== */
async function arrangeExisting(prompt) {
  const song        = getActiveSong();
  const trackIdx    = getActiveTrackIdx();
  const track       = song.tracks[trackIdx];
  if (!track || track.notes.length === 0) {
    showToast('アクティブトラックにノートがありません');
    return;
  }

  const existingJson = JSON.stringify(track.notes.map(n => ({
    pitch: n.pitch, beat: n.beat, duration: n.duration, velocity: n.velocity
  })));

  const instruction = prompt || '続きのメロディを8ビート分作ってください';

  const fullPrompt = `
You are a music composer AI.
BPM: ${song.bpm}
Existing notes (JSON):
${existingJson}

Task: ${instruction}
Generate new notes that fit well with the existing phrase. 
Place new notes after the last note in the existing array (do not overlap).

${NOTE_SCHEMA}
`.trim();

  setLoading(true);
  const text = await callGemini(fullPrompt);
  setLoading(false);
  if (!text) return;

  const parsed = extractJson(text);
  const notes  = validateNotes(parsed);
  if (notes.length === 0) { showToast('ノートデータの取得に失敗しました'); return; }

  addNotesToActiveTrack(notes);
  showToast(`🎵 ${notes.length}ノートを追加しました`);
}

/* ======================================================
   UI ヘルパー
   ====================================================== */
function setLoading(on) {
  const genBtn     = document.getElementById('btn-ai-gen');
  const arrBtn     = document.getElementById('btn-ai-arrange');
  if (on) {
    genBtn.textContent = '生成中…';
    genBtn.disabled    = true;
    arrBtn.disabled    = true;
  } else {
    genBtn.textContent = '生成';
    genBtn.disabled    = false;
    arrBtn.disabled    = false;
  }
}

/* ======================================================
   イベントバインド
   ====================================================== */
let selectedMood = '';

document.querySelectorAll('.mood-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedMood = btn.dataset.mood;
    document.querySelectorAll('.mood-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

document.getElementById('btn-ai-gen').addEventListener('click', async () => {
  const prompt = document.getElementById('ai-prompt').value.trim();
  if (!selectedMood && !prompt) {
    showToast('雰囲気ボタンを選ぶか、プロンプトを入力してください');
    return;
  }
  await generateFromMood(selectedMood || 'bright', prompt);
});

document.getElementById('btn-ai-arrange').addEventListener('click', async () => {
  const prompt = document.getElementById('ai-prompt').value.trim();
  await arrangeExisting(prompt);
});
