import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert, mockHost, mountWorker, test } from 'orca/testing';
import { DataSource } from './dataSource.ts';
import * as main from './worker.ts';

test('answers getInitialState with repository and default configuration', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
    results: {
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-1',
            kind: 'worktree',
            name: 'orca-git-graph',
            path: process.cwd(),
            branch: 'main',
            hostId: null
          }
        ],
        truncated: false
      },
      'workspace.readContext': {
        branch: 'main',
        displayName: 'orca-git-graph',
        terminals: []
      }
    }
  });

  const worker = await mountWorker(main, { host });
  const state: any = await worker.request('getInitialState');

  assert.ok(state.initialState);
  assert.ok(state.initialState.config);
  assert.equal(state.initialState.lastActiveRepo, process.cwd());
  assert.ok(state.initialState.repos[process.cwd()]);
  assert.equal(worker.refusals.length, 0);

  await worker.deactivate();
});

test('handles loadRepoInfo, loadCommits, and commitDetails', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
    results: {
      'workspace.list': {
        workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'orca-git-graph', path: process.cwd(), branch: 'main', hostId: null }],
        truncated: false
      },
      'workspace.readContext': { branch: 'main', displayName: 'orca-git-graph', terminals: [] }
    }
  });

  const worker = await mountWorker(main, { host });

  // 1. loadRepoInfo
  const repoInfo: any = await worker.request('msg', {
    command: 'loadRepoInfo',
    repo: process.cwd(),
    refreshId: 1,
    showRemoteBranches: true,
    showStashes: true,
    hideRemotes: []
  });

  assert.equal(repoInfo.command, 'loadRepoInfo');
  assert.equal(repoInfo.refreshId, 1);
  assert.ok(repoInfo.isRepo);
  assert.ok(Array.isArray(repoInfo.branches));
  assert.ok(repoInfo.branches.includes('main'));

  // 2. loadCommits
  const commitsReply: any = await worker.request('msg', {
    command: 'loadCommits',
    repo: process.cwd(),
    refreshId: 2,
    branches: null,
    maxCommits: 50,
    showTags: true,
    showRemoteBranches: true,
    includeCommitsMentionedByReflogs: false,
    onlyFollowFirstParent: false,
    commitOrdering: 'date',
    remotes: [],
    hideRemotes: [],
    stashes: []
  });

  assert.equal(commitsReply.command, 'loadCommits');
  assert.equal(commitsReply.refreshId, 2);
  assert.ok(Array.isArray(commitsReply.commits));
  assert.ok(commitsReply.commits.length > 0);

  const realCommit = commitsReply.commits.find((c: any) => c.hash !== '*');
  assert.ok(realCommit);
  assert.ok(realCommit.author);
  assert.ok(realCommit.message);

  // 3. commitDetails
  const detailsReply: any = await worker.request('msg', {
    command: 'commitDetails',
    repo: process.cwd(),
    commitHash: realCommit.hash,
    hasParents: false,
    stash: null,
    avatarEmail: null,
    refresh: false
  });

  assert.equal(detailsReply.command, 'commitDetails');
  assert.ok(detailsReply.commitDetails);
  assert.equal(detailsReply.commitDetails.hash, realCommit.hash);
  assert.ok(Array.isArray(detailsReply.commitDetails.fileChanges));
  assert.ok(detailsReply.commitDetails.fileChanges.length > 0);

  // 4. write operation input validation
  const createBranchReply: any = await worker.request('msg', {
    command: 'createBranch',
    repo: process.cwd(),
    branchName: '-invalid-name',
    commitHash: realCommit.hash
  });
  assert.equal(createBranchReply.command, 'createBranch');
  assert.ok(Array.isArray(createBranchReply.errors));
  assert.ok(createBranchReply.errors[0]?.includes('cannot start with "-"'));

  const mergeReply: any = await worker.request('msg', {
    command: 'merge',
    repo: process.cwd(),
    actionOn: 'branch',
    obj: 'nonexistent-branch'
  });
  assert.equal(mergeReply.command, 'merge');
  assert.ok(typeof mergeReply.error === 'string');

  assert.equal(worker.refusals.length, 0);
  await worker.deactivate();
});

