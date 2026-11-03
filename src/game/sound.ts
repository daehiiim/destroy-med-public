// 효과음·BGM. 첫 사용자 입력 전에는 AudioContext를 만들지 않는다
// 음원은 public/sfx의 AAC 64kbps .m4a (원본 mp3를 afconvert로 줄임, 출처: docs/sfx-sources.md). 못 받았거나 디코드에 실패하면 WebAudio 합성음으로 대신 낸다
import type { Rank, WeaponId } from './types.ts';
import { THERMO_FIRE, WEAPON_PARAMS } from './weapons.ts';
import { RANK_THRESHOLDS, rankTier } from './world.ts';

type LogError = (code: string, operation: string, err: unknown, input?: unknown) => void;

const FILES = [
  'rifle', 'fire-in-the-hole', 'grenade', 'shell-whine', 'mortar-launch', 'mlrs-launch', 'tank-fire', 'mortar',
  'artillery-incoming', 'artillery', 'bomb', 'nuke',
  'crowd-scream', 'scream-massive', 'scream-crowd2', 'scream-panic', 'crowd-commotion', 'crowd-yell', 'crowd-panic', 'bgm',
] as const;
type Clip = (typeof FILES)[number];

// 착탄 소리: off 음원 시작점(초), len 재생 길이(초), gain 크기, rate 재생 속도, max 동시 재생 수
const HIT: Record<WeaponId, { clip: Clip; off: number; len: number; gain: number; rate: number; max: number }> = {
  rifle: { clip: 'rifle', off: 0, len: 0.6, gain: 1.27, rate: 1, max: 4 },
  grenade: { clip: 'grenade', off: 0, len: 3, gain: 1.1, rate: 1, max: 3 },
  mortar: { clip: 'mortar', off: 0.33, len: 3.5, gain: 1.1, rate: 1, max: 3 },
  artillery: { clip: 'artillery', off: 0, len: 3.1, gain: 1.3, rate: 1, max: 3 },
  // 다연장 로켓은 포탄 음원을 조금 빠르게(로켓의 60%만 소리, index.ts)
  mlrs: { clip: 'artillery', off: 0, len: 2.2, gain: 1.0, rate: 1.15, max: 3 },
  bomb: { clip: 'bomb', off: 0, len: 5.4, gain: 1.5, rate: 0.85, max: 2 },
  // 열압력탄 착탄 순간의 작은 "펑"(유탄 음원 앞부분). 점화음은 hit()이 THERMO_FIRE초 뒤로 건다
  thermo: { clip: 'grenade', off: 0, len: 0.5, gain: 0.55, rate: 1, max: 3 },
  // 벙커버스터는 항공폭탄 음원을 더 낮게, 집속탄 자탄은 유탄 음원을 짧게 (자탄은 index.ts에서 30%만 소리를 낸다)
  bunker: { clip: 'bomb', off: 0, len: 5.4, gain: 1.6, rate: 0.7, max: 2 },
  cluster: { clip: 'grenade', off: 0, len: 1.8, gain: 0.9, rate: 1.1, max: 4 },
  // 중성자탄: 원자폭탄 폭발 + 저음 굉음 음원(앞 0.45초 무음은 건너뜀). 합성 저음 럼블(rumble)을 같이 깐다
  nuke: { clip: 'nuke', off: 0.45, len: 12, gain: 1.1, rate: 1, max: 2 },
  // 신의 지팡이: 포탄 음원을 낮게(1.4배로 올리면 "뽀용"처럼 장난스러워 0.8로 내림). 저음·럼블·늦게 오는 충격파는 hit()이 더한다
  rod: { clip: 'artillery', off: 0, len: 2.5, gain: 1.6, rate: 0.8, max: 2 },
};
// 날아오는 소리: end = 음원 안에서 휘파람이 끝나는(착탄) 시각. 무기 delay에 맞춰 앞을 잘라 착탄 순간에 끝나게 한다
// 박격포·항공폭탄은 실제 포탄 비명 녹음 하나를 같이 쓴다. 원음이 작아(-31dB) gain을 크게 주고, 속도로 포탄 크기를 나눈다(작으면 높게, 크면 낮게)
const FLY: Partial<Record<WeaponId, { clip: Clip; end: number; gain: number; rate: number }>> = {
  mortar: { clip: 'shell-whine', end: 4.68, gain: 4, rate: 1.15 },
  artillery: { clip: 'artillery-incoming', end: 1.3, gain: 0.7, rate: 1 },
  // 로켓 비행음: 다연장은 포탄 비행음을 작고 조금 빠르게(30%만), 열압력 로켓은 크게
  mlrs: { clip: 'artillery-incoming', end: 1.3, gain: 0.5, rate: 1.1 },
  thermo: { clip: 'artillery-incoming', end: 1.3, gain: 0.9, rate: 1 },
  bomb: { clip: 'shell-whine', end: 4.68, gain: 6, rate: 0.85 },
  bunker: { clip: 'shell-whine', end: 4.68, gain: 6, rate: 0.7 },
  cluster: { clip: 'shell-whine', end: 4.68, gain: 5, rate: 0.95 },
};
// 합성 대체 폭발음: [길이, 차단 주파수, 크기]
const BOOM: Record<WeaponId, [number, number, number]> = {
  rifle: [0.05, 4000, 0.35], grenade: [0.7, 1200, 0.8],
  mortar: [1.0, 900, 0.9], artillery: [1.5, 700, 1.0], bomb: [2.4, 420, 1.2], bunker: [2.6, 360, 1.25], cluster: [0.5, 1400, 0.6], nuke: [4, 300, 1.4],
  mlrs: [1.2, 800, 0.9], thermo: [0.4, 1500, 0.6], rod: [2, 900, 1.3],
};
// 군중 강도표(랭크 순서 F=0 … SSS=8): [깔리는 소리 크기, 로우패스 Hz, 비명 토막 간격(초), 비명 크기]
// 낮은 랭크는 드문드문 작게, 높은 랭크로 갈수록 가파르게 커진다
const CROWD: [number, number, number, number][] = [
  [0, 600, 4, 0.08], [0, 800, 3.5, 0.12], [0, 1100, 3, 0.19], [0.05, 1600, 2.4, 0.28], [0.12, 2300, 1.8, 0.38],
  [0.22, 3200, 1.3, 0.5], [0.34, 4300, 1.0, 0.63], [0.47, 5500, 0.8, 0.77], [0.6, 7000, 0.6, 0.93],
];
// 군중 비명 음원별 크기 보정: 중앙값 RMS를 crowd-scream(-12.6dB)에 맞춘다 (massive -20, crowd2 -16.4, panic -27dB)
// crowd-commotion·crowd-yell은 "무슨 일이야" 같은 웅성·외침이 섞인 군중 목소리. 크기는 귀로 맞출 근사치(재지 않음)
const SCREAMS: Partial<Record<Clip, number>> = {
  'crowd-scream': 1, 'scream-massive': 1.8, 'scream-crowd2': 1.5, 'scream-panic': 4, 'crowd-commotion': 1.8, 'crowd-yell': 1.8,
};
const BGM_LOOP = 64;     // bgm.m4a 루프 길이(초). 원곡 150BPM 40마디를 잘라 앞 2마디에 뒷부분을 겹쳐 둔 파일이라 이음매가 없다
const VOICE_LEN = 1.9;   // "Fire in the hole!" 길이(초)

