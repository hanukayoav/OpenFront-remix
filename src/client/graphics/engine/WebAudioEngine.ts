/**
 * OpenFront Zero-Asset Procedural Audio System (WebAudioEngine)
 *
 * Implements synthetic procedural sound effects directly synthesized in real-time
 * via the browser native Web Audio API without loading or requesting external media files:
 * - playTroopLaunch(): High speed rising square wave chirp (0.05s).
 * - playDropClaim(): Dual tone major chord chime (sine waves, 0.15s) with a light gain envelope.
 * - playExplosionShake(): Low frequency noise buffer burst (40 to 60 Hz) layered with a fast decaying saw oscillator.
 * - playOrbitalAlert(): Distinct two stage klaxon tone for late phase drops.
 *
 * Includes lazy AudioContext initialization to comply with browser autoplay security policies,
 * global mute toggle with localStorage persistence, and clean lifecycle teardown.
 */

export class WebAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private _isMuted = false;
  private muteButton: HTMLElement | null = null;
  private autoplayUnlockBound: (() => void) | null = null;
  private keydownBound: ((e: KeyboardEvent) => void) | null = null;

  public static readonly STORAGE_KEY = "openfront_audio_muted";

  constructor() {
    this.loadMuteState();
    this.setupAutoplayUnlocking();
  }

  /**
   * Reads persistent mute preference from localStorage.
   */
  private loadMuteState(): void {
    try {
      if (typeof localStorage !== "undefined") {
        const stored = localStorage.getItem(WebAudioEngine.STORAGE_KEY);
        this._isMuted = stored === "true";
      }
    } catch {
      this._isMuted = false;
    }
  }

  /**
   * Attaches one-time window gesture listeners to cleanly resume suspended AudioContext
   * once user interacts with the page, respecting browser autoplay policies.
   */
  private setupAutoplayUnlocking(): void {
    if (typeof window === "undefined") return;

    const unlock = () => {
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      this.removeAutoplayListeners();
    };

    this.autoplayUnlockBound = unlock;
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true, passive: true });
  }

  private removeAutoplayListeners(): void {
    if (typeof window === "undefined" || !this.autoplayUnlockBound) return;
    window.removeEventListener("pointerdown", this.autoplayUnlockBound);
    window.removeEventListener("keydown", this.autoplayUnlockBound);
    this.autoplayUnlockBound = null;
  }

  /**
   * Lazily initializes the native AudioContext and master gain node on demand.
   */
  public ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    if (typeof window === "undefined") return null;

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextClass) return null;

    try {
      this.ctx = new AudioContextClass();
      this.masterGain = this.ctx.createGain();
      const initialVolume = this._isMuted ? 0 : 0.35;
      this.masterGain.gain.setValueAtTime(initialVolume, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    } catch {
      return null;
    }

    return this.ctx;
  }

  public get audioContext(): AudioContext | null {
    return this.ctx;
  }

  public get isMuted(): boolean {
    return this._isMuted;
  }

  public setMuted(muted: boolean): void {
    this._isMuted = muted;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(WebAudioEngine.STORAGE_KEY, muted ? "true" : "false");
      }
    } catch {
      // Storage unavailable fallback
    }

    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(muted ? 0 : 0.35, now);
    }

    this.updateMuteButtonVisual();
  }

  public toggleMute(): boolean {
    this.setMuted(!this._isMuted);
    return this._isMuted;
  }

  // ============================================================
  // PROCEDURAL SYNTH SOUND EFFECTS
  // ============================================================

  /**
   * playTroopLaunch(): High speed rising square wave chirp (0.05s duration).
   * Synthesizes an energetic launch cue with zero media files.
   */
  public playTroopLaunch(): void {
    if (this._isMuted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "square";
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(920, now + 0.05);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start(now);
      osc.stop(now + 0.05);
    } catch {
      // Fail-safe for background tab throttling
    }
  }

  /**
   * playDropClaim(): Dual tone major chord chime (sine waves, 0.15s duration)
   * with a smooth attack and exponential decay gain envelope.
   */
  public playDropClaim(): void {
    if (this._isMuted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      // C5 (523.25 Hz) + E5 (659.25 Hz) major third interval chime
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = "sine";
      osc2.type = "sine";
      osc1.frequency.setValueAtTime(523.25, now);
      osc2.frequency.setValueAtTime(659.25, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.22, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.masterGain);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.15);
      osc2.stop(now + 0.15);
    } catch {
      // Fail-safe
    }
  }

  /**
   * playExplosionShake(): Low frequency noise buffer burst (40 to 60 Hz)
   * layered with a fast decaying saw oscillator for screen shake impacts.
   */
  public playExplosionShake(): void {
    if (this._isMuted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const duration = 0.28;

      // 1. Procedural Noise Buffer Burst filtered to 40 - 60 Hz
      const sampleRate = ctx.sampleRate || 44100;
      const bufferSize = Math.floor(sampleRate * duration);
      const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = "bandpass";
      bandpass.frequency.setValueAtTime(50, now);
      bandpass.Q.setValueAtTime(1.8, now);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.4, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noiseSource.connect(bandpass);
      bandpass.connect(noiseGain);
      noiseGain.connect(this.masterGain);

      noiseSource.start(now);
      noiseSource.stop(now + duration);

      // 2. Layered decaying saw oscillator (80 Hz down to 32 Hz)
      const sawOsc = ctx.createOscillator();
      const sawGain = ctx.createGain();

      sawOsc.type = "sawtooth";
      sawOsc.frequency.setValueAtTime(80, now);
      sawOsc.frequency.exponentialRampToValueAtTime(32, now + duration);

      sawGain.gain.setValueAtTime(0.3, now);
      sawGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      sawOsc.connect(sawGain);
      sawGain.connect(this.masterGain);

      sawOsc.start(now);
      sawOsc.stop(now + duration);
    } catch {
      // Fail-safe
    }
  }

  /**
   * playOrbitalAlert(): Distinct two stage klaxon tone for late phase drops.
   * Stage 1: 440 Hz low warning pulse (0.16s)
   * Stage 2: 740 Hz high warning pulse (0.22s)
   */
  public playOrbitalAlert(): void {
    if (this._isMuted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;

      // Stage 1: Lower alert pulse (0.0s to 0.16s)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();

      osc1.type = "sawtooth";
      osc1.frequency.setValueAtTime(440, now);

      gain1.gain.setValueAtTime(0.18, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.16);

      osc1.connect(gain1);
      gain1.connect(this.masterGain);

      osc1.start(now);
      osc1.stop(now + 0.16);

      // Stage 2: Higher alert pulse (0.19s to 0.40s)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();

      osc2.type = "sawtooth";
      osc2.frequency.setValueAtTime(740, now + 0.19);

      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(0.24, now + 0.19);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.40);

      osc2.connect(gain2);
      gain2.connect(this.masterGain);

      osc2.start(now + 0.19);
      osc2.stop(now + 0.40);
    } catch {
      // Fail-safe
    }
  }

  // ============================================================
  // UI MUTE TOGGLE BUTTON
  // ============================================================

  /**
   * Attach a floating glassmorphism audio mute button to the top corner of the UI.
   */
  public attachMuteButton(container: HTMLElement = document.body): HTMLElement {
    if (this.muteButton) return this.muteButton;

    const btn = document.createElement("button");
    btn.id = "openfront-procedural-audio-toggle";
    btn.type = "button";
    btn.className =
      "fixed top-3 right-16 z-50 flex items-center justify-center w-10 h-10 rounded-xl " +
      "bg-slate-900/80 hover:bg-slate-800/90 text-white/90 border border-white/15 " +
      "backdrop-blur-md shadow-lg transition-all duration-150 active:scale-95 cursor-pointer pointer-events-auto";
    btn.style.pointerEvents = "auto";
    btn.setAttribute("aria-label", "Toggle procedural audio mute");
    btn.title = "Toggle Sound (M)";

    btn.addEventListener("click", () => {
      this.ensureContext();
      this.toggleMute();
    });

    this.muteButton = btn;
    this.updateMuteButtonVisual();
    container.appendChild(btn);

    // Keyboard shortcut 'M' to toggle mute (ignoring input fields)
    this.keydownBound = (e: KeyboardEvent) => {
      if (
        (e.key === "m" || e.key === "M") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        this.ensureContext();
        this.toggleMute();
      }
    };
    window.addEventListener("keydown", this.keydownBound);

    return btn;
  }

  private updateMuteButtonVisual(): void {
    if (!this.muteButton) return;

    if (this._isMuted) {
      // Muted Speaker Icon (SVG with slash)
      this.muteButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <line x1="23" y1="9" x2="17" y2="15"></line>
          <line x1="17" y1="9" x2="23" y2="15"></line>
        </svg>
      `;
      this.muteButton.title = "Unmute Sound (M)";
    } else {
      // Active Speaker Icon (SVG with sound waves)
      this.muteButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      `;
      this.muteButton.title = "Mute Sound (M)";
    }
  }

  // ============================================================
  // CLEAN LIFECYCLE TEARDOWN
  // ============================================================

  /**
   * Cleanly teardown audio context, remove DOM elements, and remove event listeners.
   */
  public dispose(): void {
    this.removeAutoplayListeners();

    if (this.keydownBound && typeof window !== "undefined") {
      window.removeEventListener("keydown", this.keydownBound);
      this.keydownBound = null;
    }

    if (this.muteButton) {
      this.muteButton.remove();
      this.muteButton = null;
    }

    if (this.ctx) {
      try {
        if (this.ctx.state !== "closed") {
          this.ctx.close().catch(() => {});
        }
      } catch {
        // Fallback
      }
      this.ctx = null;
    }

    this.masterGain = null;
  }
}
