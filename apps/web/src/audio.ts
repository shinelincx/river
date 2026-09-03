export type TableActionAudioCue = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn';
export type TableAudioCue = 'deal' | TableActionAudioCue | 'turn' | 'settle' | 'tick';
export type TableSpeechResult = 'speech' | 'recording' | 'muted' | 'unsupported';

const STORAGE_KEY = 'river-table-audio-enabled';
const listeners = new Set<() => void>();
const quickPhraseRecordings: Record<string, string> = {
  '我要补码': 'refill.wav',
  '6 6 6 打得不错': 'good-play.wav',
  '搞快点 搞快点': 'hurry.wav',
  '我很大': 'strong.wav',
  '含住': 'hold.wav',
  '不玩啦': 'leave.wav',
  '跟到底！': 'call-to-end.wav',
  '这手稳了': 'steady.wav'
};
const gameCueRecordings: Partial<Record<TableAudioCue, string>> = {
  fold: 'fold.wav',
  check: 'check.wav',
  call: 'call.wav',
  bet: 'bet.wav',
  raise: 'raise.wav',
  settle: 'settle.wav',
  allIn: 'all-in.wav'
};

function storedPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try { return window.localStorage.getItem(STORAGE_KEY) !== 'false'; }
  catch { return true; }
}

export class TableAudio {
  private enabled = storedPreference();
  private context?: AudioContext;
  private master?: GainNode;
  private musicTimer?: number;
  private musicStep = 0;
  private tableActive = false;
  private removeGestureUnlock?: () => void;
  private announcementQueue: string[] = [];
  private announcementPlaying = false;
  private currentAnnouncement?: HTMLAudioElement;
  private quickPhraseAnnouncement?: HTMLAudioElement;

  getEnabled = (): boolean => this.enabled;