const MASTER = 1.5;       // 컴프레서 앞 크기 (폭발음을 눌러 단단하게)
const LEVEL = 0.15;       // 음량 100%일 때 컴프레서 뒤 최종 크기. 무기(폭발) 소리 크기는 여기서 조절 (0.35 → 0.15, 약 -7dB)
const AMB = 1.26;         // LEVEL 0.44 기준으로 바뀐 만큼 BGM·군중 소리는 앞에서 되돌려 예전 크기로 들리게 한다
const CROWD_VOL = 0.2;    // 군중 소리(비명·목소리·깔린 소음) 전체 크기. 0.5에서 40%로 줄임(사이렌은 SIREN_VOL이라 그대로)
const BGM_OUT = 0.104;    // 배경음악 최종 크기. 컴프레서를 거치지 않아 LEVEL을 줄여도 예전(BGM 70%) 크기
const TRIM = 0.6;         // 전체 소리 40% 줄임(휴대폰에서 너무 큼). post 단계와 음성 합성에 함께 곱한다
const SPEECH_VOL = 0.4;   // 음성 합성 경고("Nuclear launch detected") 크기
const SIREN_LV = 3;       // 먼 사이렌이 깔리기 시작하는 랭크(F=0 … C=3, 깔린 군중 소리가 시작되는 단계). 한 번 닿으면 그 판 내내 울린다
const SIREN_VOL = 0.012;  // 먼 사이렌 크기. 메아리 포함 RMS가 C 단계 비명 한 겹(약 0.04)보다 작게 맞춘 값(귀로는 안 들어 봄)
// iOS(아이패드는 Mac처럼 보고하므로 터치 지점 수로 가린다). 음성 합성 뒤 오디오 되살리기는 iOS에서만 한다
const IOS = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export class Sound {
  on = true;
  private volume = 1;
  private ctx?: AudioContext;
  private out?: GainNode;
  private post?: GainNode;
  private echo?: DelayNode;
  private noise?: AudioBuffer;
  private bgm?: AudioBufferSourceNode;
  private bgmG?: GainNode;
  private music = true;
  private bufs = new Map<Clip, AudioBuffer>();
  private live = new Map<Clip, AudioBufferSourceNode[]>();
  private log: LogError;
  private last = 0;
  private screamT = -9;
  private rankI = RANK_THRESHOLDS.length - 1;
  private score = 0;
  private panic?: { g: GainNode; lp: BiquadFilterNode };
  private sirens = false;
  private away = false;   // 탭이 숨었다 돌아온 뒤 아직 탭을 안 했다

  constructor(log: LogError) { this.log = log; }

  // 사용자 입력 시점에 오디오를 깨우고, 처음이면 마스터 체인을 만들고 음원을 받는다
  unlock() {
    if (!this.on) return;
    if (!this.ctx) {
      const ctx = this.ctx = new AudioContext();
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const ch = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      // 마스터: 크게 올리고 컴프레서로 눌러 큰 폭발이 겹쳐도 찢어지지 않게 한다
      this.out = ctx.createGain();
      this.out.gain.value = MASTER;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 8;
      comp.ratio.value = 8;
      comp.attack.value = 0.002;
      comp.release.value = 0.25;
      // 음량은 컴프레서 뒤에서 줄여야 큰 폭발까지 같은 비율로 작아진다
      this.post = ctx.createGain();
      this.post.gain.value = LEVEL * TRIM * this.volume;
      this.out.connect(comp).connect(this.post).connect(ctx.destination);
      // 군중 비명 메아리: 짧은 지연을 되먹여 비명이 사라질 때 웅웅 울리며 꺼지게 한다(되먹임 < 1이라 저절로 잦아든다)
      const echo = this.echo = ctx.createDelay(1), fb = ctx.createGain(), lp = ctx.createBiquadFilter(), wet = ctx.createGain();
      echo.delayTime.value = 0.13;
      fb.gain.value = 0.6;
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      wet.gain.value = 0.5;
      echo.connect(lp).connect(fb).connect(echo);
      lp.connect(wet).connect(this.out);
      document.addEventListener('visibilitychange', this.onVisible);
      this.load(ctx);
    }
    if (document.hidden) return;
    const ctx = this.ctx;
    // 사파리는 탭·앱을 다녀오면 'interrupted'(iOS)로 남거나, running이라면서 소리가 안 난다. 다녀온 뒤 첫 탭에서 한 번 껐다 켠다
    if (this.away && ctx.state === 'running') void ctx.suspend().then(() => { if (this.on && this.ctx === ctx) return ctx.resume(); });
    else if (ctx.state !== 'running') void ctx.resume();
    this.away = false;
  }

  // 음원을 모두 받아 디코드한다. 작은 AAC(.m4a)를 먼저 받고, 못 열면 원본 mp3로 다시 받는다
  // (AAC 디코더가 없는 곳: Media Feature Pack 없는 Windows N·KN의 Firefox 등). 둘 다 실패한 소리는 합성음으로 남는다
  private load(ctx: AudioContext) {
    // 한 파일을 받아 디코드한다
    const get = (url: string) => fetch(url)
      .then((r) => {
        // Vite 개발 서버는 없는 파일에 index.html(200)을 준다
        if (!r.ok || r.headers.get('content-type')?.includes('text/html')) throw new Error(`HTTP ${r.status} ${r.headers.get('content-type')}`);
        return r.arrayBuffer();
      })
      .then((b) => ctx.decodeAudioData(b));
    for (const name of FILES) {
      const url = `/sfx/${name}.mp3`;
      get(`/sfx/${name}.m4a`)
        .catch(() => get(url))
        .then((buf) => {
          if (this.ctx !== ctx) return;
          this.bufs.set(name, buf);
          if (name === 'bgm') this.startBgm();
          if (name === 'crowd-panic') this.startPanic();
        })
        .catch((e) => { if (this.ctx === ctx) this.log('AUDIO_LOAD_FAILED', 'Sound.load', e, { url }); });
    }
  }

  // 소리 켜기/끄기. 끄면 컨텍스트를 멈춰 BGM·군중 소리까지 멈추고(음성 합성도 끊고), 켜면 이어서 재생한다
  setOn(on: boolean) {
    this.on = on;
    if (!on) this.stopVoice();
    if (!this.ctx) return;
    if (on && !document.hidden) void this.ctx.resume();
    else void this.ctx.suspend();
  }

  // 음량(0~1). 슬라이더를 끄는 동안 값이 툭툭 바뀌어 지지직거리지 않게 짧게 따라간다
  setVolume(v: number) {
    this.volume = v;
    if (this.ctx && this.post) this.post.gain.setTargetAtTime(LEVEL * TRIM * v, this.ctx.currentTime, 0.02);
  }

  // 탭이 숨으면 멈추고, 돌아오면 (소리가 켜져 있을 때만) 다시 낸다
  private onVisible = () => {
    if (!this.ctx) return;
    if (document.hidden) { this.away = true; void this.ctx.suspend(); }
    else if (this.on) void this.ctx.resume();
  };

  // BGM 루프를 작은 볼륨으로 튼다
  private startBgm() {
    const ctx = this.ctx, buf = this.bufs.get('bgm');
    if (!ctx || !this.post || !buf || this.bgm) return;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    src.loop = true;
    // 브라우저가 음원 앞 인코더 지연(약 25ms)을 남겨 두면 그만큼 건너뛰어 루프 이음매를 맞춘다
    src.loopStart = Math.min(0.025, Math.max(0, buf.duration - BGM_LOOP));
    src.loopEnd = Math.min(buf.duration, src.loopStart + BGM_LOOP);
    // 무기 소리만 줄이려고 BGM은 컴프레서를 건너뛰고 음량 단계(post)에 바로 붙인다
    // 처음 틀 때 2초 동안 서서히 키운다
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(this.music ? BGM_OUT / LEVEL : 0, ctx.currentTime + 2);
    src.connect(g).connect(this.post!);
    src.start(0, src.loopStart);
    this.bgm = src;
    this.bgmG = g;
  }

  // 배경음악만 켜고 끈다. 멈추지 않고 크기만 0.3초 시간상수로 줄여 다시 켜면 이어서 들린다
  setMusic(on: boolean) {
    this.music = on;
    const ctx = this.ctx, p = this.bgmG?.gain;
    if (!ctx || !p) return;
    // 시작 페이드인 도중이면 지금 크기에서 멈춘 뒤 따라가게 한다(cancelAndHoldAtTime이 없는 옛 사파리는 그냥 지운다)
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(ctx.currentTime); else p.cancelScheduledValues(ctx.currentTime);
    p.setTargetAtTime(on ? BGM_OUT / LEVEL : 0, ctx.currentTime, 0.3);
  }

  // 깔리는 군중 소리를 크기 0 루프로 시작한다: 소스 → 로우패스 → 게인 → out. 크기·음색은 crowd()가 랭크에 맞춘다
  private startPanic() {
    const ctx = this.ctx, buf = this.bufs.get('crowd-panic');
    if (!ctx || !this.out || !buf || this.panic) return;
    const src = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf;
    src.loop = true;
    lp.type = 'lowpass';
    g.gain.value = 0;
    src.connect(lp).connect(g).connect(this.out);
    src.start();
    this.panic = { g, lp };
    this.crowd(false);
  }

  // 깔리는 군중 소리를 현재 랭크 목표값으로 천천히 따라가게 한다(오를 때 0.6초, 내릴 때 2초)
  private crowd(rising: boolean) {
    const ctx = this.ctx, p = this.panic;
    if (!ctx || !p) return;
    const [gain, freq] = CROWD[rankTier(RANK_THRESHOLDS[this.rankI][0])], tc = rising ? 0.6 : 2;
    p.g.gain.setTargetAtTime(gain * AMB * CROWD_VOL, ctx.currentTime, tc);
    p.lp.frequency.setTargetAtTime(freq, ctx.currentTime, tc);
  }

  // 군중 비명 한 겹을 낸다: 음원 안 무작위 위치에서 2.5~4초. 중간에서 자르므로 0.08초 페이드인
  private scream(gain: number, max: number) {
    const clips = Object.keys(SCREAMS) as Clip[], clip = clips[Math.floor(Math.random() * clips.length)], buf = this.bufs.get(clip);
    if (!buf) return;
    const len = 2.5 + Math.random() * 1.5, rate = 0.93 + Math.random() * 0.14;
    const off = Math.random() * Math.max(0, buf.duration - len * rate);
    this.play(clip, gain * AMB * CROWD_VOL * SCREAMS[clip]!, rate, off, len, max, 0, 0.08);
  }

  // 음원 한 토막 재생: off초부터 len초(실시간) 동안, at초 뒤에 시작, fadeIn초 동안 서서히 키운다. 음원이 없으면 false
  private play(clip: Clip, gain: number, rate: number, off: number, len: number, max = 3, at = 0, fadeIn = 0) {
    const ctx = this.ctx, buf = this.bufs.get(clip);
    if (!ctx || !this.out || !buf) return false;
    const t = ctx.currentTime + at, src = ctx.createBufferSource(), g = ctx.createGain();
    // 8초 넘는 긴 소리(중성자탄 굉음)는 뒤 35%를 천천히 줄여 끊긴 느낌을 없앤다
    const crowd = clip in SCREAMS;
    // 군중 비명은 길게(최대 1초) 줄여 메아리 속으로 스며들게 한다
    const dur = Math.min(len, (buf.duration - off) / rate), fade = dur > 8 ? dur * 0.35 : crowd ? Math.min(1, dur * 0.4) : Math.min(0.3, dur * 0.3);
    src.buffer = buf;
    src.playbackRate.value = rate;
    // 끝을 짧게 줄여 잘린 꼬리가 툭 끊기지 않게 한다
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + fadeIn);
    } else g.gain.setValueAtTime(gain, t);
    g.gain.setValueAtTime(gain, t + dur - fade);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(g).connect(this.out);
    if (crowd && this.echo) g.connect(this.echo);
    src.start(t, off, dur * rate);
    // 동시 재생 수 제한: 넘치면 가장 오래된 소리를 끊는다
    const live = this.live.get(clip) ?? [];
    this.live.set(clip, live);
    live.push(src);
    src.onended = () => { const k = live.indexOf(src); if (k >= 0) live.splice(k, 1); };
    if (live.length > max) live.shift()!.stop();
    return true;
  }

  // 착탄 소리 (총은 맞는 순간, 단발 무기는 폭발 순간). 같은 소리 반복은 속도·크기를 살짝 흔든다
  hit(w: WeaponId) {
    if (!this.on || !this.ctx) return;
    const c = HIT[w];
    if (w === 'nuke') {
      this.wake();   // 음성 끝(onend)을 못 받은 경우에 대비해 폭발 순간에도 오디오를 되살린다 (iOS)
      this.rumble(6);
      this.play('crowd-scream', AMB * CROWD_VOL, 1, 0, 6, 6, 0.15, 0.08);   // 착탄 직후 큰 군중 비명
    }
    if (w === 'thermo') {
      // THERMO_FIRE초 뒤 점화: 항공폭탄 음원을 낮게 크게 + 아주 낮은 "쿵" + 길게 이어지는 압력(럼블). 충격은 점화 한 번만(진공 "훅"은 뺐다)
      if (!this.play('bomb', 2.2, 0.6, 0, 7, 2, THERMO_FIRE)) this.boom(3, 380, 1.3, THERMO_FIRE);
      this.boom(0.6, 110, 1.4, THERMO_FIRE);
      this.rumble(2.6, THERMO_FIRE);
    }
    if (w === 'bunker') {
      // 땅속 폭발: 아주 낮은 "쿵" + 땅이 울리는 럼블 3초
      this.boom(0.9, 80, 1.5);
      this.rumble(3);
    }
    if (w === 'rod') {
      // 착탄 뒤에야 소리가 난다: 날카로운 "쩍" + 아주 낮은 "쿵" + 항공폭탄 음원을 낮게 + 럼블 4초, 0.25·0.4초에 늦게 도착하는 충격파 "딱-딱"(N파)
      this.boom(0.12, 5000, 1.1);
      this.boom(0.9, 90, 1.5);
      this.play('bomb', 1.5, 0.55, 0, 7, 2);
      this.rumble(4);
      this.boom(0.07, 3500, 0.9, 0.25);
      this.boom(0.07, 3500, 0.9, 0.4);
    }
    if (!this.play(c.clip, c.gain * (0.85 + Math.random() * 0.3), c.rate * (0.96 + Math.random() * 0.08), c.off, c.len, c.max)) this.boom(...BOOM[w]);
  }

  // 발사 소리: 유탄발사기는 낮은 "퐁" 발사음 + 외침, 박격포는 포신 "쿵" 발사음, 포탄은 탱크 포 발사음, 다연장은 일제 사격 녹음 한 번, 중성자탄은 경보 사이렌, 날아오는 무기는 착탄 시각에 맞춰 끝나는 비행음.
  // at = 발사까지 남은 초(다연장 일제 사격의 n번째 로켓). 신의 지팡이는 낙하 직전부터 착탄까지 불협화음이 내려앉는다
  launch(w: WeaponId, at = 0) {
    const ctx = this.ctx;
    if (!this.on || !ctx) return;
    if (w === 'rod') return this.eerie(WEAPON_PARAMS.rod.delay!);
    if (w === 'nuke') {
      this.announce('Nuclear launch detected.');
      return this.siren(WEAPON_PARAMS.nuke.delay! - 0.4);
    }
    if (w === 'grenade') {
      this.boom(0.18, 380, 0.7);
      // 쏠 때마다 앞 외침을 끊고 처음부터 다시 외친다. 연타하면 "fffffire in the hole"처럼 더듬는다
      this.play('fire-in-the-hole', 0.5, 1, 0, VOICE_LEN, 1);
      return;
    }
    // 박격포는 포신에서 "쿵" 하고 나가는 실제 발사음을 먼저 낸다. 착탄음보다 작게, 연타하면 높낮이를 살짝 흔든다
    if (w === 'mortar') this.play('mortar-launch', 0.5, 0.95 + Math.random() * 0.1, 0, 2.5, 3);
    // 포탄은 탱크 포 발사음(여러 녹음을 섞은 묵직한 한 발). 원음 최고점 -0.7dB라 0.55로 박격포 발사음과 같은 -6dB에 맞춘다
    if (w === 'artillery') this.play('tank-fire', 0.55, 0.95 + Math.random() * 0.1, 0, 3, 3);
    // 다연장: 실제 Grad BM-21 일제 사격 녹음을 첫 로켓(at = 0)에서 한 번만 튼다. 녹음 하나에 연속 발사가 다 들어 있다.
    // 크기 0.5 = 최고점을 박격포 발사음과 같은 -6dB에 맞춘 값(큰 소리가 2.4초 이어져 더 크게 들린다). 날아오는 소리는 30%만 내 겹침을 줄인다
    if (w === 'mlrs') {
      if (at === 0) this.play('mlrs-launch', 0.5, 0.97 + Math.random() * 0.06, 0, 6, 2);
      if (Math.random() >= 0.3) return;
    }
    const f = FLY[w], delay = WEAPON_PARAMS[w].delay ?? 0;
    if (!f) return;
    const off = Math.max(0, f.end - delay * f.rate);
    if (!this.play(f.clip, f.gain, f.rate, off, (f.end - off) / f.rate + 0.05, 3, at + Math.max(0, delay - f.end / f.rate), 0.15)) this.whistle(delay);
  }

  // 통계가 바뀔 때 부른다: 랭크가 오르면 상승음, 점수가 오를 때마다 군중 비명(랭크가 높을수록 크고 촘촘하고 겹겹), 깔린 군중 소리는 랭크를 따라간다
  stats(rank: Rank, score: number) {
    const i = RANK_THRESHOLDS.findIndex(([r]) => r === rank);   // 0 = SSS. 상승음은 13단계에서 한 칸 오를 때마다
    const up = i < this.rankI, more = score > this.score;
    this.rankI = i;
    this.score = score;
    const ctx = this.ctx, lv = rankTier(rank);   // 군중·사이렌·상승음 높이는 글자 단계(F=0 … SSS=8)
    if (!this.on || !ctx) return;
    this.crowd(up);
    if (lv >= SIREN_LV) this.farSirens();
    if (up) this.chime(lv);
    if (more && ctx.currentTime - this.screamT >= CROWD[lv][2]) {
      this.screamT = ctx.currentTime;
      for (let k = 0; k < 1 + Math.floor(lv / 4); k++) this.scream(CROWD[lv][3], 6);
    }
  }

  // 영어 경고 음성을 브라우저 음성 합성으로 말한다. 앞 문장은 끊고, 합성이 없는 브라우저는 건너뛴다
  private announce(text: string) {
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      u.pitch = 0.6;
      u.volume = this.volume * SPEECH_VOL * TRIM;
      // cancel()로 끊긴 앞 문장은 오류가 아니다
      u.onerror = (e) => { this.wake(); if (e.error !== 'canceled' && e.error !== 'interrupted') this.log('AUDIO_SPEECH_FAILED', 'Sound.announce', e.error, { text }); };
      u.onend = this.wake;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) {
      this.log('AUDIO_SPEECH_FAILED', 'Sound.announce', e, { text });
    }
  }

  // iOS Safari는 음성 합성이 말하는 동안 다른 소리를 끊거나 줄이고, 끝난 뒤에도 Web Audio가 멈추거나(suspended·interrupted)
  // running인데 작게 눌린 채로 남는다(BGM·비명이 안 들림). 상태와 상관없이 한 번 껐다 켜서 오디오 세션을 되살린다
  private wake = () => {
    const ctx = this.ctx;
    if (!IOS || !this.on || document.hidden || !ctx || ctx.state === 'closed') return;
    void ctx.suspend().then(() => { if (this.on && !document.hidden && this.ctx === ctx) return ctx.resume(); });
  };

  // 말하던 음성 합성을 끊는다
  private stopVoice() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  // 랭크 상승음 "띠링 띵띵": 빠른 상승 아르페지오 뒤에 두 음. 높은 랭크일수록 음이 높고 길다 (level 1=E … 8=SSS)
  private chime(level: number) {
    // 컴프레서를 거치면 키운 만큼 눌려 버리고 폭발음에 묻혀서, 컴프레서 뒤(음량 단계)로 바로 보낸다
    const ctx = this.ctx, out = this.post;
    if (!ctx || !out) return;
    const base = 523.25 * 2 ** (level * 2 / 12);
    const steps = [0, 4, 7, 12, 16, 19, 24].slice(0, 3 + Math.ceil(level / 2));
    let t = ctx.currentTime;
    steps.forEach((s, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), len = k >= steps.length - 2 ? 0.5 : 0.18;
      o.type = 'triangle';
      o.frequency.value = base * 2 ** (s / 12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22 / LEVEL, t + 0.01); // 컴프레서 뒤에 붙으므로 LEVEL을 바꿔도 예전 크기(0.22) 유지
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + len);
      t += k >= steps.length - 3 ? 0.13 : 0.06;
    });
  }

  // 노이즈 버스트 + 로우패스: 길이 len초, 차단 주파수 freq, 크기 gain, at초 뒤 시작 (잔해 착지음, 음원 대체음, 늦게 오는 충격파)
  boom(len: number, freq: number, gain: number, at = 0) {
    const ctx = this.ctx;
    if (!this.on || !ctx || !this.noise || !this.out) return;
    // 같은 순간 겹치는 소리(붕괴 잔해 등)는 줄인다
    if (ctx.currentTime - this.last < 0.03 && gain < 0.5) return;
    this.last = ctx.currentTime;
    const t = ctx.currentTime + at, src = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(freq, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + len);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(lp).connect(g).connect(this.out);
    src.start(t, Math.random(), len);
  }

  // 합성 휘파람(음원 대체): 높은 음에서 낮은 음으로
  whistle(dur: number) {
    const ctx = this.ctx;
    if (!this.on || !ctx || !this.out) return;
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(1900, t);
    o.frequency.exponentialRampToValueAtTime(450, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur);
  }

  // 괴기한 낙하음(합성, 신의 지팡이). dur초 뒤 착탄. 쏘자마자 반음 차이 저음 둘이 웅웅 떨며(맥놀이) 깔리고, 떨림이 2→12Hz로 빨라지며 조여 온다.
  // 착탄 뒤 1.2초 동안 한 옥타브 아래로 끌리며 사라진다. v0.55.1에서 뒤에 끼던 고음 톱니파 화음은 신시사이저 같다고 해서 뺐다
  private eerie(dur: number) {
    const ctx = this.ctx;
    if (!ctx || !this.post) return;
    const t0 = ctx.currentTime, end = t0 + dur, tail = end + 1.2;
    // 저음 드론: 톱니파 110·116.5Hz에 한 옥타브 위 220·233Hz를 겹치고 1200Hz 아래만 남긴다. 저음만으로는 노트북 스피커에서 작게 들렸다(v0.55.3).
    // 크기는 LFO로 0~1 흔든다(트레몰로)
    const dlp = ctx.createBiquadFilter(), trem = ctx.createGain(), dg = ctx.createGain(), tl = ctx.createOscillator(), td = ctx.createGain();
    dlp.frequency.value = 1200;
    trem.gain.value = td.gain.value = 0.5;
    tl.frequency.setValueAtTime(2, t0);
    tl.frequency.exponentialRampToValueAtTime(12, end);
    tl.connect(td).connect(trem.gain);
    // 0.0001에서 바로 지수로 올리면 끝 1/3에서야 들린다. 들리는 크기까지는 직선으로 먼저 올린다
    dg.gain.setValueAtTime(0.0001, t0);
    // 컴프레서(8:1) 앞에서는 키워도 거의 안 커져 뒤(post)에 바로 붙인다. 0.28·0.6은 v0.55.1(out 0.06·0.25)보다 약 +10dB로 잡은 계산값
    dg.gain.linearRampToValueAtTime(0.28, t0 + 0.6);
    dg.gain.exponentialRampToValueAtTime(0.6, end);
    dg.gain.exponentialRampToValueAtTime(0.0001, tail);
    dlp.connect(trem).connect(dg).connect(this.post);
    for (const f of [110, 116.5, 220, 233]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t0);
      o.frequency.exponentialRampToValueAtTime(f / 2, tail);
      o.connect(dlp);
      o.start(t0);
      o.stop(tail);
    }
    tl.start(t0);
    tl.stop(tail);
  }

  // 경보 사이렌(합성): dur초 동안 450↔900Hz를 1.4초 주기로 오르내린다
  private siren(dur: number) {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    const t = ctx.currentTime, o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(450, t);
    for (let k = 0.7; k < dur; k += 1.4) {
      o.frequency.linearRampToValueAtTime(900, t + k);
      o.frequency.linearRampToValueAtTime(450, t + Math.min(dur, k + 0.7));
    }
    lp.frequency.value = 2200;
    g.gain.setValueAtTime(0.0001, t);
    // 음성이 들리게 처음 2.2초는 절반 크기, 이어서 원래 크기로 올린다
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.3);
    g.gain.setValueAtTime(0.06, t + 2.2);
    g.gain.linearRampToValueAtTime(0.12, t + 2.7);
    g.gain.setValueAtTime(0.12, t + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur);
  }

  // 먼 사이렌 잔향(합성): 경찰차(600↔1300Hz를 6초에 한 번 오르내림)와 구급차 "삐뽀"(770·960Hz를 0.5초씩 번갈아)를
  // 낮게 걸러 좌우로 나누고 메아리에 섞는다. 크기를 아주 느리게 흔들어 멀어졌다 가까워지는 느낌을 낸다. 한 번 켜면 판 내내 돈다
  private farSirens() {
    const ctx = this.ctx;
    if (this.sirens || !ctx || !this.out || !this.echo) return;
    this.sirens = true;
    const t = ctx.currentTime;
    // [소리 파형, 중심 Hz, 흔드는 폭 Hz, 흔드는 파형, 한 주기(초), 좌우 위치, 시작 지연(초)]
    const SIRENS = [
      ['sawtooth', 950, 350, 'triangle', 6, -0.6, 0],   // 경찰차
      ['square', 865, 95, 'square', 1, 0.5, 2.5],       // 구급차
    ] as const;
    for (const [type, f, depth, lfoType, period, pan, at] of SIRENS) {
      const o = ctx.createOscillator(), lfo = ctx.createOscillator(), d = ctx.createGain(), lp = ctx.createBiquadFilter();
      const g = ctx.createGain(), p = ctx.createStereoPanner(), sway = ctx.createOscillator(), sg = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      lfo.type = lfoType;
      lfo.frequency.value = 1 / period;
      d.gain.value = depth;
      lfo.connect(d).connect(o.frequency);
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      // 4초에 걸쳐 들어오고, 20초 안팎 주기로 크기가 ±40% 흔들린다
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(SIREN_VOL, t + at + 4);
      sway.frequency.value = 1 / (17 + period * 2);
      sg.gain.value = SIREN_VOL * 0.4;
      sway.connect(sg).connect(g.gain);
      p.pan.value = pan;
      o.connect(lp).connect(g).connect(p).connect(this.out);
      g.connect(this.echo);
      for (const n of [o, lfo, sway]) n.start(t + at);
    }
  }

  // 긴 저음 럼블(합성): 반복 노이즈를 낮게 거르고 len초 동안 천천히 줄인다 + 아래로 미끄러지는 사인 저음. at초 뒤 시작
  private rumble(len: number, at = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.out) return;
    const t = ctx.currentTime + at, src = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise;
    src.loop = true;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(320, t);
    lp.frequency.exponentialRampToValueAtTime(45, t + len);
    g.gain.setValueAtTime(1.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(lp).connect(g).connect(this.out);
    src.start(t);
    src.stop(t + len);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + len);
    og.gain.setValueAtTime(0.9, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + len);
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stopVoice();
    void this.ctx?.close();
    this.ctx = this.out = this.noise = this.bgm = this.bgmG = this.panic = undefined;
    this.sirens = false;
    this.bufs.clear();
    this.live.clear();
  }
}