test('posts updated repos on workspace.changed', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
    results: {
      'workspace.list': {
        workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'orca-git-graph', path: process.cwd(), branch: 'main', hostId: null }],
        truncated: false
      },
      'workspace.readContext': { branch: 'main', displayName: 'orca-git-graph', terminals: [] }
    }
  });

  const worker = await mountWorker(main, { host });
  await worker.emit('workspace.changed', {
    context: { branch: 'main', displayName: 'orca-git-graph', terminals: [] }
  });

  const loadReposPost = worker.posts.find((p: any) => p.event === 'msg' && p.payload.command === 'loadRepos');
  assert.ok(loadReposPost);
  assert.equal(loadReposPost.payload.lastActiveRepo, process.cwd());

  assert.equal(worker.refusals.length, 0);
  await worker.deactivate();
});

test('returns error when focused workspaces are not git repositories', async () => {
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-dir-'));
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [
            {
              id: 'ws-nongit',
              kind: 'worktree',
              name: 'non-git-project',
              path: nonGitDir,
              branch: 'main',
              hostId: null
            }
          ],
          truncated: false
        },
        'workspace.readContext': {
          branch: 'main',
          displayName: 'non-git-project',
          terminals: []
        }
      }
    });

    const worker = await mountWorker(main, { host });
    const state: any = await worker.request('getInitialState');
    assert.equal(state.error, '当前 workspace 不是 Git 仓库');
    assert.equal(state.initialState, null);

    const loadReposReply: any = await worker.request('msg', { command: 'loadRepos' });
    assert.equal(loadReposReply.lastActiveRepo, null);
    assert.deepEqual(loadReposReply.repos, {});

    await worker.deactivate();
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test('matches workspace by displayName and branch when multiple workspaces share the same name', async () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-b-'));
  cp.execSync('git init', { cwd: repoA });
  cp.execSync('git init', { cwd: repoB });
  const toplevelA = path.normalize(cp.execSync('git rev-parse --show-toplevel', { cwd: repoA }).toString().trim()).replace(/\\/g, '/');
  const toplevelB = path.normalize(cp.execSync('git rev-parse --show-toplevel', { cwd: repoB }).toString().trim()).replace(/\\/g, '/');

  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [
            {
              id: 'ws-1',
              kind: 'worktree',
              name: 'shared-name-app',
              path: repoA,
              branch: 'feature-alpha',
              hostId: null
            },
            {
              id: 'ws-2',
              kind: 'worktree',
              name: 'shared-name-app',
              path: repoB,
              branch: 'feature-beta',
              hostId: null
            }
          ],
          truncated: false
        },
        'workspace.readContext': {
          branch: 'feature-beta',
          displayName: 'shared-name-app',
          terminals: []
        }
      }
    });

    const worker = await mountWorker(main, { host });
    const state: any = await worker.request('getInitialState');

    assert.equal(state.error, null);
    assert.ok(state.initialState);
    assert.equal(state.initialState.lastActiveRepo, toplevelB);
    assert.ok(state.initialState.repos[toplevelA]);
    assert.ok(state.initialState.repos[toplevelB]);

    const loadReposReply: any = await worker.request('msg', { command: 'loadRepos' });
    assert.equal(loadReposReply.lastActiveRepo, toplevelB);
    assert.ok(loadReposReply.repos[toplevelA]);
    assert.ok(loadReposReply.repos[toplevelB]);

    await worker.deactivate();
  } finally {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});

test('skips non-git workspace and matches first valid git worktree', async () => {
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [
            {
              id: 'ws-1',
              kind: 'worktree',
              name: 'notes',
              path: nonGitDir,
              branch: 'main',
              hostId: null
            },
            {
              id: 'ws-2',
              kind: 'worktree',
              name: 'orca-git-graph',
              path: process.cwd(),
              branch: 'main',
              hostId: null
            }
          ],
          truncated: false
        },
        'workspace.readContext': {
          branch: 'main',
          displayName: 'notes',
          terminals: []
        }
      }
    });

    const worker = await mountWorker(main, { host });
    const state: any = await worker.request('getInitialState');
    assert.equal(state.error, null);
    assert.equal(state.initialState.lastActiveRepo, process.cwd());
    assert.ok(state.initialState.repos[process.cwd()]);
    assert.equal(state.initialState.repos[nonGitDir], undefined);

    await worker.deactivate();
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

function initTestRepo(): { repoPath: string; cleanup: () => void } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-test-'));
  cp.execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  cp.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'initial content\n');
  cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
  cp.execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
  return {
    repoPath,
    cleanup: () => {
      try {
        fs.rmSync(repoPath, { recursive: true, force: true });
      } catch {}
    }
  };
}

