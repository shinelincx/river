import { afterEach, describe, expect, it, vi } from 'vitest';
import { TableAudio } from './audio';

class InterruptedAudioContext {
  state: AudioContextState = 'interrupted';
  destination = {} as AudioDestinationNode;
  resume = vi.fn(async () => { this.state = 'running'; });
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn()
      },
      connect: vi.fn()
    } as unknown as GainNode;
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn()
    } as unknown as OscillatorNode;
  }
  currentTime = 0;
}

afterEach(() => vi.unstubAllGlobals());

describe('TableAudio', () => {
  it('resumes an interrupted mobile audio context after the player enters a table', async () => {
    const context = new InterruptedAudioContext();
    vi.stubGlobal('window', {
      AudioContext: class { constructor() { return context; } },
      localStorage: { getItem: () => null, setItem: vi.fn() },
      setInterval: vi.fn(),
      clearInterval: vi.fn()
    });
    const audio = new TableAudio();

    audio.enterTable();

    await expect(audio.unlock()).resolves.toBe(true);
    expect(context.resume).toHaveBeenCalled();
  });

  it('plays a built-in recording when a mobile browser does not implement Web Speech', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const sources: string[] = [];
    vi.stubGlobal('window', {
      Audio: class { play = play; constructor(source: string) { sources.push(source); } },
      localStorage: { getItem: () => null, setItem: vi.fn() }
    });
    const audio = new TableAudio();

    await expect(audio.speak('我要补码')).resolves.toBe('recording');
    await expect(audio.speak('这手稳了')).resolves.toBe('recording');
    expect(sources).toEqual(['/quick-phrases/refill.wav', '/quick-phrases/steady.wav']);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('stops and mutes voice announcements when table audio is disabled', async () => {
    const pause = vi.fn();
    vi.stubGlobal('window', {
      Audio: class {
        constructor(_source: string) {}
        play = vi.fn().mockResolvedValue(undefined);
        pause = pause;
      },
      speechSynthesis: { cancel: vi.fn() },
      localStorage: { getItem: () => null, setItem: vi.fn() }
    });
    const audio = new TableAudio();

    await expect(audio.speak('我要补码')).resolves.toBe('recording');
    audio.setEnabled(false);

    expect(pause).toHaveBeenCalledOnce();
    await expect(audio.speak('我要补码')).resolves.toBe('muted');
  });

  it('plays local voice announcements for every poker action and settlement', async () => {
    const context = new InterruptedAudioContext();
    const sources: string[] = [];
    vi.stubGlobal('window', {
      AudioContext: class { constructor() { return context; } },
      Audio: class {
        constructor(source: string) { sources.push(source); }
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play = vi.fn(async () => { this.onended?.(); });
      },
      localStorage: { getItem: () => null, setItem: vi.fn() },
      setInterval: vi.fn(),
      clearInterval: vi.fn()
    });
    const audio = new TableAudio();

    audio.enterTable();
    await audio.unlock();
    for (const cue of ['fold', 'check', 'call', 'bet', 'raise', 'allIn'] as const) audio.play(cue);
    audio.play('settle');
    await Promise.resolve();
    await Promise.resolve();

    expect(sources).toEqual([
      '/game-voices/fold.wav',
      '/game-voices/check.wav',
      '/game-voices/call.wav',
      '/game-voices/bet.wav',
      '/game-voices/raise.wav',
      '/game-voices/all-in.wav',
      '/game-voices/settle.wav'
    ]);
  });
});
