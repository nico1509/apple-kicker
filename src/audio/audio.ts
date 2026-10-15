/**
 * All sounds are synthesised with the Web Audio API so that the game needs no
 * external assets. The engine is created lazily on the first user gesture.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rainGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainTarget = 0;
  private windTarget = 0;
  muted = false;

  get ready(): boolean {
    return this.ctx !== null;
  }

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);
    // Two seconds of white noise, reused for everything noisy.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Rain loop.
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = buf;
    rainSrc.loop = true;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 3200;
    rainFilter.Q.value = 0.5;
    const rainHp = ctx.createBiquadFilter();
    rainHp.type = 'highpass';
    rainHp.frequency.value = 900;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(rainFilter).connect(rainHp).connect(this.rainGain).connect(this.master);
    rainSrc.start();

    // Wind loop.
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 260;
    this.windFilter.Q.value = 1.2;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.17;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(this.windFilter.frequency);
    lfo.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  /** Call every frame to smoothly follow the ambience targets. */
  update(dt: number): void {
    if (!this.ctx || !this.rainGain || !this.windGain) return;
    const t = this.ctx.currentTime;
    void dt;
    this.rainGain.gain.setTargetAtTime(this.rainTarget * 0.55, t, 0.4);
    this.windGain.gain.setTargetAtTime(this.windTarget * 0.5, t, 0.6);
  }

  setRain(intensity: number): void {
    this.rainTarget = Math.max(0, Math.min(1, intensity));
  }

  setWind(intensity: number): void {
    this.windTarget = Math.max(0, Math.min(1, intensity));
  }

  private thump(freqStart: number, freqEnd: number, duration: number, volume: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private burst(duration: number, volume: number, filterType: BiquadFilterType, freq: number, q = 0.8): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + duration + 0.02);
  }

  kick(power: number): void {
    this.thump(150 + 60 * power, 45, 0.14 + 0.08 * power, 0.5 + 0.4 * power);
    this.burst(0.06, 0.25 + 0.2 * power, 'highpass', 1800);
  }

  whiff(): void {
    this.burst(0.18, 0.18, 'bandpass', 900, 0.6);
  }

  bounce(strength: number): void {
    const v = Math.min(1, strength / 8);
    this.thump(170, 60, 0.07 + 0.05 * v, 0.12 + 0.3 * v);
  }

  hit(strength: number): void {
    const v = Math.min(1, strength / 8);
    this.thump(260, 90, 0.06 + 0.04 * v, 0.1 + 0.25 * v);
    this.burst(0.05, 0.1 + 0.15 * v, 'highpass', 2500);
  }

  footstep(sprinting: boolean): void {
    this.burst(sprinting ? 0.09 : 0.07, sprinting ? 0.16 : 0.1, 'lowpass', 700 + Math.random() * 300, 0.4);
  }

  thunder(volume: number): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(60, t + 3.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume * 1.1, t + 0.08);
    g.gain.exponentialRampToValueAtTime(volume * 0.35, t + 0.6);
    g.gain.exponentialRampToValueAtTime(volume * 0.8, t + 1.1);
    g.gain.exponentialRampToValueAtTime(volume * 0.25, t + 2.0);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 3.8);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 4);
  }

  chime(): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [i, f] of [523.25, 659.25, 783.99].entries()) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, t + i * 0.09 + 0.5);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.09);
      osc.stop(t + i * 0.09 + 0.55);
    }
  }

  gameOver(): void {
    this.thunder(1);
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [i, f] of [392, 349.23, 311.13].entries()) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.35);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.35 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0005, t + i * 0.35 + 0.9);
      osc.connect(flt).connect(g).connect(this.master);
      osc.start(t + i * 0.35);
      osc.stop(t + i * 0.35 + 1);
    }
  }
}