test('handles branch operations in temp repo (checkoutBranch, createBranch, deleteBranch, renameBranch, checkoutCommit)', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });
    const headHash = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();

    // 1. createBranch
    const createRes: any = await worker.request('msg', {
      command: 'createBranch',
      repo: repoPath,
      branchName: 'feature-1',
      commitHash: headHash,
      checkout: false,
      force: false
    });
    assert.equal(createRes.command, 'createBranch');
    assert.deepEqual(createRes.errors, [null]);

    let branches = cp.execFileSync('git', ['branch'], { cwd: repoPath }).toString();
    assert.ok(branches.includes('feature-1'));

    // 2. checkoutBranch
    const checkoutRes: any = await worker.request('msg', {
      command: 'checkoutBranch',
      repo: repoPath,
      branchName: 'feature-1',
      remoteBranch: null
    });
    assert.equal(checkoutRes.command, 'checkoutBranch');
    assert.deepEqual(checkoutRes.errors, [null]);

    let currentBranch = cp.execFileSync('git', ['branch', '--show-current'], { cwd: repoPath }).toString().trim();
    assert.equal(currentBranch, 'feature-1');

    // 3. renameBranch
    const renameRes: any = await worker.request('msg', {
      command: 'renameBranch',
      repo: repoPath,
      oldName: 'feature-1',
      newName: 'feature-renamed'
    });
    assert.equal(renameRes.command, 'renameBranch');
    assert.equal(renameRes.error, null);

    currentBranch = cp.execFileSync('git', ['branch', '--show-current'], { cwd: repoPath }).toString().trim();
    assert.equal(currentBranch, 'feature-renamed');

    // 4. checkoutCommit (detached HEAD)
    const checkoutCommitRes: any = await worker.request('msg', {
      command: 'checkoutCommit',
      repo: repoPath,
      commitHash: headHash
    });
    assert.equal(checkoutCommitRes.command, 'checkoutCommit');
    assert.equal(checkoutCommitRes.error, null);

    // Switch back to main to delete feature-renamed
    await worker.request('msg', {
      command: 'checkoutBranch',
      repo: repoPath,
      branchName: 'main',
      remoteBranch: null
    });

    // 5. deleteBranch
    const deleteRes: any = await worker.request('msg', {
      command: 'deleteBranch',
      repo: repoPath,
      branchName: 'feature-renamed',
      forceDelete: true,
      deleteOnRemotes: []
    });
    assert.equal(deleteRes.command, 'deleteBranch');
    assert.deepEqual(deleteRes.errors, [null]);

    branches = cp.execFileSync('git', ['branch'], { cwd: repoPath }).toString();
    assert.ok(!branches.includes('feature-renamed'));

    // 6. Security: reject branch names starting with -
    const badBranchRes: any = await worker.request('msg', {
      command: 'createBranch',
      repo: repoPath,
      branchName: '-bad-option',
      commitHash: headHash
    });
    assert.equal(badBranchRes.command, 'createBranch');
    assert.ok(badBranchRes.errors[0]?.includes('cannot start with "-"'));

    await worker.deactivate();
  } finally {
    cleanup();
  }
});

test('handles tag operations in temp repo (addTag, deleteTag, pushTag)', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });
    const headHash = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();

    // 1. Lightweight tag (type = 1)
    const addLightRes: any = await worker.request('msg', {
      command: 'addTag',
      repo: repoPath,
      tagName: 'v0.1.0',
      commitHash: headHash,
      type: 1,
      message: '',
      force: false,
      pushToRemote: null
    });
    assert.equal(addLightRes.command, 'addTag');
    assert.deepEqual(addLightRes.errors, [null]);

    let tags = cp.execFileSync('git', ['tag'], { cwd: repoPath }).toString();
    assert.ok(tags.includes('v0.1.0'));

    // 2. Annotated tag (type = 2)
    const addAnnotatedRes: any = await worker.request('msg', {
      command: 'addTag',
      repo: repoPath,
      tagName: 'v1.0.0',
      commitHash: headHash,
      type: 2,
      message: 'First release',
      force: false,
      pushToRemote: null
    });
    assert.equal(addAnnotatedRes.command, 'addTag');
    assert.deepEqual(addAnnotatedRes.errors, [null]);

    tags = cp.execFileSync('git', ['tag'], { cwd: repoPath }).toString();
    assert.ok(tags.includes('v1.0.0'));

    // 3. deleteTag
    const deleteTagRes: any = await worker.request('msg', {
      command: 'deleteTag',
      repo: repoPath,
      tagName: 'v0.1.0',
      deleteOnRemote: null
    });
    assert.equal(deleteTagRes.command, 'deleteTag');
    assert.equal(deleteTagRes.error, null);

    tags = cp.execFileSync('git', ['tag'], { cwd: repoPath }).toString();
    assert.ok(!tags.includes('v0.1.0'));
    assert.ok(tags.includes('v1.0.0'));

    // 4. Security: reject tag name starting with -
    const badTagRes: any = await worker.request('msg', {
      command: 'addTag',
      repo: repoPath,
      tagName: '-bad-tag',
      commitHash: headHash,
      type: 1
    });
    assert.equal(badTagRes.command, 'addTag');
    assert.ok(badTagRes.errors[0]?.includes('cannot start with "-"'));

    await worker.deactivate();
  } finally {
    cleanup();
  }
});

