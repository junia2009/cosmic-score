/**
 * storage.js — LocalStorage 保存・読み込み
 * キー一覧:
 *   cosmic_score_songs   : Song[] (全曲リスト)
 *   cosmic_score_current : string (現在の曲ID)
 *   cosmic_score_apikey  : string (Gemini API Key)
 */

const SONGS_KEY   = 'cosmic_score_songs';
const CURRENT_KEY = 'cosmic_score_current';
const APIKEY_KEY  = 'cosmic_score_apikey';

/** @typedef {{ id:string, name:string, bpm:number, tracks:Track[] }} Song */
/** @typedef {{ id:string, name:string, color:string, instrument:string, muted:boolean, solo:boolean, notes:Note[] }} Track */
/** @typedef {{ id:string, pitch:number, beat:number, duration:number, velocity:number }} Note */

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** デフォルト曲を生成 */
export function createDefaultSong() {
  return {
    id: generateId(),
    name: 'Untitled Song',
    bpm: 120,
    tracks: [createDefaultTrack('Track 1', '#7c5cfc')],
  };
}

/** デフォルトトラックを生成 */
export function createDefaultTrack(name = 'Track', color = '#7c5cfc') {
  return {
    id: generateId(),
    name,
    color,
    instrument: 'sine',
    muted: false,
    solo: false,
    notes: [],
  };
}

/** 全曲リストを取得 */
export function loadAllSongs() {
  try {
    const raw = localStorage.getItem(SONGS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** 全曲リストを保存 */
export function saveAllSongs(songs) {
  localStorage.setItem(SONGS_KEY, JSON.stringify(songs));
}

/** 現在の曲IDを取得 */
export function loadCurrentId() {
  return localStorage.getItem(CURRENT_KEY) || null;
}

/** 現在の曲IDを保存 */
export function saveCurrentId(id) {
  localStorage.setItem(CURRENT_KEY, id);
}

/** 指定IDの曲を取得（なければnull） */
export function loadSong(id) {
  const songs = loadAllSongs();
  return songs.find(s => s.id === id) || null;
}

/** 曲を保存（存在すれば上書き、なければ追加） */
export function saveSong(song) {
  const songs = loadAllSongs();
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) songs[idx] = song;
  else songs.push(song);
  saveAllSongs(songs);
}

/** 曲を削除 */
export function deleteSong(id) {
  const songs = loadAllSongs().filter(s => s.id !== id);
  saveAllSongs(songs);
}

/** API Key を取得 */
export function loadApiKey() {
  return localStorage.getItem(APIKEY_KEY) || '';
}

/** API Key を保存 */
export function saveApiKey(key) {
  localStorage.setItem(APIKEY_KEY, key);
}

/** 現在編集中の曲を取得（なければデフォルト生成） */
export function loadCurrentSong() {
  const id = loadCurrentId();
  if (id) {
    const song = loadSong(id);
    if (song) return song;
  }
  const song = createDefaultSong();
  saveSong(song);
  saveCurrentId(song.id);
  return song;
}
