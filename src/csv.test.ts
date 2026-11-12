import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { readProjectInput, readProjects } from './csv.js';

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

test('carries optional excel_name metadata exactly while accepting missing or blank values', async (t) => {
  const content = `${headers},excel_name,action,sheets_count\nuid-1, Project ,Clean,true,,," Excel, ""One"" ",Migrate,10\n,Other,Other,false,,,,,\n`;
  const file = await fixture(t, content);
  const projects = await readProjects(file);
  assert.equal(projects[0].excelName, ' Excel, "One" ');
  assert.equal(projects[0].projectName, ' Project ');
  assert.equal(projects[1].excelName, undefined);
  assert.equal(await fs.readFile(file, 'utf8'), content);

  const reordered = await fixture(t, 'excel_name,enabled,project_name,project_uid,project_clean_name\nExcel reference,true,Project,,Clean\n');
  assert.equal((await readProjects(reordered))[0].excelName, 'Excel reference');
  const absent = await fixture(t, `${headers}\n,Project,Clean,true,,\n`);
  assert.equal((await readProjects(absent))[0].excelName, undefined);
});

test('export input retains the original header order and every decoded source cell for reporting', async (t) => {
  const sourceHeaders = ['excel_name', 'action', 'sheets_count', 'project_name', 'enabled', 'project_clean_name', 'project_uid', 'custom_field'];
  const sourceValues = [' Excel, "One" ', ' Migrate ', '0007', ' Exact Project ', ' TRUE ', ' Clean ', ' uid-1 ', ''];
  const content = [sourceHeaders, sourceValues].map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const file = await fixture(t, content);
  const input = await readProjectInput(file);
  assert.deepEqual(input.headers, sourceHeaders);
  assert.deepEqual(input.projects[0].sourceCsv, { headers: sourceHeaders, values: sourceValues });
  assert.equal(input.projects[0].projectUid, 'uid-1');
  assert.equal(input.projects[0].projectCleanName, 'Clean');
  assert.equal(input.projects[0].projectName, ' Exact Project ');
  assert.equal(input.projects[0].enabled, true);
  assert.equal((await readProjects(file))[0].sourceCsv, undefined);
  assert.equal(await fs.readFile(file, 'utf8'), content);

  const headerOnly = await fixture(t, sourceHeaders.join(','));
  assert.deepEqual(await readProjectInput(headerOnly), { headers: sourceHeaders, projects: [] });
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
