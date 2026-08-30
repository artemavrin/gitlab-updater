import { Box, Text } from 'ink';
import { isDangerous } from '../../render/events.js';

/**
 * Закреплённая строка внизу — главный довод за TUI в этом инструменте:
 * в три часа ночи Ctrl-C жмут по привычке, и статический вывод не остановит.
 */
export function SafetyBar({ t, theme, phase, status, hint }) {
  const danger = isDangerous(phase);
  return (
    <Box flexDirection="column">
      <Text {...theme.dim}>{'─'.repeat(theme.width)}</Text>
      <Box>
        <Text> {status} · </Text>
        <Text {...theme.role(danger ? 'warn' : 'ok')}>{t(danger ? 'ui.unsafe' : 'ui.safe')}</Text>
        {hint ? <Text {...theme.dim}>{'  ' + hint}</Text> : null}
      </Box>
    </Box>
  );
}
