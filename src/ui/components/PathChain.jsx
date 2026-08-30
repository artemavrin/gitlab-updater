import { Box, Text } from 'ink';
import { bytes, pad, padStart, width } from '../../render/format.js';
import { STEP, clock } from '../runState.js';
import { Spinner } from './Spinner.jsx';

const MARK = { [STEP.DONE]: '●', [STEP.NOW]: '◐', [STEP.WAIT]: '○' };
const DASH = '—';

/**
 * Вертикальный рельс: терминал построчный, и поперёк на шаг остаётся девять
 * символов — туда не влезает ни длительность, ни размер бэкапа. Вдоль —
 * целая строка, а подробности выбранного шага уходят вниз, а не вбок.
 *
 * Колонки свёрнутых строк выровнены не ради красоты: только так видно, что
 * первый шаг занял 2:07, а второй 0:41, — то есть где именно ушло время.
 */
export function PathChain({ steps, selected, t, theme }) {
  const rows = steps.map((s) => ({
    step: s,
    cells: [
      s.version,
      t(`ui.stepState.${stateKey(s)}`),
      s.elapsedMs ? clock(s.elapsedMs) : DASH,
      Number.isFinite(s.backup) ? bytes(s.backup, t) : DASH,
      queued(s, t),
    ],
  }));
  const cols = [0, 1, 2, 3].map((i) => width(rows.map((r) => r.cells[i])));
  const labels = width(steps.flatMap((s) => (s.phases ?? []).map((p) => p.name)));

  return (
    <Box flexDirection="column">
      {rows.map(({ step, cells }) => {
        const chosen = step.index === selected;
        return (
          <Box flexDirection="column" key={step.index}>
            <Box>
              <Text {...theme.accent}>{chosen ? ' ▸' : '  '}</Text>
              {step.state === STEP.NOW
                ? <Spinner {...theme.accent} />
                : <Text {...theme.role(step.state === STEP.DONE ? 'ok' : 'info')}>{MARK[step.state]}</Text>}
              <Text>{'  ' + pad(cells[0], cols[0] + 2)}</Text>
              <Text {...theme.dim}>{pad(cells[1], cols[1] + 2)}</Text>
              <Text {...theme.dim}>{padStart(cells[2], cols[2]) + '  '}</Text>
              <Text {...theme.dim}>{padStart(cells[3], cols[3]) + '  '}</Text>
              <Text {...theme.dim}>{cells[4]}</Text>
            </Box>
            {chosen ? (step.phases ?? []).map((p) => (
              <Box key={p.name}>
                <Text {...theme.dim}>{'  │     '}</Text>
                <Text>{pad(p.name, labels + 2)}</Text>
                <Text {...theme.dim}>{p.value}</Text>
              </Box>
            )) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/** Последний шаг маркируется целью: «ждёт» ничего не говорит о том, зачем он. */
const stateKey = (s) => (s.state === STEP.WAIT && s.target ? 'target' : s.state);

function queued(s, t) {
  if (!Number.isFinite(s.queued)) return DASH;
  return s.queued === 0 ? t('event.migrations.clear') : t('event.migrations.left', { queued: s.queued });
}
