// ワークアウト（目標距離・目標時間・インターバル・ペース目標）の進行と音声ガイド
import { fmtDuration, fmtKm, sayDuration, sayKm, sayPace } from './format.js';

export const PRESETS = [
  { id: 'free', name: 'フリーラン', plan: { type: 'free' } },
  { id: 'd5k', name: '5km', plan: { type: 'distance', meters: 5000 } },
  { id: 'd10k', name: '10km', plan: { type: 'distance', meters: 10000 } },
  { id: 't30', name: '30分', plan: { type: 'time', ms: 30 * 60000 } },
  { id: 't60', name: '60分', plan: { type: 'time', ms: 60 * 60000 } },
  { id: 'i400', name: '400m×8', plan: { type: 'interval', warmupMs: 600000, reps: 8, work: { m: 400 }, restMs: 90000, cooldownMs: 300000 } },
  { id: 'i1k', name: '1km×5', plan: { type: 'interval', warmupMs: 600000, reps: 5, work: { m: 1000 }, restMs: 120000, cooldownMs: 300000 } },
  { id: 'i1m', name: '1分×10', plan: { type: 'interval', warmupMs: 300000, reps: 10, work: { ms: 60000 }, restMs: 60000, cooldownMs: 300000 } },
];

export function describePlan(plan) {
  if (!plan || plan.type === 'free') return plan?.pace ? `フリーラン ・ 目標 ${paceText(plan.pace)}` : 'フリーラン';
  const pace = plan.pace ? ` ・ ${paceText(plan.pace)}` : '';
  if (plan.type === 'distance') return `${fmtKm(plan.meters, plan.meters % 1000 ? 1 : 0)}km${pace}`;
  if (plan.type === 'time') return `${Math.round(plan.ms / 60000)}分${pace}`;
  const w = plan.work.m ? `${plan.work.m >= 1000 ? fmtKm(plan.work.m, plan.work.m % 1000 ? 1 : 0) + 'km' : plan.work.m + 'm'}` : `${Math.round(plan.work.ms / 1000) >= 60 ? Math.round(plan.work.ms / 60000) + '分' : Math.round(plan.work.ms / 1000) + '秒'}`;
  return `${w}×${plan.reps}（レスト${fmtDuration(plan.restMs)}）${pace}`;
}

function paceText(sec) { return `${Math.floor(sec / 60)}'${String(Math.round(sec % 60)).padStart(2, '0')}"/km`; }

export function buildSteps(plan) {
  if (!plan || plan.type === 'free') return [];
  if (plan.type === 'distance') return [{ kind: 'goal', m: plan.meters }];
  if (plan.type === 'time') return [{ kind: 'goal', ms: plan.ms }];
  const steps = [];
  if (plan.warmupMs) steps.push({ kind: 'warmup', ms: plan.warmupMs });
  for (let i = 1; i <= plan.reps; i++) {
    steps.push({ kind: 'work', rep: i, ...plan.work });
    if (i < plan.reps && plan.restMs) steps.push({ kind: 'rest', rep: i, ms: plan.restMs });
  }
  if (plan.cooldownMs) steps.push({ kind: 'cooldown', ms: plan.cooldownMs });
  return steps;
}

const KIND_LABEL = { warmup: 'ウォームアップ', work: 'ラン', rest: 'レスト', cooldown: 'クールダウン', goal: '目標' };

export class Workout {
  constructor(plan) {
    this.plan = plan || { type: 'free' };
    this.steps = buildSteps(this.plan);
    this.i = 0;
    this.stepStart = { el: 0, dist: 0 };
    this.done = this.steps.length === 0 ? null : false;
    this.lastPaceAlert = 0;
    this.announced = new Set();
    this.results = [];      // 各ステップの実績 {kind, rep, ms, m}
    this.started = false;
  }

  get step() { return this.steps[this.i]; }

  // 開始時の案内
  intro() {
    if (!this.steps.length) return [];
    const s = this.step;
    if (this.plan.type === 'interval') return [say(`${describeSpoken(this.plan)}。${stepStartText(s, this.plan)}`)];
    return [say(`目標 ${s.m ? sayKm(s.m) : sayDuration(s.ms)}。スタート`)];
  }

