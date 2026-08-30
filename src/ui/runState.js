import { clock, describe, phaseOf, KIND, ROLE } from '../render/events.js';

/**
 * Состояние экрана `run` — чистая функция от потока событий.
 *
 * Живёт отдельно от JSX сознательно: так экран проверяется записанным
 * журналом реального апгрейда, без терминала и без React. И так же
 * рисуется `attach`, которому достаётся ровно тот же поток из JSONL.
 */

export const STEP = { WAIT: 'wait', NOW: 'now', DONE: 'done' };

export const initial = () => ({
  from: null, target: null, profile: null,
  steps: [],
  index: 0, of: 0,
  feed: [], seq: 0,
  live: null,
  phase: null,
  startedAt: null, now: null,
  stopped: null, done: null,
});

/** Хвост ленты: держать в памяти шесть часов истории незачем — она в журнале. */
const FEED_LIMIT = 500;

export function reduce(state, e, t) {
  const s = { ...state };
  const at = Date.parse(e.ts ?? '') || s.now || 0;
  s.now = at;
  const said = describe(e, t);
  const push = (entry) => {
    // Счётчик, а не длина: после обрезки длина повторяется, и <Static>
    // получил бы два элемента с одним ключом.
    s.seq += 1;
    s.feed = [...s.feed, { ...entry, ts: e.ts ?? null, key: s.seq }].slice(-FEED_LIMIT);
  };

  const change = phaseOf(e);
  if (change) s.phase = change.active ? change.phase : null;

  switch (e.t) {
    case 'run:start':
      s.from = e.from; s.target = e.target; s.profile = e.profile;
      s.of = e.steps; s.startedAt = at;
      s.steps = (e.versions ?? []).map((version, i) => ({
        index: i + 1, version, state: STEP.WAIT, phases: [],
      }));
      if (said) push(said);
      return s;

    case 'step:start': {
      s.index = e.index; s.of = e.of;
      s.steps = upsert(s.steps, e.index, {
        ...find(s.steps, e.index),
        index: e.index, version: e.version, state: STEP.NOW, startedAt: at, phases: [],
      });
      if (said) push(said);
      return s;
    }

    case 'step:done': {
      const step = find(s.steps, e.index);
      s.steps = upsert(s.steps, e.index, {
        ...step, state: STEP.DONE,
        elapsedMs: e.durationMs ?? (step?.startedAt ? at - step.startedAt : null),
      });
      s.live = null;
      if (said) push(said);
      return s;
    }

    case 'run:done':
      s.done = { target: e.target, elapsedMin: e.elapsedMin };
      s.live = null;
      if (said) push(said);
      return s;

    case 'run:stopped':
      s.stopped = { reason: e.reason, detail: e.detail, backup: e.backup, version: e.version };
      s.live = null;
      if (said) push(said);
      return s;

    // Прогресс живёт в нижней строке и только по завершении уходит в ленту:
    // иначе шесть часов миграций дадут тысячи одинаковых строк истории.
    case 'services:progress':
      return settleLine(s, said, push, e.running === e.total);
    case 'migrations:progress':
      note(s, { queued: e.queued });
      return settleLine(s, said, push, e.queued === 0);

    default:
      if (!said) return s;
      // Сводка шага для свёрнутой строки экрана пути: размер бэкапа — то,
      // по чему шаги сравнивают между собой.
      if (e.t === 'backup:done') note(s, { backup: e.archive?.size ?? null });
      if (said.kind === KIND.PHASE && said.role === ROLE.INFO) { s.live = said; return s; }
      if (said.kind === KIND.PHASE) s.live = null;
      recordPhase(s, said);
      push(said);
      return s;
  }
}

function settleLine(s, said, push, finished) {
  if (!said) return s;
  if (!finished) { s.live = said; return s; }
  s.live = null;
  recordPhase(s, said);
  push(said);
  return s;
}

/** Детали шага для экрана пути (§6): что именно уже сделано на этом шаге. */
function recordPhase(s, said) {
  if (said.kind !== KIND.PHASE || !s.index) return;
  const step = find(s.steps, s.index);
  if (!step) return;
  const phases = [...(step.phases ?? []).filter((p) => p.name !== said.name), said];
  s.steps = upsert(s.steps, s.index, { ...step, phases });
}

function note(s, patch) {
  const step = find(s.steps, s.index);
  if (step) s.steps = upsert(s.steps, s.index, { ...step, ...patch });
}

const find = (steps, index) => steps.find((x) => x.index === index) ?? null;

function upsert(steps, index, next) {
  const rest = steps.filter((x) => x.index !== index);
  return [...rest, next].sort((a, b) => a.index - b.index);
}

export { clock };
