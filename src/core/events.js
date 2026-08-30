/**
 * Единственный канал «ядро → вывод». Оркестратор ничего не печатает —
 * он испускает события, а рендереры (Ink, plain, JSON) на них подписаны.
 * Отсюда: чистый лог при редиректе, отсоединяемый attach и почти бесплатный i18n.
 */
export class EventBus {
  #subscribers = new Set();

  on(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  emit(event) {
    if (!event || typeof event.t !== 'string') {
      throw new TypeError('event requires a string field `t`');
    }
    const full = { ts: new Date().toISOString(), ...event };
    for (const fn of this.#subscribers) fn(full);
    return full;
  }
}

/** Уровни находок. Все проверки, шаги и планировщик возвращают этот формат. */
export const LEVEL = { OK: 'ok', WARN: 'warn', CRITICAL: 'critical' };

export function finding(id, level, detail = {}) {
  return { id, level, ...detail };
}
