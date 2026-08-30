import { render } from 'ink';
import { createTheme, wantsColor } from './theme.js';
import { initial, reduce } from './runState.js';
import { Run } from './screens/Run.jsx';
import { App } from './App.jsx';

/**
 * Подписывает экран на шину и возвращает управление вызывающему: команда
 * работает как работала, а UI живёт сбоку. Ядро про Ink по-прежнему не знает.
 *
 * Ink поднимается лениво — на первом событии. Команда до этого успевает
 * упереться в отсутствие GitLab или в занятый лок, и мигать очисткой экрана
 * ради сообщения об ошибке незачем.
 */
export function mountRun({ bus, t, flags = {}, env = process.env, stdout = process.stdout, now, abort }) {
  const theme = createTheme({ color: wantsColor({ env, flag: !flags.noColor }) });
  let onFrame = () => {};
  let state = initial();
  let instance = null;

  // Подписка отдаёт текущее состояние сразу: события успевают прийти до того,
  // как React смонтирует эффект, и без этого первые фазы шага не рисуются.
  const subscribe = (fn) => {
    onFrame = fn;
    fn(state);
    return () => { onFrame = () => {}; };
  };

  // Сырой режим забирает Ctrl-C у терминала: сигнал больше не приходит сам.
  // Значит прерывание обязано быть нашим — иначе апгрейд нельзя остановить
  // вообще, а это хуже, чем случайное прерывание, которое мы и ловим.
  const onAbort = abort ?? (() => {
    instance?.unmount();
    process.kill(process.pid, 'SIGINT');
  });

  const mount = () => {
    instance = render(
      <App
        subscribe={subscribe}
        initialState={state}
        render={(s) => <Run state={s} t={t} theme={theme} now={now} onAbort={onAbort} />}
      />,
      { stdout, exitOnCtrlC: false, patchConsole: false },
    );
  };

  const off = bus.on((e) => {
    state = reduce(state, e, t);
    // Ждём именно run:start, а не любое событие: до него идут exec-события
    // обнаружения, а экрану показать по ним нечего.
    if (!instance) { if (state.startedAt) mount(); return; }
    onFrame(state);
  });

  return {
    stop: async () => {
      off?.();
      if (!instance) return;
      // Порядок обязателен: waitUntilExit ставит резолвер, а unmount его
      // зовёт. Наоборот — обещание, которое никто не выполнит, и итог
      // шестичасового апгрейда так и не будет напечатан.
      const exited = instance.waitUntilExit();
      instance.unmount();
      await Promise.race([exited, new Promise((r) => { setTimeout(r, 2000).unref?.(); })]);
    },
  };
}

