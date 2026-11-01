import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAudioEngine } from "../../../src/client/graphics/engine/WebAudioEngine";

// Mock Web Audio API primitives
class MockAudioParam {
  public value = 0;
  public setValueAtTime = vi.fn((val: number) => {
    this.value = val;
  });
  public linearRampToValueAtTime = vi.fn((val: number) => {
    this.value = val;
  });
  public exponentialRampToValueAtTime = vi.fn((val: number) => {
    this.value = val;
  });
  public cancelScheduledValues = vi.fn();
}

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

class MockGainNode {
  public gain = new MockAudioParam();
  public connect = vi.fn();
  public disconnect = vi.fn();
}

class MockOscillatorNode {
  public type: OscillatorType = "sine";
  public frequency = new MockAudioParam();
  public connect = vi.fn();
  public disconnect = vi.fn();
  public start = vi.fn();
  public stop = vi.fn();
}

class MockBiquadFilterNode {
  public type: BiquadFilterType = "lowpass";
  public frequency = new MockAudioParam();
  public Q = new MockAudioParam();
  public connect = vi.fn();
}

class MockBufferSourceNode {
  public buffer: unknown = null;
  public connect = vi.fn();
  public start = vi.fn();
  public stop = vi.fn();
}

class MockAudioContext {
  public state: AudioContextState = "running";
  public currentTime = 10.0;
  public sampleRate = 44100;
  public destination = {};

  public createdOscillators: MockOscillatorNode[] = [];
  public createdGains: MockGainNode[] = [];
  public createdFilters: MockBiquadFilterNode[] = [];
  public createdSources: MockBufferSourceNode[] = [];

  public createGain = vi.fn(() => {
    const g = new MockGainNode();
    this.createdGains.push(g);
    return g as unknown as GainNode;
  });

  public createOscillator = vi.fn(() => {
    const osc = new MockOscillatorNode();
    this.createdOscillators.push(osc);
    return osc as unknown as OscillatorNode;
  });

  public createBiquadFilter = vi.fn(() => {
    const f = new MockBiquadFilterNode();
    this.createdFilters.push(f);
    return f as unknown as BiquadFilterNode;
  });

  public createBufferSource = vi.fn(() => {
    const s = new MockBufferSourceNode();
    this.createdSources.push(s);
    return s as unknown as AudioBufferSourceNode;
  });

