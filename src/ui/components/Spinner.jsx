import { useEffect, useState } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Свой, без пакета: одна анимация не стоит зависимости, которую придётся
 * тащить на закрытый контур. Один спиннер на экран — тот, что реально
 * работает сейчас; остальное статично, иначе за шесть часов экран утомляет.
 */
export function Spinner({ interval = 120, ...rest }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), interval);
    return () => clearInterval(id);
  }, [interval]);
  return <Text {...rest}>{FRAMES[frame % FRAMES.length]}</Text>;
}
