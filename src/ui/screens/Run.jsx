import { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text, useInput, useStdin } from 'ink';
import { TOPIC } from '../../render/events.js';
import { clip, padCell } from '../../render/format.js';
import { clock } from '../runState.js';
import { Spinner } from '../components/Spinner.jsx';
import { SafetyBar } from '../components/SafetyBar.jsx';
import { FeedLine, labelWidthOf } from '../components/FeedLine.jsx';
import { PathChain } from '../components/PathChain.jsx';

/**
 * Основной экран — лента, а не кадр.
 *
 * Скроллбэк цел: на пятом часу можно отмотать к первому шагу. Живёт только
 * закреплённая строка внизу; всё выше — история, которую Ink печатает один
 * раз через <Static> и больше не трогает. Отсюда же и совпадение с --plain:
 * в редирект уезжает тот же текст, а не мусор из перерисовок.
 */
export function Run({ state, t, theme, compact, onAbort, now = Date.now }) {
  // Профиль объявляет сам запуск (run:start). Спрашивать планировщик второй
  // раз ради формы экрана значило бы гадать до того, как решение принято.
  const patch = compact ?? state.profile === 'patch';
  const [nowMs, setNowMs] = useState(() => now());
  const [showPath, setShowPath] = useState(false);
  const [selected, setSelected] = useState(null);
  const [warned, setWarned] = useState(false);
  const { isRawModeSupported } = useStdin();

  // До run:start показывать нечего: «шаг 0/0» и часы на нуле — мигающий шум
  // ровно в тот момент, когда команда ещё проверяет, есть ли что обновлять.
  const started = Boolean(state.startedAt);
  const running = started && !state.done && !state.stopped;
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNowMs(now()), 1000);
    return () => clearInterval(id);
  }, [running, now]);

  const dangerous = state.phase === 'install';
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      // В опасной фазе первый Ctrl-C не убивает процесс, а объясняет цену.
      if (dangerous && !warned) { setWarned(true); return; }
      onAbort?.();
      return;
    }
    // Любая другая клавиша убирает предупреждение: это подтверждение
    // «понял», а не модальное окно, из которого нет выхода.
    if (warned) { setWarned(false); return; }
    if (input === 'p' && !patch) {
      setShowPath((v) => !v);
      setSelected((v) => v ?? (state.index || 1));
      return;
    }
    if (!showPath) return;
    const at = state.steps.findIndex((s) => s.index === selected);
    if (key.upArrow && at > 0) setSelected(state.steps[at - 1].index);
    if (key.downArrow && at >= 0 && at < state.steps.length - 1) setSelected(state.steps[at + 1].index);
    // Boolean обязателен: у Ink проверка строгая (`isActive === false`), а
    // isRawModeSupported бывает undefined — и тогда он дёргает setRawMode на
    // не-TTY stdin и падает. `run --yes < /dev/null` — обычное дело.
  }, { isActive: Boolean(isRawModeSupported) });

  // Часы идут от стенных часов, а не от последнего события: между событиями
  // проходят десятки минут, и замерший счётчик читается как зависший апгрейд.
  const base = state.startedAt ?? nowMs;
  const elapsed = clock((running ? nowMs : (state.now ?? nowMs)) - base);
  // «Шаг 1 из 1» — церемония вокруг двенадцати минут: в патче маршрута нет.
  const feed = useMemo(
    () => (patch ? state.feed.filter((f) => f.topic !== TOPIC.ROUTE) : state.feed),
    [state.feed, patch],
  );
  // Живая строка входит в расчёт ширины: её подпись бывает длиннее всего,
  // что уже в ленте, и колонка не должна прыгать под ней.
  const labelWidth = useMemo(
    () => Math.max(labelWidthOf(feed), state.live ? [...state.live.name].length : 0),
    [feed, state.live?.name]);

  const status = patch
    ? t('ui.statusPatch', { from: state.from, target: state.target, elapsed })
    : t('ui.status', { index: state.index, of: state.of, elapsed });

  if (!started) return null;

  return (
    <Box flexDirection="column">
      <Static items={feed}>
        {(entry) => <FeedLine key={entry.key} entry={entry} theme={theme} labelWidth={labelWidth} width={theme.width} />}
      </Static>

      {state.live && running ? (
        <Box>
          <Text>{'   '}</Text>
          <Spinner {...theme.accent} />
          <Text>{' ' + padCell(state.live.name, labelWidth + 2)}</Text>
          <Text {...theme.dim}>{clip(state.live.value, theme.width - labelWidth - 7)}</Text>
        </Box>
      ) : null}

      {warned ? <Interrupt t={t} theme={theme} /> : null}

      {showPath ? (
        <PathView state={state} selected={selected} t={t} theme={theme} elapsed={elapsed} />
      ) : null}

      {running ? (
        <SafetyBar
          t={t} theme={theme} phase={state.phase} status={status}
          hint={patch ? null : t(showPath ? 'ui.feedHint' : 'ui.pathHint')}
        />
      ) : null}
    </Box>
  );
}

export function Interrupt({ t, theme }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text {...theme.role('error')}>{' ⛔ ' + t('ui.interruptTitle')}</Text>
      <Text>{'    ' + t('ui.interruptBody')}</Text>
      <Text>{'    ' + t('ui.interruptFix')}</Text>
      <Text {...theme.dim}>{'    ' + t('ui.interruptWait')}</Text>
      <Text {...theme.dim}>{'    ' + t('ui.interruptAgain')}</Text>
    </Box>
  );
}

export function PathView({ state, selected, t, theme, elapsed }) {
  // Последний шаг подписывается «цель», а не «ждёт»: он объясняет, зачем
  // остальные.
  const steps = state.steps.map((s) => ({ ...s, target: s.index === state.of }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text {...theme.accent}>{' ' + t('ui.pathTitle')}</Text>
      <Text {...theme.dim}>
        {' ' + t('ui.pathHeader', { from: state.from, target: state.target, index: state.index, of: state.of, elapsed })}
      </Text>
      <Box marginTop={1} marginBottom={1}>
        <PathChain steps={steps} selected={selected} t={t} theme={theme} />
      </Box>
      <Text {...theme.dim}>{' ' + t('ui.pathKeys')}</Text>
    </Box>
  );
}
