/**
 * Выбор рендерера отделён от самих экранов: решение «нужен ли Ink» должно
 * приниматься до того, как в процесс подтянутся React и Ink.
 *
 * Fullscreen-TUI в редиректе — классическая беда Ink-приложений: `> log.txt`
 * даёт мусор из перерисовок вместо лога. Здесь этого нет по построению.
 */
export function inkAvailable({ stdout = process.stdout, flags = {}, env = process.env } = {}) {
  if (flags.plain || flags.json || flags.events) return false;
  if (env.GITLAB_UPGRADE_PLAIN) return false;
  return Boolean(stdout.isTTY);
}