test('handles commit operations in temp repo (cherrypickCommit, revertCommit, resetToCommit, dropCommit)', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });

    // Create commit on feat branch
    cp.execFileSync('git', ['checkout', '-b', 'feat'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'feat.txt'), 'feature code\n');
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    cp.execFileSync('git', ['commit', '-m', 'Add feat.txt'], { cwd: repoPath });
    const featHash = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();

    // Switch back to main
    cp.execFileSync('git', ['checkout', 'main'], { cwd: repoPath });

    // 1. cherrypickCommit
    const cherryRes: any = await worker.request('msg', {
      command: 'cherrypickCommit',
      repo: repoPath,
      commitHash: featHash,
      parentIndex: 0,
      recordOrigin: false,
      noCommit: false
    });
    assert.equal(cherryRes.command, 'cherrypickCommit');
    assert.deepEqual(cherryRes.errors, [null]);
    assert.ok(fs.existsSync(path.join(repoPath, 'feat.txt')));

    // 2. revertCommit
    const cherryHash = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();
    const revertRes: any = await worker.request('msg', {
      command: 'revertCommit',
      repo: repoPath,
      commitHash: cherryHash,
      parentIndex: 0
    });
    assert.equal(revertRes.command, 'revertCommit');
    assert.equal(revertRes.error, null);
    assert.ok(!fs.existsSync(path.join(repoPath, 'feat.txt')));

    // 3. resetToCommit (hard)
    const initialHash = cp.execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: repoPath }).toString().trim();
    const resetRes: any = await worker.request('msg', {
      command: 'resetToCommit',
      repo: repoPath,
      commit: initialHash,
      resetMode: 'hard'
    });
    assert.equal(resetRes.command, 'resetToCommit');
    assert.equal(resetRes.error, null);
    assert.equal(cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim(), initialHash);

    // 4. dropCommit
    fs.writeFileSync(path.join(repoPath, 'c1.txt'), 'c1\n');
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    cp.execFileSync('git', ['commit', '-m', 'c1 commit'], { cwd: repoPath });
    const c1Hash = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();

    fs.writeFileSync(path.join(repoPath, 'c2.txt'), 'c2\n');
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    cp.execFileSync('git', ['commit', '-m', 'c2 commit'], { cwd: repoPath });
    const c2Hash = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();

    const dropRes: any = await worker.request('msg', {
      command: 'dropCommit',
      repo: repoPath,
      commitHash: c2Hash
    });
    assert.equal(dropRes.command, 'dropCommit');
    assert.equal(dropRes.error, null);
    assert.equal(cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim(), c1Hash);

    await worker.deactivate();
  } finally {
    cleanup();
  }
});

test('handles merge and rebase in temp repo', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });

    // Create branch b1 with a commit
    cp.execFileSync('git', ['checkout', '-b', 'b1'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'b1.txt'), 'b1 content\n');
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    cp.execFileSync('git', ['commit', '-m', 'b1 commit'], { cwd: repoPath });

    // Back to main
    cp.execFileSync('git', ['checkout', 'main'], { cwd: repoPath });

    // 1. merge b1 into main (no-ff)
    const mergeRes: any = await worker.request('msg', {
      command: 'merge',
      repo: repoPath,
      obj: 'b1',
      actionOn: 'branch',
      createNewCommit: true,
      squash: false,
      noCommit: false
    });
    assert.equal(mergeRes.command, 'merge');
    assert.equal(mergeRes.actionOn, 'branch');
    assert.equal(mergeRes.error, null);
    assert.ok(fs.existsSync(path.join(repoPath, 'b1.txt')));

    // Create branch b2 from main~1, then rebase onto main
    const rootHash = cp.execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repoPath }).toString().trim();
    cp.execFileSync('git', ['checkout', '-b', 'b2', rootHash], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'b2.txt'), 'b2 content\n');
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    cp.execFileSync('git', ['commit', '-m', 'b2 commit'], { cwd: repoPath });

    // 2. rebase b2 onto main
    const rebaseRes: any = await worker.request('msg', {
      command: 'rebase',
      repo: repoPath,
      obj: 'main',
      actionOn: 'branch',
      ignoreDate: false,
      interactive: false
    });
    assert.equal(rebaseRes.command, 'rebase');
    assert.equal(rebaseRes.error, null);

    await worker.deactivate();
  } finally {
    cleanup();
  }
});

