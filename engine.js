/**
 * engine.js — Web Audio API 演奏エンジン
 *
 * 公開API:
 *   engine.play(song, startBeat)
 *   engine.stop()
 *   engine.isPlaying → boolean
 *   engine.currentBeat → number
 *   engine.onBeatUpdate = (beat) => {}   // 毎フレームコールバック
 *
 * 音色 (instrument):
 *   'sine' | 'square' | 'sawtooth' | 'triangle'
 *   'marimba' (FM合成の簡易模倣)
 *   'bass'    (サイン波 + 低域フィルタ)
 */

const BEAT_LOOKAHEAD   = 0.1;  // 秒: どれだけ先読みしてスケジュールするか
const SCHEDULE_INTERVAL = 25;   // ms: スケジューラ呼び出し間隔

class AudioEngine {
  constructor() {
    this._ctx       = null;
    this._masterGain = null;
    this._isPlaying  = false;
    this._startTime  = 0;   // AudioContext.currentTime での開始時刻
    this._startBeat  = 0;   // 開始ビート
    this._bpm        = 120;
    this._tracks     = [];
    this._scheduledNotes = new Map(); // noteId → [sourceNode, ...]
    this._schedulerTimer = null;
    this._nextBeat   = 0;   // 次にスケジュールするビート位置
    this.onBeatUpdate = null;
    this._rafId = null;
  }

  /* ------ Public ------ */

  get isPlaying() { return this._isPlaying; }

  get currentBeat() {
    if (!this._isPlaying) return this._startBeat;
    const elapsed = this._ctx.currentTime - this._startTime;
    return this._startBeat + elapsed * (this._bpm / 60);
  }

  setMasterVolume(v) {
    if (this._masterGain) this._masterGain.gain.value = v;
  }

  play(song, startBeat = 0) {
    this.stop();
    this._ensureContext();
    this._bpm       = song.bpm;
    this._tracks    = song.tracks;
    this._startBeat = startBeat;
    this._nextBeat  = startBeat;
    this._startTime = this._ctx.currentTime;
    this._isPlaying = true;
    this._scheduleLoop();
    this._startRaf();
  }

  stop() {
    this._isPlaying = false;
    if (this._schedulerTimer) { clearInterval(this._schedulerTimer); this._schedulerTimer = null; }
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    // 再生中のノードを停止
    this._scheduledNotes.forEach(nodes => nodes.forEach(n => { try { n.stop(); } catch {} }));
    this._scheduledNotes.clear();
  }

  /* ------ Private ------ */

  _ensureContext() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._masterGain = this._ctx.createGain();
      this._masterGain.gain.value = 0.8;
      this._masterGain.connect(this._ctx.destination);
    }
    if (this._ctx.state === 'suspended') this._ctx.resume();
  }

  _scheduleLoop() {
    this._schedulerTimer = setInterval(() => {
      if (!this._isPlaying) return;
      const lookAheadTime = this._ctx.currentTime + BEAT_LOOKAHEAD;
      const lookAheadBeat = this._startBeat + (lookAheadTime - this._startTime) * (this._bpm / 60);

      this._tracks.forEach(track => {
        if (track.muted) return;
        // ソロが1つでもあれば、ソロでないトラックはスキップ
        const hasSolo = this._tracks.some(t => t.solo);
        if (hasSolo && !track.solo) return;

        track.notes.forEach(note => {
          if (note.beat >= this._nextBeat && note.beat < lookAheadBeat) {
            this._scheduleNote(track, note);
          }
        });
      });

      this._nextBeat = lookAheadBeat;
    }, SCHEDULE_INTERVAL);
  }

  _scheduleNote(track, note) {
    const key = `${track.id}_${note.id}`;
    if (this._scheduledNotes.has(key)) return;

    const ctx      = this._ctx;
    const freq     = this._midiToFreq(note.pitch);
    const startSec = this._startTime + (note.beat - this._startBeat) * (60 / this._bpm);
    const durSec   = note.duration * (60 / this._bpm);
    const vel      = (note.velocity ?? 100) / 127;

    const nodes = this._buildVoice(track.instrument, freq, startSec, durSec, vel);
    this._scheduledNotes.set(key, nodes);

    // 終了後にMapから削除
    setTimeout(() => this._scheduledNotes.delete(key), (startSec - ctx.currentTime + durSec + 0.5) * 1000);
  }

  _buildVoice(instrument, freq, startSec, durSec, vel) {
    const ctx = this._ctx;
    const gain = ctx.createGain();
    gain.connect(this._masterGain);

    const attackT  = 0.005;
    const releaseT = 0.08;

    switch (instrument) {
      case 'marimba': {
        // FM合成でマリンバ近似
        const carrier = ctx.createOscillator();
        const modOsc  = ctx.createOscillator();
        const modGain = ctx.createGain();
        carrier.type = 'sine';
        carrier.frequency.value = freq;
        modOsc.type = 'sine';
        modOsc.frequency.value = freq * 2.756;
        modGain.gain.value = freq * 3;
        modOsc.connect(modGain);
        modGain.connect(carrier.frequency);
        carrier.connect(gain);
        gain.gain.setValueAtTime(0, startSec);
        gain.gain.linearRampToValueAtTime(vel * 0.8, startSec + attackT);
        gain.gain.exponentialRampToValueAtTime(vel * 0.1, startSec + durSec * 0.5);
        gain.gain.exponentialRampToValueAtTime(0.0001, startSec + durSec);
        modOsc.start(startSec); modOsc.stop(startSec + durSec + 0.1);
        carrier.start(startSec); carrier.stop(startSec + durSec + 0.1);
        return [carrier, modOsc];
      }
      case 'bass': {
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 800;
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        osc.connect(filter);
        filter.connect(gain);
        gain.gain.setValueAtTime(0, startSec);
        gain.gain.linearRampToValueAtTime(vel * 0.9, startSec + attackT);
        gain.gain.setValueAtTime(vel * 0.9, startSec + durSec - releaseT);
        gain.gain.linearRampToValueAtTime(0.0001, startSec + durSec);
        osc.start(startSec); osc.stop(startSec + durSec + 0.1);
        return [osc];
      }
      default: {
        // sine / square / sawtooth / triangle
        const type = ['sine','square','sawtooth','triangle'].includes(instrument) ? instrument : 'sine';
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.gain.setValueAtTime(0, startSec);
        gain.gain.linearRampToValueAtTime(vel * 0.7, startSec + attackT);
        gain.gain.setValueAtTime(vel * 0.7, startSec + durSec - releaseT);
        gain.gain.linearRampToValueAtTime(0.0001, startSec + durSec);
        osc.start(startSec); osc.stop(startSec + durSec + 0.1);
        return [osc];
      }
    }
  }

  _midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  _startRaf() {
    const tick = () => {
      if (!this._isPlaying) return;
      if (this.onBeatUpdate) this.onBeatUpdate(this.currentBeat);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }
}

export const engine = new AudioEngine();

// master volume をUIと同期
document.getElementById('master-vol')?.addEventListener('input', e => {
  engine.setMasterVolume(parseFloat(e.target.value));
});
