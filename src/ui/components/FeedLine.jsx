import { Box, Text } from 'ink';
import { MARK, KIND } from '../../render/events.js';
import { clip, padCell, width } from '../../render/format.js';

const time = (ts) => (ts ? String(ts).slice(11, 19) : '        ');

/**
 * Строка ленты. Заголовки шага идут со временем слева, фазы — с отступом и
 * маркером: так шаг визуально держит свои фазы, а отмотка на пятый час
 * находит границы шагов по столбику времени.
 */
export function FeedLine({ entry, theme, labelWidth = 0, width: max = 78 }) {
  if (entry.kind === KIND.PHASE) {
    return (
      <Box>
        <Text {...theme.role(entry.role)}>{`   ${MARK[entry.role]} `}</Text>
        <Text>{padCell(entry.name, labelWidth + 2)}</Text>
        <Text {...theme.dim}>{clip(entry.value, max - labelWidth - 7)}</Text>
      </Box>
    );
  }
  if (entry.kind === KIND.DETAIL) {
    return <Text {...theme.dim}>{`     ${entry.text}`}</Text>;
  }
  return (
    <Box>
      <Text {...theme.dim}>{` ${time(entry.ts)}  `}</Text>
      <Text {...theme.role(entry.role)}>{clip(entry.text, max - 11)}</Text>
    </Box>
  );
}

/** Колонки считаются от фактических подписей локали, а не от константы. */
export const labelWidthOf = (entries) =>
  width(entries.filter((e) => e.kind === KIND.PHASE).map((e) => e.name));