test('handles stash operations and uncommitted cleanup in temp repo', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });

    // Modify file and create untracked file
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'modified content\n');
    fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'untracked content\n');

    // 1. pushStash
    const pushStashRes: any = await worker.request('msg', {
      command: 'pushStash',
      repo: repoPath,
      message: 'WIP on initial',
      includeUntracked: true
    });
    assert.equal(pushStashRes.command, 'pushStash');
    assert.equal(pushStashRes.error, null);
    assert.ok(!fs.existsSync(path.join(repoPath, 'untracked.txt')));
    assert.equal(fs.readFileSync(path.join(repoPath, 'initial.txt'), 'utf8'), 'initial content\n');

    // 2. applyStash
    const applyRes: any = await worker.request('msg', {
      command: 'applyStash',
      repo: repoPath,
      selector: 'stash@{0}',
      reinstateIndex: false
    });
    assert.equal(applyRes.command, 'applyStash');
    assert.equal(applyRes.error, null);
    assert.equal(fs.readFileSync(path.join(repoPath, 'initial.txt'), 'utf8'), 'modified content\n');

    // 3. resetUncommitted
    const resetUncommittedRes: any = await worker.request('msg', {
      command: 'resetUncommitted',
      repo: repoPath,
      mode: 'hard'
    });
    assert.equal(resetUncommittedRes.command, 'resetUncommitted');
    assert.equal(resetUncommittedRes.error, null);
    assert.equal(fs.readFileSync(path.join(repoPath, 'initial.txt'), 'utf8'), 'initial content\n');

    // Clean untracked files before popping stash
    await worker.request('msg', {
      command: 'cleanUntrackedFiles',
      repo: repoPath,
      directories: true
    });
    assert.ok(!fs.existsSync(path.join(repoPath, 'untracked.txt')));

    // 4. popStash
    const popRes: any = await worker.request('msg', {
      command: 'popStash',
      repo: repoPath,
      selector: 'stash@{0}',
      reinstateIndex: false
    });
    assert.equal(popRes.command, 'popStash');
    assert.equal(popRes.error, null);
    assert.equal(fs.readFileSync(path.join(repoPath, 'initial.txt'), 'utf8'), 'modified content\n');

    // Clean with reset hard
    cp.execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repoPath });

    // Create another stash to test dropStash and branchFromStash
    fs.writeFileSync(path.join(repoPath, 'stash2.txt'), 'stash2\n');
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    await worker.request('msg', {
      command: 'pushStash',
      repo: repoPath,
      message: 'stash 2',
      includeUntracked: false
    });

    // 5. branchFromStash
    const branchFromStashRes: any = await worker.request('msg', {
      command: 'branchFromStash',
      repo: repoPath,
      selector: 'stash@{0}',
      branchName: 'stash-branch'
    });
    assert.equal(branchFromStashRes.command, 'branchFromStash');
    assert.equal(branchFromStashRes.error, null);
    const currentBranch = cp.execFileSync('git', ['branch', '--show-current'], { cwd: repoPath }).toString().trim();
    assert.equal(currentBranch, 'stash-branch');

    // Back to main
    cp.execFileSync('git', ['checkout', 'main'], { cwd: repoPath });

    // Test dropStash: create a stash and drop it
    fs.writeFileSync(path.join(repoPath, 'stash3.txt'), 'stash3\n');
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    await worker.request('msg', {
      command: 'pushStash',
      repo: repoPath,
      message: 'stash 3',
      includeUntracked: false
    });
    const dropRes: any = await worker.request('msg', {
      command: 'dropStash',
      repo: repoPath,
      selector: 'stash@{0}'
    });
    assert.equal(dropRes.command, 'dropStash');
    assert.equal(dropRes.error, null);

    // 6. cleanUntrackedFiles
    fs.writeFileSync(path.join(repoPath, 'extra.txt'), 'extra\n');
    assert.ok(fs.existsSync(path.join(repoPath, 'extra.txt')));
    const cleanRes: any = await worker.request('msg', {
      command: 'cleanUntrackedFiles',
      repo: repoPath,
      directories: true
    });
    assert.equal(cleanRes.command, 'cleanUntrackedFiles');
    assert.equal(cleanRes.error, null);
    assert.ok(!fs.existsSync(path.join(repoPath, 'extra.txt')));

    await worker.deactivate();
  } finally {
    cleanup();
  }
});

