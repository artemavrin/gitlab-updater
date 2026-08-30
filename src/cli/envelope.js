/**
 * Один и тот же конверт у всех команд: агенту не нужно знать,
 * какая команда как отвечает.
 *
 * `id` и `code` стабильны и не переводятся — по ним принимают решения.
 * `message` переведён — его показывают человеку.
 */
export function ok(command, { version, exit = 0, result = null, findings = [] }) {
  return { tool: 'gitlab-upgrade', version, command, ok: exit === 0 || exit >= 10, exit, result, findings, error: null };
}

export function fail(command, { version, exit = 1, code, message, detail = null, findings = [] }) {
  return {
    tool: 'gitlab-upgrade', version, command, ok: false, exit,
    result: null, findings,
    error: { code, message, ...(detail ? { detail } : {}) },
  };
}

export const serialize = (envelope) => JSON.stringify(envelope, null, 2);
