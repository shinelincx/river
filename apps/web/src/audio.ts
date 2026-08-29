export type TableAudioCue = 'deal' | 'action' | 'turn' | 'settle' | 'tick' | 'allIn';

const STORAGE_KEY = 'river-table-audio-enabled';
const listeners = new Set<() => void>();

function storedPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try { return window.localStorage.getItem(STORAGE_KEY) !== 'false'; }
  catch { return true; }
}

class TableAudio {
  private enabled = storedPreference();
  private context?: AudioContext;
  private master?: GainNode;
  private musicTimer?: number;
  private musicStep = 0;
  private tableActive = false;

  getEnabled = (): boolean => this.enabled;

  setEnabled(next: boolean): void {
    if (this.enabled === next) return;
    this.enabled = next;
    try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* Preference remains in memory. */ }
    for (const listener of listeners) listener();
    if (next) void this.unlock();
    else {
      this.stopMusic();
      if (this.context?.state === 'running') void this.context.suspend();
    }
  }

  enterTable(): void {
    this.tableActive = true;
    void this.unlock();
  }

  leaveTable(): void {
    this.tableActive = false;
    this.stopMusic();
  }

  async unlock(): Promise<boolean> {
    if (!this.enabled || typeof window === 'undefined') return false;
    if (!this.context) {
      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return false;
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    if (this.context.state === 'running' && this.tableActive) this.startMusic();
    return this.context.state === 'running';
  }

  play(cue: TableAudioCue): void {
    if (!this.enabled || !this.tableActive) return;
    void this.unlock().then((ready) => {
      if (!ready) return;
      const notes: Record<TableAudioCue, number[]> = {
        deal: [392, 523],
        action: [196],
        turn: [659, 880],
        settle: [523, 659, 784],
        tick: [988],
        allIn: [147, 220, 294]
      };
      const duration = cue === 'settle' || cue === 'allIn' ? 0.18 : cue === 'tick' ? 0.055 : 0.1;
      notes[cue].forEach((frequency, index) => this.tone(frequency, this.context!.currentTime + index * 0.075, duration, cue === 'tick' ? 0.08 : 0.14, cue === 'action' ? 'triangle' : 'sine'));
      if (cue === 'allIn' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
        const announcement = new SpeechSynthesisUtterance('all in');
        Object.assign(announcement, { lang: 'en-US', rate: 0.86, pitch: 0.82, volume: 0.9 });
        window.speechSynthesis.speak(announcement);
      }
    });
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