test('persists alwaysAcceptCheckoutCommit via setGlobalViewState', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
    results: {
      'workspace.list': {
        workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'orca-git-graph', path: process.cwd(), branch: 'main', hostId: null }],
        truncated: false
      },
      'workspace.readContext': { branch: 'main', displayName: 'orca-git-graph', terminals: [] }
    }
  });

  const worker = await mountWorker(main, { host });

  // Initial state has alwaysAcceptCheckoutCommit: false
  let state: any = await worker.request('getInitialState');
  assert.equal(state.globalState.alwaysAcceptCheckoutCommit, false);

  // Set alwaysAcceptCheckoutCommit to true
  const setRes: any = await worker.request('msg', {
    command: 'setGlobalViewState',
    state: { alwaysAcceptCheckoutCommit: true }
  });
  assert.equal(setRes.command, 'setGlobalViewState');
  assert.equal(setRes.error, null);

  // Next getInitialState should return true
  state = await worker.request('getInitialState');
  assert.equal(state.globalState.alwaysAcceptCheckoutCommit, true);

  await worker.deactivate();
});

test('areStagedChanges correctly identifies staged vs unstaged modifications', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const ds = new DataSource();
    // 1. Clean repo has no staged changes
    assert.equal(await ds.areStagedChanges(repoPath), false);

    // 2. Unstaged modification must NOT be treated as staged
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'unstaged change\n');
    assert.equal(await ds.areStagedChanges(repoPath), false);

    // 3. Staged modification must be detected
    cp.execFileSync('git', ['add', '.'], { cwd: repoPath });
    assert.equal(await ds.areStagedChanges(repoPath), true);

    // 4. Unborn empty repo and staged files
    const unbornPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unborn-'));
    try {
      cp.execFileSync('git', ['init'], { cwd: unbornPath });
      assert.equal(await ds.areStagedChanges(unbornPath), false);

      fs.writeFileSync(path.join(unbornPath, 'file.txt'), 'content\n');
      assert.equal(await ds.areStagedChanges(unbornPath), false);

      cp.execFileSync('git', ['add', '.'], { cwd: unbornPath });
      assert.equal(await ds.areStagedChanges(unbornPath), true);
    } finally {
      fs.rmSync(unbornPath, { recursive: true, force: true });
    }

    // 5. SHA-256 repo with unborn branch
    const sha256Path = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sha256-'));
    try {
      cp.execFileSync('git', ['init', '--object-format=sha256'], { cwd: sha256Path });
      assert.equal(await ds.areStagedChanges(sha256Path), false);

      fs.writeFileSync(path.join(sha256Path, 'sha256.txt'), 'sha256 content\n');
      assert.equal(await ds.areStagedChanges(sha256Path), false);

      cp.execFileSync('git', ['add', '.'], { cwd: sha256Path });
      assert.equal(await ds.areStagedChanges(sha256Path), true);
    } finally {
      fs.rmSync(sha256Path, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test('handles editRemote operations (rename, set fetch url, set/delete push url)', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    cp.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/foo/origin.git'], { cwd: repoPath });

    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });

    // 1. Validation failure for invalid new remote name
    const invalidRes: any = await worker.request('msg', {
      command: 'editRemote',
      repo: repoPath,
      nameOld: 'origin',
      nameNew: '-invalid',
      urlOld: 'https://github.com/foo/origin.git',
      urlNew: 'https://github.com/foo/origin.git',
      pushUrlOld: null,
      pushUrlNew: null
    });
    assert.equal(invalidRes.command, 'editRemote');
    assert.ok(invalidRes.error && invalidRes.error.includes('cannot start with "-"'));

    // 1b. Validation failure for empty remote name
    const emptyRes: any = await worker.request('msg', {
      command: 'editRemote',
      repo: repoPath,
      nameOld: 'origin',
      nameNew: '   ',
      urlOld: 'https://github.com/foo/origin.git',
      urlNew: 'https://github.com/foo/origin.git',
      pushUrlOld: null,
      pushUrlNew: null
    });
    assert.equal(emptyRes.command, 'editRemote');
    assert.equal(emptyRes.error, 'Remote name cannot be empty');

    // 2. Rename origin -> upstream and update fetch URL and add push URL
    const editRes: any = await worker.request('msg', {
      command: 'editRemote',
      repo: repoPath,
      nameOld: 'origin',
      nameNew: 'upstream',
      urlOld: 'https://github.com/foo/origin.git',
      urlNew: 'https://github.com/foo/upstream.git',
      pushUrlOld: null,
      pushUrlNew: 'https://github.com/foo/upstream-push.git'
    });
    assert.equal(editRes.command, 'editRemote');
    assert.equal(editRes.error, null);

    let remotesVerbose = cp.execFileSync('git', ['remote', '-v'], { cwd: repoPath }).toString();
    assert.ok(remotesVerbose.includes('upstream\thttps://github.com/foo/upstream.git (fetch)'));
    assert.ok(remotesVerbose.includes('upstream\thttps://github.com/foo/upstream-push.git (push)'));

    // 3. Update existing push URL
    const updatePushRes: any = await worker.request('msg', {
      command: 'editRemote',
      repo: repoPath,
      nameOld: 'upstream',
      nameNew: 'upstream',
      urlOld: 'https://github.com/foo/upstream.git',
      urlNew: 'https://github.com/foo/upstream.git',
      pushUrlOld: 'https://github.com/foo/upstream-push.git',
      pushUrlNew: 'https://github.com/foo/upstream-push2.git'
    });
    assert.equal(updatePushRes.command, 'editRemote');
    assert.equal(updatePushRes.error, null);
    remotesVerbose = cp.execFileSync('git', ['remote', '-v'], { cwd: repoPath }).toString();
    assert.ok(remotesVerbose.includes('upstream\thttps://github.com/foo/upstream-push2.git (push)'));

    // 4. Delete push URL
    const deletePushRes: any = await worker.request('msg', {
      command: 'editRemote',
      repo: repoPath,
      nameOld: 'upstream',
      nameNew: 'upstream',
      urlOld: 'https://github.com/foo/upstream.git',
      urlNew: 'https://github.com/foo/upstream.git',
      pushUrlOld: 'https://github.com/foo/upstream-push2.git',
      pushUrlNew: null
    });
    assert.equal(deletePushRes.command, 'editRemote');
    assert.equal(deletePushRes.error, null);
    remotesVerbose = cp.execFileSync('git', ['remote', '-v'], { cwd: repoPath }).toString();
    assert.ok(!remotesVerbose.includes('upstream-push2'));

    await worker.deactivate();
  } finally {
    cleanup();
  }
});

