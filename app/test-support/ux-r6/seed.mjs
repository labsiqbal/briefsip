import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [origin, data] = process.argv.slice(2);
assert(origin && new URL(origin).hostname === '127.0.0.1' && data, 'Disposable loopback fixture and data directory required');
const post = async (path, body) => {
  const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(response.ok, await response.clone().text()); return response.json();
};
const agents = [], existing = await fetch(origin + '/api/agents').then(response => response.json());
for (const name of ['Iris', 'Theo', 'Mara', 'Coder']) {
  agents.push(existing.agents.find(agent => agent.name === name) ?? await post('/api/agents', { runtime: 'api', id: name === 'Coder' ? (await readFile(data + '/coder-id', 'utf8')).trim() : randomUUID(), name, model: 'audit-model', instructions: 'Synthetic fixture.' }));
}
for (let i = 0; i < 8; i++) {
  const path = `/api/agents/${agents[0].id}/turns`, turn = await post(path, { id: randomUUID(), text: 'markdown checklist ' + i });
  let done = false;
  for (let n = 0; n < 100; n++) {
    const rows = await fetch(origin + path).then(response => response.json());
    if (rows.some(row => row.id === turn.id && row.status === 'done')) { done = true; break; }
    await delay(100);
  }
  assert(done, 'Synthetic Markdown turn did not finish');
}
console.log('Seeded Iris, Theo, Mara, Coder and eight Markdown turns.');
