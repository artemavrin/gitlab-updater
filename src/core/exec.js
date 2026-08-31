import { spawn } from 'node:child_process';
import { redactArgv } from './redact.js';

export const MODE = { REAL: 'real', DRY: 'dry', REPLAY: 'replay' };

/**
 * Ошибка запуска — кодом, а не фразой. Текст берётся из локали по
 * `error.exec.<code>`: он уезжает и на экран остановки, и в уведомление на
 * телефон, где язык уже выбран пользователем. `message` остаётся машинным —
 * его читают в журнале.
 */
export class ExecError extends Error {
  constructor(code, result = {}) {
    const detail = Object.entries(result)
      .filter(([k]) => ['argv', 'code', 'key', 'timeout'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join(' ');
    super(detail ? `${code} ${detail}` : code);
    this.name = 'ExecError';
    this.code = code;
    this.params = result;
    this.result = result;
  }
}

/** Ключ фикстуры — сама команда. Стабилен и читаем в diff. */
export const fixtureKey = (argv) => argv.join(' ');

/**
 * Единственная точка запуска внешних команд.
 *
 * Команда — всегда массив argv: никакой конкатенации в shell, поэтому
 * пароль прокси или путь с пробелами не могут превратиться в инъекцию.
 *
 * Читающие команды помечаются `readOnly: true` и выполняются даже в dry-режиме —
 * иначе dry-run врал бы. Изменяющие в dry не запускаются вовсе.
 */
export function createExec({ mode = MODE.REAL, fixtures = null, bus = null, secrets = [] } = {}) {
  return function exec(argv, opts = {}) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new TypeError('exec requires a non-empty argv array');
    }
    const { readOnly = false, timeout = 60_000, env, cwd, input, allowFailure = false } = opts;
    const safe = redactArgv(argv, secrets);
    const started = Date.now();

    bus?.emit({ t: 'exec:start', argv: safe, readOnly });

    const done = (result) => {
      const full = { ...result, argv: safe, durationMs: Date.now() - started };
      bus?.emit({ t: 'exec:end', argv: safe, code: full.code, durationMs: full.durationMs });
      if (!allowFailure && full.code !== 0) {
        throw new ExecError('exec-failed', { ...full, argv: safe.join(' ') });
      }
      return full;
    };

    if (mode === MODE.DRY && !readOnly) {
      return Promise.resolve(done({ code: 0, stdout: '', stderr: '', skipped: true }));
    }

    if (mode === MODE.REPLAY) {
      const key = fixtureKey(argv);
      const hit = fixtures?.[key];
      if (hit === undefined) {
        return Promise.reject(new ExecError('exec-no-fixture', { code: 127, key }));
      }
      const shaped = typeof hit === 'string' ? { code: 0, stdout: hit, stderr: '' } : hit;
      return Promise.resolve(done({ stdout: '', stderr: '', code: 0, ...shaped }));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        env: env ? { ...process.env, ...env } : process.env,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new ExecError('exec-timeout', { code: 124, stdout, stderr, timeout, argv: safe.join(' ') }));
          return;
        }
        try {
          resolve(done({ code: code ?? 0, stdout, stderr }));
        } catch (err) {
          reject(err);
        }
      });

      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  };
}

/**
 * Строка из stderr, по которой можно понять, что случилось.
 *
 * Раньше брали последнюю строку — и на ошибке Ruby оставалось
 * «Did you mean? queue_order», без той строки, где назван сломанный метод.
 * Сообщение уезжает в тикет вместо диагноза, и разбор начинается с нуля.
 *
 * Ruby печатает саму ошибку первой, поэтому ищем её, а не край вывода.
 */
export function errorDetail(stderr, limit = 200) {
  const lines = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const named = lines.find((l) => /undefined method|NoMethodError|Error|no such|not found|cannot|denied/i.test(l));
  const line = named ?? lines[lines.length - 1];
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