  setEnabled(next: boolean): void {
    if (this.enabled === next) return;
    this.enabled = next;
    try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* Preference remains in memory. */ }
    for (const listener of listeners) listener();
    if (next) {
      this.armGestureUnlock();
      void this.unlock();
    }
    else {
      this.disarmGestureUnlock();
      this.stopMusic();
      this.stopVoiceAnnouncements();
      if (this.context?.state === 'running') void this.context.suspend();
    }
  }

  enterTable(): void {
    this.tableActive = true;
    this.armGestureUnlock();
    void this.unlock();
  }

  leaveTable(): void {
    this.tableActive = false;
    this.disarmGestureUnlock();
    this.stopMusic();
    this.stopVoiceAnnouncements();
  }

  async unlock(): Promise<boolean> {
    if (!this.enabled || typeof window === 'undefined') return false;
    if (!this.context) {
      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return false;
      try { this.context = new AudioContextClass(); }
      catch { return false; }
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);
    }
    if (this.context.state !== 'running') {
      try { await this.context.resume(); }
      catch { return false; }
    }
    if (this.context.state === 'running' && this.tableActive) this.startMusic();
    const ready = this.context.state === 'running';
    if (ready) this.disarmGestureUnlock();
    return ready;
  }

  play(cue: TableAudioCue): void {
    if (!this.enabled || !this.tableActive) return;
    void this.unlock().then((ready) => {
      if (!ready) return;
      const notes: Record<TableAudioCue, number[]> = {
        deal: [392, 523],
        fold: [165, 131],
        check: [392],
        call: [523, 659],
        bet: [220, 330],
        raise: [220, 330, 440],
        turn: [659, 880],
        settle: [392, 523, 659, 784],
        tick: [988],
        allIn: [147, 220, 294]
      };
      const duration = cue === 'settle' || cue === 'allIn' ? 0.18 : cue === 'tick' ? 0.055 : 0.1;
      notes[cue].forEach((frequency, index) => this.tone(frequency, this.context!.currentTime + index * 0.075, duration, cue === 'tick' ? 0.08 : 0.14, cue === 'bet' || cue === 'raise' ? 'triangle' : 'sine'));
      const recording = gameCueRecordings[cue];
      if (recording) this.playRecording(`/game-voices/${recording}`);
    });
  }

  async speak(text: string): Promise<TableSpeechResult> {
    if (typeof window === 'undefined') return 'unsupported';
    if (!this.enabled) return 'muted';
    const SpeechSynthesisUtteranceClass = window.SpeechSynthesisUtterance;
    if (window.speechSynthesis && SpeechSynthesisUtteranceClass) try {
      const announcement = new SpeechSynthesisUtteranceClass(text);
      Object.assign(announcement, { lang: 'zh-CN', rate: 0.95, pitch: 1, volume: 1 });
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(announcement);
      return 'speech';
    } catch { /* Fall back to the recording for browsers with a broken Web Speech implementation. */ }
    const recording = quickPhraseRecordings[text];
    if (!recording || !window.Audio) return 'unsupported';
    try {
      const audio = new window.Audio(`/quick-phrases/${recording}`);
      this.quickPhraseAnnouncement = audio;
      const clearAnnouncement = () => {
        if (this.quickPhraseAnnouncement === audio) this.quickPhraseAnnouncement = undefined;
      };
      audio.onended = clearAnnouncement;
      audio.onerror = clearAnnouncement;
      await audio.play();
      if (!this.enabled) return 'muted';
      return 'recording';
    } catch { return this.enabled ? 'unsupported' : 'muted'; }
  }

  private startMusic(): void {
    if (this.musicTimer !== undefined || !this.tableActive) return;
    this.musicPulse();
    this.musicTimer = window.setInterval(() => this.musicPulse(), 1_800);
  }

  private stopMusic(): void {
    if (this.musicTimer === undefined) return;
    window.clearInterval(this.musicTimer);
    this.musicTimer = undefined;
  }

  private armGestureUnlock(): void {
    if (!this.enabled || !this.tableActive || this.removeGestureUnlock || typeof document === 'undefined') return;
    const unlockOnGesture = () => { void this.unlock(); };
    document.addEventListener('pointerdown', unlockOnGesture, { capture: true, passive: true });
    document.addEventListener('touchstart', unlockOnGesture, { capture: true, passive: true });
    this.removeGestureUnlock = () => {
      document.removeEventListener('pointerdown', unlockOnGesture, true);
      document.removeEventListener('touchstart', unlockOnGesture, true);
      this.removeGestureUnlock = undefined;
    };
  }

  private disarmGestureUnlock(): void {
    this.removeGestureUnlock?.();
  }

  private stopVoiceAnnouncements(): void {
    this.announcementQueue = [];
    this.announcementPlaying = false;
    this.currentAnnouncement?.pause();
    this.currentAnnouncement = undefined;
    this.quickPhraseAnnouncement?.pause();
    this.quickPhraseAnnouncement = undefined;
    try { window.speechSynthesis?.cancel(); } catch { /* The recording fallback has already stopped. */ }
  }

  private playRecording(source: string): void {
    if (typeof window === 'undefined' || !window.Audio) return;
    this.announcementQueue.push(source);
    this.playNextRecording();
  }

  private playNextRecording(): void {
    if (this.announcementPlaying || !this.enabled || !this.tableActive || typeof window === 'undefined' || !window.Audio) return;
    const source = this.announcementQueue.shift();
    if (!source) return;
    this.announcementPlaying = true;
    try {
      const audio = new window.Audio(source);
      this.currentAnnouncement = audio;
      const finish = () => {
        if (this.currentAnnouncement === audio) this.currentAnnouncement = undefined;
        this.announcementPlaying = false;
        this.playNextRecording();
      };
      audio.onended = finish;
      audio.onerror = finish;
      void audio.play().catch(finish);
    } catch {
      this.announcementPlaying = false;
      this.playNextRecording();
    }
  }

  private musicPulse(): void {
    if (!this.context || this.context.state !== 'running' || !this.enabled || !this.tableActive) return;
    const bass = [98, 110, 131, 110][this.musicStep % 4];
    const color = [196, 220, 262, 220][this.musicStep % 4];
    const now = this.context.currentTime;
    this.tone(bass, now, 1.4, 0.025, 'sine');
    this.tone(color, now + 0.35, 0.9, 0.014, 'sine');
    this.musicStep += 1;
  }

  private tone(frequency: number, start: number, duration: number, volume: number, type: OscillatorType): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.025, duration / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
}

export const tableAudio = new TableAudio();
export const subscribeTableAudio = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
