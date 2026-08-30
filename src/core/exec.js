import { spawn } from 'node:child_process';
import { redactArgv } from './redact.js';

export const MODE = { REAL: 'real', DRY: 'dry', REPLAY: 'replay' };

export class ExecError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'ExecError';
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
        throw new ExecError(`команда завершилась с кодом ${full.code}: ${safe.join(' ')}`, full);
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
        return Promise.reject(new ExecError(`нет фикстуры для команды: ${key}`, { code: 127 }));
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
          reject(new ExecError(`превышен таймаут ${timeout} мс: ${safe.join(' ')}`, { code: 124, stdout, stderr }));
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
