import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAptLine, aptWatcher, STATUS_FD } from '../src/steps/aptProgress.js';
import { createExec, MODE } from '../src/core/exec.js';
import { predownload } from '../src/steps/install.js';
import { EventBus } from '../src/core/events.js';

/**
 * Форматы сняты с живого apt, а не выдуманы: `apt-get install --download-only
 * -o APT::Status-Fd=1` печатает ровно эти строки. Если apt их изменит, тест
 * упадёт здесь, а не на боевой машине посреди подъёма.
 */
test('строки apt разбираются в события, а прочие — в null', () => {
  assert.deepEqual(parseAptLine('dlstatus:2:27.1686:Retrieving file 2 of 3'),
    { kind: 'download', item: '2', note: 'Retrieving file 2 of 3', percent: 27.1686 });
  assert.deepEqual(parseAptLine('pmstatus:dpkg-exec:0.0000:Running dpkg'),
    { kind: 'install', item: 'dpkg-exec', note: 'Running dpkg', percent: 0 });
  assert.deepEqual(parseAptLine('Get:2 http://a/b/main amd64 gitlab-ee amd64 16.3.9-ee.0 [1093 MB]'),
    { kind: 'get', what: 'amd64 gitlab-ee amd64 16.3.9-ee.0', size: '1093 MB' });
  assert.deepEqual(parseAptLine('Fetched 904 kB in 2s (588 kB/s)'),
    { kind: 'fetched', text: '904 kB in 2s (588 kB/s)' });
  // Обычный шум apt ничего не сообщает о ходе — и показывать его не нужно.
  assert.equal(parseAptLine('Reading package lists...'), null);
  assert.equal(parseAptLine(''), null);
});

test('одинаковые проценты не превращаются в поток перерисовок', () => {
  // apt печатает dlstatus десятками раз в секунду и повторяет одно значение.
  const seen = [];
  const watch = aptWatcher((p) => seen.push(p));
  for (const l of [
    'dlstatus:1:0.0000:Retrieving file 1 of 1',
    'dlstatus:1:0.0000:Retrieving file 1 of 1',
    'dlstatus:1:0.4000:Retrieving file 1 of 1',
    'dlstatus:1:80.0000:Retrieving file 1 of 1',
    'dlstatus:1:100.0000:Retrieving file 1 of 1',
  ]) watch(l);
  assert.deepEqual(seen.map((p) => p.percent), [0, 80, 100]);
});

test('к проценту прикладывается то, что именно качается', () => {
  const seen = [];
  const watch = aptWatcher((p) => seen.push(p));
  watch('Get:1 https://packages.gitlab.com/… gitlab-ee amd64 16.3.9-ee.0 [1093 MB]');
  watch('dlstatus:1:50.0000:Retrieving file 1 of 1');
  assert.match(seen[0].what, /gitlab-ee amd64 16\.3\.9-ee\.0 · 1093 MB/);
});

test('exec отдаёт вывод построчно по ходу дела, а не только в конце', async () => {
  const lines = [];
  const exec = createExec({ mode: MODE.REAL });
  await exec(['sh', '-c', 'echo раз; echo два; echo три'], { onLine: (l) => lines.push(l) });
  assert.deepEqual(lines, ['раз', 'два', 'три']);
});

test('предзагрузка называет номер шага до загрузки, а не после', async () => {
  // Девятнадцать пакетов по гигабайту качаются часами. «Идёт» без указания,
  // что именно и сколько осталось, неотличимо от зависания — ровно это и
  // увидел человек на боевой машине.
  const bus = new EventBus();
  const seen = [];
  bus.on((e) => seen.push(e));
  const exec = async (argv, opts) => {
    assert.ok(argv.includes('APT::Status-Fd=1'), 'без этого apt молчит: ' + argv.join(' '));
    opts.onLine?.('Get:1 https://… gitlab-ee amd64 16.3.9-ee.0 [1093 MB]');
    opts.onLine?.('dlstatus:1:50.0000:Retrieving file 1 of 1');
    return { code: 0, stdout: '', stderr: '' };
  };
  await predownload({ exec, bus, pkg: 'gitlab-ee', versions: ['16.3.9-ee.0', '16.7.10-ee.0'], confPath: null });

  const steps = seen.filter((e) => e.t === 'predownload:step');
  assert.deepEqual(steps.map((e) => [e.index, e.of, e.version]),
    [[1, 2, '16.3.9-ee.0'], [2, 2, '16.7.10-ee.0']]);
  // Шаг объявлен до того, как пошла загрузка.
  assert.ok(seen.indexOf(steps[0]) < seen.findIndex((e) => e.t === 'predownload:progress'));
  const progress = seen.find((e) => e.t === 'predownload:progress');
  assert.equal(progress.percent, 50);
  assert.match(progress.what, /1093 MB/);
  assert.equal(seen.filter((e) => e.t === 'predownload:got').length, 2);
});
