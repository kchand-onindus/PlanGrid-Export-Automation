import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { readProjects } from './csv.js';

const headers = 'project_uid,project_name,project_clean_name,enabled,start_date,end_date';

async function fixture(t: TestContext, content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-csv-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'projects.csv');
  await fs.writeFile(file, content);
  return file;
}

test('reads the new schema, quoted names, optional IDs/dates, and disabled rows', async (t) => {
  const file = await fixture(t, `\uFEFF${headers}\nuid-1,"Project, One","My Project, One",true,2026-01-01,2026-02-01\n,Other,Other_clean,false,,\n`);
  assert.deepEqual(await readProjects(file), [
    {
      projectUid: 'uid-1', projectName: 'Project, One', projectCleanName: 'My Project, One',
      enabled: true, startDate: '2026-01-01', endDate: '2026-02-01',
    },
    {
      projectUid: '', projectName: 'Other', projectCleanName: 'Other_clean',
      enabled: false, startDate: undefined, endDate: undefined,
    },
  ]);
});

test('preserves project_name exactly while trimming other configured fields', async (t) => {
  for (const [field, projectName] of [
    [' Project  Name ', ' Project  Name '],
    ['\tProject\t', '\tProject\t'],
    ['" Project, ""One"" "', ' Project, "One" '],
    ['"\u00a0Cafe\u0301\u00a0"', '\u00a0Cafe\u0301\u00a0'],
  ]) {
    const file = await fixture(t, `${headers}\n uid-1 ,${field}, Clean , TRUE , 2026-01-01 , \n`);
    assert.deepEqual(await readProjects(file), [{
      projectUid: 'uid-1', projectName, projectCleanName: 'Clean', enabled: true,
      startDate: '2026-01-01', endDate: undefined,
    }]);
  }
});

test('rejects the old schema rather than deriving an output name', async (t) => {
  const file = await fixture(t, 'project_number,project_name,enabled,start_date,end_date\n1,Project,true,,');
  await assert.rejects(readProjects(file), /must contain project_uid, project_name, project_clean_name and enabled/);
});

test('rejects missing, unsafe, and Windows-reserved clean names before exporting', async (t) => {
  for (const name of ['', '.', '..', '../outside', 'folder/file', 'folder\\file', 'C:drive',
    'star*', 'question?', 'quote"', 'pipe|', '<name>', 'control\u0001', 'trailing.', 'CON', 'nul.txt', 'LPT1']) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const file = await fixture(t, `${headers}\nuid-1,Project,${quoted},true,,`);
    await assert.rejects(readProjects(file), /project_clean_name/, name);
  }
});

test('rejects output collisions for enabled projects, including case and Unicode equivalents', async (t) => {
  for (const [first, second] of [['Same', 'same'], ['Caf\u00e9', 'Cafe\u0301']]) {
    const file = await fixture(t, `${headers}\n1,First,${first},true,,\n2,Second,${second},true,,`);
    await assert.rejects(readProjects(file), /duplicate project_clean_name/);
  }
  const file = await fixture(t, `${headers}\n1,First,Same,true,,\n2,Second,same,false,,`);
  assert.equal((await readProjects(file)).length, 2);
});

test('still validates project names, enabled flags, dates, and duplicate headers', async (t) => {
  for (const [content, error] of [
    [`${headers}\n1,,Clean,true,,`, /project_name is required/],
    [`${headers}\n1,   ,Clean,true,,`, /project_name is required/],
    [`${headers}\n1," \t ",Clean,true,,`, /project_name is required/],
    [`${headers}\n1,Project,Clean,yes,,`, /enabled must be true or false/],
    [`${headers}\n1,Project,Clean,true,01-01-2026,`, /start_date must use YYYY-MM-DD/],
    [`${headers},project_name\n1,Project,Clean,true,,,Other`, /duplicate column names/],
  ] as const) {
    await assert.rejects(readProjects(await fixture(t, content)), error);
  }
});