  /** el: 経過ms, dist: 距離m, pace: 現在ペース(秒/km) → 音声などのイベント */
  update(el, dist, pace) {
    const out = [];
    const s = this.step;
    if (s && !this.done) {
      const doneM = dist - this.stepStart.dist, doneMs = el - this.stepStart.el;
      const left = s.m ? s.m - doneM : s.ms - doneMs;

      // 途中の案内
      if (s.kind === 'goal' && s.m && s.m >= 2000) {
        const marks = new Map();
        marks.set(s.m / 2, `半分です。残り${sayKm(s.m / 2)}`);
        marks.set(s.m - 1000, '残り1キロ');
        marks.set(s.m - 500, '残り500メートル');
        for (const [at, text] of marks) {
          if (doneM >= at && !this.announced.has('m' + at)) { this.announced.add('m' + at); out.push(say(text)); }
        }
      }
      if (s.kind === 'goal' && s.ms) {
        for (const mark of [s.ms / 2, s.ms - 300000, s.ms - 60000]) {
          if (mark > 0 && doneMs >= mark && !this.announced.has('t' + mark) && s.ms >= 600000) {
            this.announced.add('t' + mark);
            out.push(say(mark === s.ms / 2 ? `半分経過。残り${sayDuration(s.ms - mark)}` : `残り${sayDuration(s.ms - mark)}`));
          }
        }
      }
      if (s.kind !== 'goal' && s.ms && left <= 10000 && left > 0 && !this.announced.has('c' + this.i)) {
        this.announced.add('c' + this.i);
        out.push(say(this.steps[this.i + 1] ? `あと10秒で${KIND_LABEL[this.steps[this.i + 1].kind]}` : 'あと10秒'));
      }
      if (s.kind === 'work' && s.m && left <= 100 && left > 0 && s.m >= 400 && !this.announced.has('r' + this.i)) {
        this.announced.add('r' + this.i);
        out.push(say('ラスト100メートル'));
      }

      if (left <= 0) {
        // 目標距離をまたいだ瞬間を、前回の更新との間で補間して求める
        let endEl = el, endDist = dist;
        const prev = this.prev;
        if (prev && s.m && dist > prev.dist) {
          endDist = this.stepStart.dist + s.m;
          endEl = prev.el + ((endDist - prev.dist) / (dist - prev.dist)) * (el - prev.el);
        } else if (prev && s.ms && el > prev.el) {
          endEl = this.stepStart.el + s.ms;
          endDist = prev.dist + ((endEl - prev.el) / (el - prev.el)) * (dist - prev.dist);
        }
        const ms = endEl - this.stepStart.el, m = endDist - this.stepStart.dist;
        this.results.push({ kind: s.kind, rep: s.rep, ms, m });
        out.push(...this._finishStep(s, ms, m));
        this.i++;
        this.stepStart = { el: endEl, dist: endDist };
        this.lastPaceAlert = el;
        if (!this.step) {
          this.done = true;
          if (this.plan.type === 'interval') out.push(say('ワークアウト完了です。お疲れさまでした'), { type: 'done' });
          else out.push({ type: 'done' });
        } else {
          out.push(say(stepStartText(this.step, this.plan)));
        }
      }
    }

    this.prev = { el, dist };

    // ペース目標のアラート（ラン区間・目標走のみ。30 秒走ってから、60 秒おき）
    const target = this.plan.pace;
    const active = !this.steps.length || this.done || (this.step && (this.step.kind === 'work' || this.step.kind === 'goal'));
    if (target && active && isFinite(pace) && el - this.stepStart.el > 30000 && el - this.lastPaceAlert > 60000) {
      if (pace > target + 15) { out.push(say(`ペースが遅れています。今 ${sayPace(pace)}`)); this.lastPaceAlert = el; }
      else if (pace < target - 15) { out.push(say(`ペースが速すぎます。今 ${sayPace(pace)}`)); this.lastPaceAlert = el; }
    }
    return out;
  }

  _finishStep(s, ms, m) {
    if (s.kind === 'goal') {
      return [say(s.m ? `目標の${sayKm(s.m)}に到達しました。タイム ${sayDuration(ms)}` : `目標の${sayDuration(s.ms)}に到達しました。距離 ${sayKm(m)}`)];
    }
    if (s.kind === 'work') {
      return [say(`${s.rep}本目 終了。${s.m ? 'タイム ' + sayDuration(ms) : '距離 ' + Math.round(m) + 'メートル'}`)];
    }
    return [];
  }

  // 画面表示用の状態
  view(el, dist) {
    const s = this.step;
    if (!this.steps.length) return null;
    if (!s || this.done) return { title: '完了', detail: describePlan(this.plan), progress: 1 };
    const doneM = dist - this.stepStart.dist, doneMs = el - this.stepStart.el;
    const total = s.m || s.ms;
    const left = Math.max(0, s.m ? s.m - doneM : s.ms - doneMs);
    const reps = this.plan.reps;
    let title = KIND_LABEL[s.kind];
    if (s.kind === 'work') title = `${s.rep}/${reps}本目`;
    if (s.kind === 'rest') title = `レスト（${s.rep}/${reps}本 終了）`;
    if (s.kind === 'goal') title = `目標 ${describePlan(this.plan)}`;
    const detail = s.m ? `残り ${left >= 1000 ? fmtKm(left) + ' km' : Math.round(left) + ' m'}` : `残り ${fmtDuration(left)}`;
    return { title, detail, progress: Math.min(1, (total - left) / total), kind: s.kind };
  }

  toJSON() { return { ...this, announced: [...this.announced] }; }
  static restore(o) { const w = new Workout(o.plan); Object.assign(w, o, { announced: new Set(o.announced || []) }); return w; }
}

function say(text) { return { type: 'say', text }; }

function describeSpoken(plan) {
  const w = plan.work.m ? `${plan.work.m >= 1000 ? sayKm(plan.work.m) : plan.work.m + 'メートル'}` : sayDuration(plan.work.ms);
  return `${w}を${plan.reps}本`;
}

function stepStartText(s, plan) {
  if (s.kind === 'warmup') return `ウォームアップ ${sayDuration(s.ms)}`;
  if (s.kind === 'cooldown') return `クールダウン ${sayDuration(s.ms)}`;
  if (s.kind === 'rest') return `レスト ${sayDuration(s.ms)}`;
  if (s.kind === 'work') {
    const len = s.m ? (s.m >= 1000 ? sayKm(s.m) : s.m + 'メートル') : sayDuration(s.ms);
    return `${s.rep}本目 スタート。${len}${plan.pace ? '。目標ペース ' + sayPace(plan.pace) : ''}`;
  }
  return 'スタート';
}