test('handles editUserDetails and deleteUserDetails with frontend expected response', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });

    // 1. Set local user details
    const editLocalRes: any = await worker.request('msg', {
      command: 'editUserDetails',
      repo: repoPath,
      name: 'Custom User',
      email: 'custom@example.com',
      location: 'local',
      deleteLocalName: false,
      deleteLocalEmail: false
    });
    assert.equal(editLocalRes.command, 'editUserDetails');
    assert.deepEqual(editLocalRes.errors, [null, null]);

    assert.equal(cp.execFileSync('git', ['config', '--local', 'user.name'], { cwd: repoPath }).toString().trim(), 'Custom User');
    assert.equal(cp.execFileSync('git', ['config', '--local', 'user.email'], { cwd: repoPath }).toString().trim(), 'custom@example.com');

    // 2. Delete user details
    const deleteRes: any = await worker.request('msg', {
      command: 'deleteUserDetails',
      repo: repoPath,
      name: true,
      email: true,
      location: 'local'
    });
    assert.equal(deleteRes.command, 'deleteUserDetails');
    assert.deepEqual(deleteRes.errors, [null, null]);

    // user.name and user.email should no longer be in local config
    const localConfig = cp.execFileSync('git', ['config', '--local', '--list'], { cwd: repoPath }).toString();
    assert.ok(!localConfig.includes('user.name='));
    assert.ok(!localConfig.includes('user.email='));

    // 3. Deleting already-unset user details should succeed without errors (exit code 5 tolerated)
    const deleteAgainRes: any = await worker.request('msg', {
      command: 'deleteUserDetails',
      repo: repoPath,
      name: true,
      email: true,
      location: 'local'
    });
    assert.equal(deleteAgainRes.command, 'deleteUserDetails');
    assert.deepEqual(deleteAgainRes.errors, [null, null]);

    // 4. deleteUserDetails with neither name nor email returns [null] so frontend reloads config
    const deleteNoneRes: any = await worker.request('msg', {
      command: 'deleteUserDetails',
      repo: repoPath,
      name: false,
      email: false,
      location: 'local'
    });
    assert.equal(deleteNoneRes.command, 'deleteUserDetails');
    assert.deepEqual(deleteNoneRes.errors, [null]);

    // 5. editUserDetails with deleteLocal when local config does not exist
    const editWithDeleteLocalRes: any = await worker.request('msg', {
      command: 'editUserDetails',
      repo: repoPath,
      name: 'Global User',
      email: 'global@example.com',
      location: 'local',
      deleteLocalName: true,
      deleteLocalEmail: true
    });
    assert.equal(editWithDeleteLocalRes.command, 'editUserDetails');
    assert.deepEqual(editWithDeleteLocalRes.errors, [null, null, null, null]);

    await worker.deactivate();
  } finally {
    cleanup();
  }
});

