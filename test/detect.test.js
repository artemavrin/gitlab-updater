import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOsRelease } from '../src/detect/os.js';
import { parseCtlStatus, missingKeyServices, parsePgVersion } from '../src/detect/services.js';
import { parseDf, toGb } from '../src/detect/disk.js';
import { detectGitlab } from '../src/detect/gitlab.js';
import { createExec, MODE } from '../src/core/exec.js';
import { osReleaseJammy, ctlStatusHealthy, ctlStatusDegraded, dfOutput, fixturesFor } from './fixtures/index.js';

test('разбирает /etc/os-release', () => {
  const os = parseOsRelease(osReleaseJammy);
  assert.deepEqual([os.id, os.versionId, os.supported], ['ubuntu', '22.04', true]);
});

test('неизвестная ОС не притворяется поддерживаемой', () => {
  const os = parseOsRelease('ID=alpine\nVERSION_ID="3.19"\n');
  assert.equal(os.supported, false);
});

test('считает поднятые сервисы', () => {
  const s = parseCtlStatus(ctlStatusHealthy);
  assert.equal(s.total, 9);
  assert.equal(s.running, 9);
  assert.deepEqual(missingKeyServices(s), []);
});

test('упавший ключевой сервис виден по имени', () => {
  const s = parseCtlStatus(ctlStatusDegraded);
  assert.equal(s.running, 8);
  assert.deepEqual(missingKeyServices(s), ['sidekiq']);
});

test('разбирает df и переводит в гигабайты', () => {
  const rows = parseDf(dfOutput);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].target, '/var/opt/gitlab');
  assert.equal(toGb(rows[0].avail), 142.1);
});

test('версия PostgreSQL берётся целиком: 14.2 и 14.14 — разные требования', () => {
  assert.equal(parsePgVersion('psql (PostgreSQL) 14.2'), '14.2');
  assert.equal(parsePgVersion('psql (PostgreSQL) 13.11'), '13.11');
});

test('версия GitLab и редакция берутся из dpkg', async () => {
  const exec = createExec({ mode: MODE.REPLAY, fixtures: fixturesFor({ version: '17.11.4-ee.0' }) });
  const info = await detectGitlab(exec);
  assert.equal(info.edition, 'ee');
  assert.equal(info.version.minor, 11);
  assert.equal(info.source, 'dpkg');
});
