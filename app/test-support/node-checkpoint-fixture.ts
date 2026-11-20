import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

type Binding = { directory: string; write: boolean };

export function legacyCheckpointFixture(db: DatabaseSync, bindings: Map<string, Binding>, _dataDir: string) {
  function repo(agent: string) {
    const binding = bindings.get(agent);
    assert(binding?.write);
    const directory = realpathSync(binding.directory);
    const [path, ...other] = readdirSync(directory).filter(name => name !== '.git');
    assert(path && !other.length, 'The checkpoint fixture requires exactly one workspace file.');
    function git(args: string[], input?: string | Buffer) {
      return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: directory, input, encoding: 'utf8', env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Minarbot',
          GIT_AUTHOR_EMAIL: 'checkpoints@minarbot.local',
          GIT_COMMITTER_NAME: 'Minarbot',
          GIT_COMMITTER_EMAIL: 'checkpoints@minarbot.local',
        },
      }).trim();
    }
    return { directory, path, git };
  }
  return {
    capture(agent: string, turn: string) {
      const { directory, path, git } = repo(agent);
      const ref = `refs/minarbot/checkpoints/${turn}`;
      const blob = git(['hash-object', '--no-filters', '-w', '--stdin'], readFileSync(join(directory, path)));
      const tree = git(['mktree'], `100644 blob ${blob}\t${path}\n`);
      const hash = git(['commit-tree', tree, '-m', `Minarbot checkpoint ${turn}`]);
      git(['update-ref', ref, hash]);
      // Seed the pre-cutover journal row and ref using their original field layout.
      db.prepare("INSERT INTO workspace_checkpoints(turn,agent,directory,ref,hash,state,created) VALUES (?,?,?,?,?,'done',?)")
        .run(turn, agent, directory, ref, hash, Date.now());
    },
    preview(agent: string, turn: string) {
      const { directory, path, git } = repo(agent);
      const ref = `refs/minarbot/checkpoints/${turn}`;
      const saved = git(['rev-parse', ref]);
      const before = git(['rev-parse', `${ref}:${path}`]);
      const current = git(['hash-object', '--no-filters', '--stdin'], readFileSync(join(directory, path)));
      const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: directory, encoding: 'utf8' });
      assert.ifError(head.error);
      assert(head.status === 0 || head.status === 128, head.stderr);
      const files = before === current ? [] : [{ path, action: 'replace' }];
      const digest = createHash('sha256').update(JSON.stringify([
        directory, head.status === 0 ? head.stdout.trim() : null, saved, [{ mode: '100644', hash: before, path }], [{ path, mode: '100644', hash: current }],
      ])).digest('hex');
      return { turn, files, digest };
    },
  };
}