test('getStashes returns selector formatted as stash@{0}', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'stash test\n');
    cp.execFileSync('git', ['stash', 'push', '-m', 'test stash message'], { cwd: repoPath });

    const ds = new DataSource();
    const stashes = await ds.getStashes(repoPath);
    assert.equal(stashes.length, 1);
    assert.equal(stashes[0].selector, 'stash@{0}');
    assert.ok(!stashes[0].selector.startsWith('refs/'));
  } finally {
    cleanup();
  }
});

test('preserves and restores repoState via setRepoState and across reloads', async () => {
  const { repoPath, cleanup } = initTestRepo();
  try {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'storage:own', 'notifications:show'],
      results: {
        'workspace.list': {
          workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'test-repo', path: repoPath, branch: 'main', hostId: null }],
          truncated: false
        },
        'workspace.readContext': { branch: 'main', displayName: 'test-repo', terminals: [] }
      }
    });

    const worker = await mountWorker(main, { host });

    // Initial state has default repo state
    let state: any = await worker.request('getInitialState');
    const repoKey = state.initialState.lastActiveRepo;
    assert.ok(repoKey);
    assert.equal(state.initialState.repos[repoKey].cdvDivider, 0.5);

    // Set custom repo state and workspace view state
    const setRepoRes: any = await worker.request('msg', {
      command: 'setRepoState',
      repo: repoKey,
      state: {
        cdvDivider: 0.8,
        cdvHeight: 320,
        columnWidths: [120, 240, 180, 80],
        showStashes: 1
      }
    });
    assert.equal(setRepoRes.command, 'setRepoState');
    assert.equal(setRepoRes.error, null);

    const setWorkspaceRes: any = await worker.request('msg', {
      command: 'setWorkspaceViewState',
      state: {
        findIsCaseSensitive: true,
        findIsRegex: true
      }
    });
    assert.equal(setWorkspaceRes.command, 'setWorkspaceViewState');

    // loadRepos should reflect updated repo state
    const loadReposRes: any = await worker.request('msg', {
      command: 'loadRepos'
    });
    assert.equal(loadReposRes.repos[repoKey].cdvDivider, 0.8);
    assert.equal(loadReposRes.repos[repoKey].cdvHeight, 320);
    assert.deepEqual(loadReposRes.repos[repoKey].columnWidths, [120, 240, 180, 80]);
    assert.equal(loadReposRes.repos[repoKey].showStashes, 1);

    // getInitialState should also reflect updated repo state
    state = await worker.request('getInitialState');
    assert.equal(state.initialState.repos[repoKey].cdvDivider, 0.8);
    assert.equal(state.initialState.repos[repoKey].cdvHeight, 320);

    await worker.deactivate();

    // Verify storage persistence across a fresh worker mount on the same host
    const worker2 = await mountWorker(main, { host });
    const state2: any = await worker2.request('getInitialState');
    assert.equal(state2.initialState.repos[repoKey].cdvDivider, 0.8);
    assert.equal(state2.initialState.repos[repoKey].cdvHeight, 320);
    assert.deepEqual(state2.initialState.repos[repoKey].columnWidths, [120, 240, 180, 80]);
    assert.equal(state2.workspaceState.findIsCaseSensitive, true);
    assert.equal(state2.workspaceState.findIsRegex, true);

    await worker2.deactivate();
  } finally {
    cleanup();
  }
});