  public createBuffer = vi.fn((_channels: number, size: number) => {
    const data = new Float32Array(size);
    return {
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  });

  public resume = vi.fn(async () => {
    this.state = "running";
  });

  public close = vi.fn(async () => {
    this.state = "closed";
  });
}

describe("WebAudioEngine (Zero Asset Procedural Audio System)", () => {
  let mockCtxInstance: MockAudioContext;
  let originalAudioContext: unknown;
  let originalLocalStorage: unknown;
  let storageMock: MockStorage;

  beforeEach(() => {
    mockCtxInstance = new MockAudioContext();
    originalAudioContext = (window as unknown as { AudioContext: unknown }).AudioContext;
    (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(function () {
      return mockCtxInstance;
    });

    storageMock = new MockStorage();
    originalLocalStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: storageMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "localStorage", {
      value: storageMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
    if (originalLocalStorage !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: originalLocalStorage,
        writable: true,
        configurable: true,
      });
    }
    vi.restoreAllMocks();
  });

  describe("Lazy Initialization & Autoplay Compliance", () => {
    it("defers AudioContext creation until explicitly requested", () => {
      const audio = new WebAudioEngine();
      expect(audio.audioContext).toBeNull();

      // First explicit context request initializes AudioContext
      const ctx = audio.ensureContext();
      expect(ctx).not.toBeNull();
      expect(audio.audioContext).toBe(ctx);

      audio.dispose();
    });

    it("resumes suspended AudioContext on user interaction", async () => {
      mockCtxInstance.state = "suspended";
      const audio = new WebAudioEngine();
      audio.ensureContext();

      // Trigger user pointer interaction
      window.dispatchEvent(new Event("pointerdown"));

      expect(mockCtxInstance.resume).toHaveBeenCalled();
      audio.dispose();
    });
  });

  describe("Procedural Synth Sound Triggers", () => {
    it("playTroopLaunch() synthesizes high-speed rising square wave chirp (0.05s)", () => {
      const audio = new WebAudioEngine();
      audio.playTroopLaunch();

      expect(mockCtxInstance.createdOscillators.length).toBe(1);
      const osc = mockCtxInstance.createdOscillators[0];
      expect(osc.type).toBe("square");
      expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(260, 10.0);
      expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(920, 10.05);
      expect(osc.start).toHaveBeenCalledWith(10.0);
      expect(osc.stop).toHaveBeenCalledWith(10.05);

      audio.dispose();
    });

    it("playDropClaim() synthesizes dual-tone major chord sine chime (0.15s)", () => {
      const audio = new WebAudioEngine();
      audio.playDropClaim();

      expect(mockCtxInstance.createdOscillators.length).toBe(2);
      const osc1 = mockCtxInstance.createdOscillators[0];
      const osc2 = mockCtxInstance.createdOscillators[1];

      expect(osc1.type).toBe("sine");
      expect(osc2.type).toBe("sine");
      expect(osc1.frequency.setValueAtTime).toHaveBeenCalledWith(523.25, 10.0);
      expect(osc2.frequency.setValueAtTime).toHaveBeenCalledWith(659.25, 10.0);
      expect(osc1.stop).toHaveBeenCalledWith(10.15);
      expect(osc2.stop).toHaveBeenCalledWith(10.15);

      audio.dispose();
    });

    it("playExplosionShake() layers low-frequency noise buffer burst (40-60Hz) with decaying saw wave", () => {
      const audio = new WebAudioEngine();
      audio.playExplosionShake();

      // Noise source and bandpass filter
      expect(mockCtxInstance.createBuffer).toHaveBeenCalled();
      expect(mockCtxInstance.createdSources.length).toBe(1);
      expect(mockCtxInstance.createdFilters.length).toBe(1);
      const filter = mockCtxInstance.createdFilters[0];
      expect(filter.type).toBe("bandpass");
      expect(filter.frequency.setValueAtTime).toHaveBeenCalledWith(50, 10.0);

      // Decaying sawtooth oscillator
      expect(mockCtxInstance.createdOscillators.length).toBe(1);
      const sawOsc = mockCtxInstance.createdOscillators[0];
      expect(sawOsc.type).toBe("sawtooth");
      expect(sawOsc.frequency.setValueAtTime).toHaveBeenCalledWith(80, 10.0);
      expect(sawOsc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(32, 10.28);

      audio.dispose();
    });

    it("playOrbitalAlert() synthesizes distinct two-stage klaxon warning tone", () => {
      const audio = new WebAudioEngine();
      audio.playOrbitalAlert();

      expect(mockCtxInstance.createdOscillators.length).toBe(2);
      const stage1 = mockCtxInstance.createdOscillators[0];
      const stage2 = mockCtxInstance.createdOscillators[1];

      expect(stage1.type).toBe("sawtooth");
      expect(stage1.frequency.setValueAtTime).toHaveBeenCalledWith(440, 10.0);
      expect(stage1.stop).toHaveBeenCalledWith(10.16);

      expect(stage2.type).toBe("sawtooth");
      expect(stage2.frequency.setValueAtTime).toHaveBeenCalledWith(740, 10.19);
      expect(stage2.stop).toHaveBeenCalledWith(10.40);

      audio.dispose();
    });
  });

  describe("Global Mute Toggle & Persistence", () => {
    it("mutes audio and persists preference to localStorage", () => {
      const audio = new WebAudioEngine();
      expect(audio.isMuted).toBe(false);

      audio.setMuted(true);
      expect(audio.isMuted).toBe(true);
      expect(localStorage.getItem(WebAudioEngine.STORAGE_KEY)).toBe("true");

      // Triggers do not produce oscillators when muted
      audio.playTroopLaunch();
      expect(mockCtxInstance.createdOscillators.length).toBe(0);

      // Unmute restores sound
      audio.toggleMute();
      expect(audio.isMuted).toBe(false);
      expect(localStorage.getItem(WebAudioEngine.STORAGE_KEY)).toBe("false");

      audio.dispose();
    });

    it("loads persisted mute preference on initialisation", () => {
      localStorage.setItem(WebAudioEngine.STORAGE_KEY, "true");
      const audio = new WebAudioEngine();
      expect(audio.isMuted).toBe(true);
      audio.dispose();
    });

    it("attaches floating UI mute button and handles toggle click", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      const audio = new WebAudioEngine();
      const btn = audio.attachMuteButton(container);

      expect(btn).not.toBeNull();
      expect(container.contains(btn)).toBe(true);

      // Click toggles mute state
      btn.click();
      expect(audio.isMuted).toBe(true);

      btn.click();
      expect(audio.isMuted).toBe(false);

      audio.dispose();
      expect(container.contains(btn)).toBe(false);
      container.remove();
    });
  });

  describe("Lifecycle Teardown", () => {
    it("cleanly disposes AudioContext, removes listeners and cleans references", () => {
      const audio = new WebAudioEngine();
      audio.ensureContext();
      const btn = audio.attachMuteButton();

      audio.dispose();

      expect(mockCtxInstance.close).toHaveBeenCalled();
      expect(audio.audioContext).toBeNull();
      expect(document.body.contains(btn)).toBe(false);
    });
  });
});
