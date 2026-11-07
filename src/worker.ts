import * as cp from 'node:child_process';
import * as path from 'node:path';
import type { OrcaWorkerApi } from 'orca/worker';
import { DataSource, UNCOMMITTED } from './dataSource.ts';

const DEFAULT_REPO_STATE = {
  cdvDivider: 0.5,
  cdvHeight: 250,
  columnWidths: null,
  commitOrdering: 'default',
  fileViewType: 0,
  hideRemotes: [],
  includeCommitsMentionedByReflogs: 0,
  issueLinkingConfig: null,
  lastImportAt: 0,
  name: null,
  onlyFollowFirstParent: 0,
  onRepoLoadShowCheckedOutBranch: 0,
  onRepoLoadShowSpecificBranches: null,
  pullRequestConfig: null,
  showRemoteBranches: true,
  showRemoteBranchesV2: 0,
  showStashes: 0,
  showTags: 0,
  workspaceFolderIndex: null
};

const DEFAULT_CONFIG = {
  commitDetailsView: { autoCenter: true, fileTreeCompactFolders: true, fileViewType: 1, location: 0 },
  commitOrdering: 'date',
  contextMenuActionsVisibility: {
    branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
    commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, copyHash: true, copySubject: true },
    remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
    stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true },
    tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
    uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true }
  },
  customBranchGlobPatterns: [],
  customEmojiShortcodeMappings: [],
  customPullRequestProviders: [],
  dateFormat: { type: 0, iso: false },
  defaultColumnVisibility: { author: true, commit: true, date: true },
  dialogDefaults: {
    addTag: { pushToRemote: false, type: 0 },
    applyStash: { reinstateIndex: false },
    cherryPick: { noCommit: false, recordOrigin: false },
    createBranch: { checkout: false },
    deleteBranch: { forceDelete: false },
    fetchIntoLocalBranch: { forceFetch: false },
    fetchRemote: { prune: false, pruneTags: false },
    general: { referenceInputSpaceSubstitution: null },
    merge: { noCommit: false, noFastForward: true, squash: false },
    popStash: { reinstateIndex: false },
    pullBranch: { noFastForward: false, squash: false },
    rebase: { ignoreDate: true, interactive: false },
    resetCommit: { mode: 'mixed' },
    resetUncommitted: { mode: 'mixed' },
    stashUncommittedChanges: { includeUntracked: true }
  },
  enhancedAccessibility: false,
  fetchAndPrune: false,
  fetchAndPruneTags: false,
  fetchAvatars: false,
  graph: {
    colours: ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'],
    style: 0,
    grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
    uncommittedChanges: 0
  },
  includeCommitsMentionedByReflogs: false,
  initialLoadCommits: 300,
  keybindings: { find: 'f', refresh: 'r', scrollToHead: 'h', scrollToStash: 's' },
  loadMoreCommits: 100,
  loadMoreCommitsAutomatically: true,
  markdown: true,
  mute: { commitsNotAncestorsOfHead: false, mergeCommits: true },
  onlyFollowFirstParent: false,
  onRepoLoad: { scrollToHead: false, showCheckedOutBranch: false, showSpecificBranches: [] },
  referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
  repoDropdownOrder: 2,
  showRemoteBranches: true,
  showStashes: true,
  showTags: true
};

export async function getActiveRepo(orca: OrcaWorkerApi, dataSource: DataSource = new DataSource()): Promise<string | null> {
  try {
    const list = await orca.host.call('workspace.list');
    const ctx = await orca.host.call('workspace.readContext');
    const workspaces: any[] = list?.workspaces || [];

    if (workspaces.length === 0) {
      return null;
    }

    // 1. Match displayName + branch simultaneously (prefer kind === 'worktree')
    const hasCtxMatch = Boolean(ctx?.displayName || ctx?.branch);
    if (hasCtxMatch) {
      const candidates = workspaces.filter((w: any) => {
        const nameMatches = ctx.displayName ? w.name === ctx.displayName : true;
        const branchMatches = ctx.branch ? w.branch === ctx.branch : true;
        return nameMatches && branchMatches;
      });

      candidates.sort((a, b) => {
        if (a.kind === 'worktree' && b.kind !== 'worktree') return -1;
        if (a.kind !== 'worktree' && b.kind === 'worktree') return 1;
        return 0;
      });

      for (const c of candidates) {
        if (c.path) {
          const root = await dataSource.repoRoot(c.path);
          if (root) return root;
        }
      }
    }

    // 2. If not matched or candidates were not git repos, take first kind === 'worktree' that is a git repo
    for (const w of workspaces) {
      if (w.kind === 'worktree' && w.path) {
        const root = await dataSource.repoRoot(w.path);
        if (root) return root;
      }
    }

    // 3. Fallback: check any remaining workspaces that are git repos
    for (const w of workspaces) {
      if (w.kind !== 'worktree' && w.path) {
        const root = await dataSource.repoRoot(w.path);
        if (root) return root;
      }
    }
  } catch {}

  return null;
}

export async function loadStoredRepoStates(orca: OrcaWorkerApi): Promise<Record<string, any>> {
  try {
    if (orca.storage?.get) {
      const val = await orca.storage.get('repoStates');
      if (val && typeof val === 'object') {
        return val as Record<string, any>;
      }
    }
  } catch {}
  return {};
}

export async function saveStoredRepoStates(orca: OrcaWorkerApi, states: Record<string, any>): Promise<void> {
  try {
    if (orca.storage?.set) {
      await orca.storage.set('repoStates', states);
    }
  } catch {}
}

export async function getReposState(
  orca: OrcaWorkerApi,
  dataSource: DataSource = new DataSource(),
  savedStates?: Record<string, any>
): Promise<{ activeRepo: string | null; repos: Record<string, typeof DEFAULT_REPO_STATE> }> {
  const activeRepo = await getActiveRepo(orca, dataSource);
  const repos: Record<string, typeof DEFAULT_REPO_STATE> = {};
  const saved = savedStates ?? (await loadStoredRepoStates(orca));

  try {
    const list = await orca.host.call('workspace.list');
    const workspaces: any[] = list?.workspaces || [];
    for (const w of workspaces) {
      if (w?.path && (w.kind === 'worktree' || !w.kind)) {
        const root = await dataSource.repoRoot(w.path);
        if (root && !repos[root]) {
          repos[root] = { ...DEFAULT_REPO_STATE, ...(saved[root] || {}) };
        }
      }
    }
  } catch {}

  if (activeRepo && !repos[activeRepo]) {
    repos[activeRepo] = { ...DEFAULT_REPO_STATE, ...(saved[activeRepo] || {}) };
  }

  return { activeRepo, repos };
}

export default function activate(orca: OrcaWorkerApi): void {
  const dataSource = new DataSource();
  const storedRepoStates: Record<string, any> = {};
  let storedStatesLoaded = false;

  async function ensureStoredStates(): Promise<void> {
    if (!storedStatesLoaded) {
      const loaded = await loadStoredRepoStates(orca);
      Object.assign(storedRepoStates, loaded);
      storedStatesLoaded = true;
    }
  }

  let globalViewState = {
    alwaysAcceptCheckoutCommit: false,
    issueLinkingConfig: null
  };

  let workspaceViewState = {
    findIsCaseSensitive: false,
    findIsRegex: false,
    findOpenCommitDetailsView: false
  };

  orca.panels.handle('getInitialState', async () => {
    await ensureStoredStates();
    if (orca.storage?.get) {
      try {
        const savedGlobal = await orca.storage.get('globalViewState');
        if (savedGlobal && typeof savedGlobal === 'object') {
          globalViewState = { ...globalViewState, ...savedGlobal };
        }
      } catch {}
      try {
        const savedWorkspace = await orca.storage.get('workspaceViewState');
        if (savedWorkspace && typeof savedWorkspace === 'object') {
          workspaceViewState = { ...workspaceViewState, ...savedWorkspace };
        }
      } catch {}
    }
    const { activeRepo, repos } = await getReposState(orca, dataSource, storedRepoStates);
    if (!activeRepo) {
      return {
        error: '当前 workspace 不是 Git 仓库',
        initialState: null,
        globalState: null,
        workspaceState: null
      };
    }

    return {
      error: null,
      initialState: {
        config: DEFAULT_CONFIG,
        lastActiveRepo: activeRepo,
        loadViewTo: null,
        repos,
        loadRepoInfoRefreshId: 0,
        loadCommitsRefreshId: 0
      },
      globalState: globalViewState,
      workspaceState: workspaceViewState
    };
  });

  orca.panels.handle('msg', async (msg: any) => {
    if (!msg || typeof msg !== 'object' || !msg.command) {
      return { error: 'Invalid message' };
    }

    let reply: any = null;

    switch (msg.command) {
      case 'loadRepoInfo': {
        const repoInfo = await dataSource.getRepoInfo(
          msg.repo,
          msg.showRemoteBranches !== false,
          msg.showStashes !== false,
          msg.hideRemotes || []
        );
        let isRepo = true;
        if (repoInfo.error) {
          isRepo = (await dataSource.repoRoot(msg.repo)) !== null;
          if (!isRepo) repoInfo.error = null;
        }
        reply = {
          command: 'loadRepoInfo',
          refreshId: msg.refreshId,
          ...repoInfo,
          isRepo
        };
        break;
      }

      case 'loadCommits': {
        const commitsData = await dataSource.getCommits(
          msg.repo,
          msg.branches || null,
          msg.maxCommits || 300,
          msg.showTags !== false,
          msg.showRemoteBranches !== false,
          !!msg.includeCommitsMentionedByReflogs,
          !!msg.onlyFollowFirstParent,
          msg.commitOrdering || 'date',
          msg.remotes || [],
          msg.hideRemotes || [],
          msg.stashes || []
        );
        reply = {
          command: 'loadCommits',
          refreshId: msg.refreshId ?? 0,
          onlyFollowFirstParent: msg.onlyFollowFirstParent ?? false,
          ...commitsData
        };
        break;
      }

      case 'commitDetails': {
        let detailsData: any;
        if (msg.commitHash === UNCOMMITTED) {
          detailsData = await dataSource.getUncommittedDetails(msg.repo);
        } else if (msg.stash === null || msg.stash === undefined) {
          detailsData = await dataSource.getCommitDetails(msg.repo, msg.commitHash, !!msg.hasParents);
        } else {
          detailsData = await dataSource.getStashDetails(msg.repo, msg.commitHash, msg.stash);
        }
        reply = {
          command: 'commitDetails',
          ...detailsData,
          avatar: null,
          codeReview: null,
          refresh: !!msg.refresh
        };
        break;
      }

      case 'compareCommits': {
        const comparison = await dataSource.getCommitComparison(msg.repo, msg.fromHash, msg.toHash);
        reply = {
          command: 'compareCommits',
          commitHash: msg.commitHash,
          compareWithHash: msg.compareWithHash,
          ...comparison,
          codeReview: null,
          refresh: !!msg.refresh
        };
        break;
      }

      case 'loadConfig': {
        const configData = await dataSource.getConfig(msg.repo, msg.remotes || []);
        reply = {
          command: 'loadConfig',
          repo: msg.repo,
          ...configData
        };
        break;
      }

      case 'loadRepos':
      case 'rescanForRepos': {
        await ensureStoredStates();
        const { activeRepo, repos } = await getReposState(orca, dataSource, storedRepoStates);
        reply = {
          command: 'loadRepos',
          repos,
          lastActiveRepo: activeRepo,
          loadViewTo: null
        };
        break;
      }

      case 'tagDetails': {
        const tagData = await dataSource.getTagDetails(msg.repo, msg.tagName);
        reply = {
          command: 'tagDetails',
          tagName: msg.tagName,
          commitHash: msg.commitHash,
          ...tagData
        };
        break;
      }

      case 'viewDiff':
      case 'viewDiffWithWorkingFile':
      case 'viewFileAtRevision':
      case 'openFile': {
        let err: string | null = null;
        try {
          const list = await orca.host.call('workspace.list');
          const ws = list?.workspaces?.find((w: any) => w.path === msg.repo) || list?.workspaces?.[0];
          if (ws) {
            const targetPath = msg.newFilePath || msg.filePath;
            if (targetPath) {
              await orca.host.call('editor.open', { workspaceId: ws.id, path: targetPath });
            }
          }
        } catch {
          // Keep err null on failure to prevent front-end crash
        }
        reply = {
          command: msg.command,
          error: err
        };
        break;
      }

      case 'copyFilePath': {
        const targetPath = msg.absolute ? path.join(msg.repo, msg.filePath) : msg.filePath;
        try {
          const proc = cp.spawn('pbcopy');
          proc.stdin.write(targetPath);
          proc.stdin.end();
        } catch {}
        reply = {
          command: 'copyFilePath',
          error: null
        };
        break;
      }

      case 'copyToClipboard': {
        try {
          const proc = cp.spawn('pbcopy');
          proc.stdin.write(String(msg.data ?? ''));
          proc.stdin.end();
        } catch {}
        reply = {
          command: 'copyToClipboard',
          type: msg.type,
          error: null
        };
        break;
      }

      case 'setRepoState': {
        if (msg.repo && msg.state && typeof msg.state === 'object') {
          await ensureStoredStates();
          storedRepoStates[msg.repo] = {
            ...(storedRepoStates[msg.repo] || DEFAULT_REPO_STATE),
            ...msg.state
          };
          await saveStoredRepoStates(orca, storedRepoStates);
        }
        reply = {
          command: msg.command,
          error: null
        };
        break;
      }

      case 'setGlobalViewState': {
        if (msg.state) {
          globalViewState = { ...globalViewState, ...msg.state };
          if (orca.storage?.set) {
            await orca.storage.set('globalViewState', globalViewState).catch(() => {});
          }
        }
        reply = {
          command: msg.command,
          error: null
        };
        break;
      }

      case 'setWorkspaceViewState': {
        if (msg.state) {
          workspaceViewState = { ...workspaceViewState, ...msg.state };
          if (orca.storage?.set) {
            await orca.storage.set('workspaceViewState', workspaceViewState).catch(() => {});
          }
        }
        reply = {
          command: msg.command,
          error: null
        };
        break;
      }

      case 'showErrorMessage': {
        try {
          await orca.host.call('notifications.show', {
            title: 'Git Graph',
            body: String(msg.message ?? '')
          });
        } catch {}
        reply = { ok: true };
        break;
      }

      case 'viewScm': {
        reply = {
          command: 'viewScm',
          error: null
        };
        break;
      }

      // 1. Branch operations
      case 'checkoutBranch': {
        const errorInfos: (string | null)[] = [
          await dataSource.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch ?? null)
        ];
        if (errorInfos[0] === null && msg.pullAfterwards) {
          errorInfos.push(
            await dataSource.pullBranch(
              msg.repo,
              msg.pullAfterwards.branchName,
              msg.pullAfterwards.remote,
              !!msg.pullAfterwards.createNewCommit,
              !!msg.pullAfterwards.squash
            )
          );
        }
        reply = {
          command: 'checkoutBranch',
          pullAfterwards: msg.pullAfterwards ?? null,
          errors: errorInfos
        };
        break;
      }

      case 'checkoutCommit': {
        const error = await dataSource.checkoutCommit(msg.repo, msg.commitHash);
        reply = {
          command: 'checkoutCommit',
          error
        };
        break;
      }

      case 'createBranch': {
        const errors = await dataSource.createBranch(
          msg.repo,
          msg.branchName,
          msg.commitHash,
          !!msg.checkout,
          !!msg.force
        );
        reply = {
          command: 'createBranch',
          errors
        };
        break;
      }

      case 'deleteBranch': {
        const errorInfos: (string | null)[] = [
          await dataSource.deleteBranch(msg.repo, msg.branchName, !!msg.forceDelete)
        ];
        if (errorInfos[0] === null && Array.isArray(msg.deleteOnRemotes)) {
          for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
            errorInfos.push(await dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.deleteOnRemotes[i]));
          }
        }
        reply = {
          command: 'deleteBranch',
          repo: msg.repo,
          branchName: msg.branchName,
          deleteOnRemotes: msg.deleteOnRemotes ?? [],
          errors: errorInfos
        };
        break;
      }

      case 'deleteRemoteBranch': {
        const error = await dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.remote);
        reply = {
          command: 'deleteRemoteBranch',
          error
        };
        break;
      }

      case 'renameBranch': {
        const error = await dataSource.renameBranch(msg.repo, msg.oldName, msg.newName);
        reply = {
          command: 'renameBranch',
          error
        };
        break;
      }

      case 'fetch': {
        const error = await dataSource.fetch(msg.repo, msg.name ?? null, !!msg.prune, !!msg.pruneTags);
        reply = {
          command: 'fetch',
          error
        };
        break;
      }

      case 'fetchIntoLocalBranch': {
        const error = await dataSource.fetchIntoLocalBranch(
          msg.repo,
          msg.remote,
          msg.remoteBranch,
          msg.localBranch,
          !!msg.force
        );
        reply = {
          command: 'fetchIntoLocalBranch',
          error
        };
        break;
      }

      case 'pullBranch': {
        const error = await dataSource.pullBranch(
          msg.repo,
          msg.branchName,
          msg.remote,
          !!msg.createNewCommit,
          !!msg.squash
        );
        reply = {
          command: 'pullBranch',
          error
        };
        break;
      }

      case 'pushBranch': {
        const errors = await dataSource.pushBranchToMultipleRemotes(
          msg.repo,
          msg.branchName,
          msg.remotes || [],
          !!msg.setUpstream,
          msg.mode || ''
        );
        reply = {
          command: 'pushBranch',
          willUpdateBranchConfig: msg.willUpdateBranchConfig,
          errors
        };
        break;
      }

      // 2. Tag operations
      case 'addTag': {
        const errorInfos: (string | null)[] = [
          await dataSource.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, !!msg.force)
        ];
        if (errorInfos[0] === null && msg.pushToRemote !== null && msg.pushToRemote !== undefined) {
          errorInfos.push(await dataSource.pushTag(msg.repo, msg.tagName, msg.pushToRemote));
        }
        reply = {
          command: 'addTag',
          errors: errorInfos
        };
        break;
      }

      case 'deleteTag': {
        const error = await dataSource.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote ?? null);
        reply = {
          command: 'deleteTag',
          error
        };
        break;
      }

      case 'pushTag': {
        const errors = await dataSource.pushTagToMultipleRemotes(
          msg.repo,
          msg.tagName,
          msg.remotes || []
        );
        reply = {
          command: 'pushTag',
          errors
        };
        break;
      }

      // 3. Commit operations
      case 'cherrypickCommit': {
        const errorInfos: (string | null)[] = [
          await dataSource.cherrypickCommit(
            msg.repo,
            msg.commitHash,
            msg.parentIndex ?? 0,
            !!msg.recordOrigin,
            !!msg.noCommit
          )
        ];
        if (errorInfos[0] === null && msg.noCommit) {
          errorInfos.push(null);
        }
        reply = {
          command: 'cherrypickCommit',
          errors: errorInfos
        };
        break;
      }

      case 'revertCommit': {
        const error = await dataSource.revertCommit(msg.repo, msg.commitHash, msg.parentIndex ?? 0);
        reply = {
          command: 'revertCommit',
          error
        };
        break;
      }

      case 'resetToCommit': {
        const error = await dataSource.resetToCommit(msg.repo, msg.commit, msg.resetMode);
        reply = {
          command: 'resetToCommit',
          error
        };
        break;
      }

      case 'dropCommit': {
        const error = await dataSource.dropCommit(msg.repo, msg.commitHash);
        reply = {
          command: 'dropCommit',
          error
        };
        break;
      }

      case 'merge': {
        const error = await dataSource.merge(
          msg.repo,
          msg.obj,
          msg.actionOn,
          !!msg.createNewCommit,
          !!msg.squash,
          !!msg.noCommit
        );
        reply = {
          command: 'merge',
          actionOn: msg.actionOn,
          error
        };
        break;
      }

      case 'rebase': {
        const error = await dataSource.rebase(
          msg.repo,
          msg.obj,
          msg.actionOn,
          !!msg.ignoreDate,
          !!msg.interactive
        );
        reply = {
          command: 'rebase',
          actionOn: msg.actionOn,
          interactive: msg.interactive,
          error
        };
        break;
      }

      // 4. Stash operations & uncommitted
      case 'pushStash': {
        const error = await dataSource.pushStash(msg.repo, msg.message, !!msg.includeUntracked);
        reply = {
          command: 'pushStash',
          error
        };
        break;
      }

      case 'applyStash': {
        const error = await dataSource.applyStash(msg.repo, msg.selector, !!msg.reinstateIndex);
        reply = {
          command: 'applyStash',
          error
        };
        break;
      }

      case 'popStash': {
        const error = await dataSource.popStash(msg.repo, msg.selector, !!msg.reinstateIndex);
        reply = {
          command: 'popStash',
          error
        };
        break;
      }

      case 'dropStash': {
        const error = await dataSource.dropStash(msg.repo, msg.selector);
        reply = {
          command: 'dropStash',
          error
        };
        break;
      }

      case 'branchFromStash': {
        const error = await dataSource.branchFromStash(msg.repo, msg.selector, msg.branchName);
        reply = {
          command: 'branchFromStash',
          error
        };
        break;
      }

      case 'cleanUntrackedFiles': {
        const error = await dataSource.cleanUntrackedFiles(msg.repo, !!msg.directories);
        reply = {
          command: 'cleanUntrackedFiles',
          error
        };
        break;
      }

      case 'resetUncommitted': {
        const error = await dataSource.resetUncommitted(msg.repo, msg.mode);
        reply = {
          command: 'resetUncommitted',
          error
        };
        break;
      }

      case 'createPullRequest': {
        const errorInfos: (string | null)[] = [
          msg.push ? await dataSource.pushBranch(msg.repo, msg.sourceBranch, msg.sourceRemote, true, '') : null
        ];
        reply = {
          command: 'createPullRequest',
          push: msg.push,
          errors: errorInfos
        };
        break;
      }

      case 'addRemote': {
        const error = await dataSource.addRemote(msg.repo, msg.name, msg.url, msg.pushUrl ?? null, !!msg.fetch);
        reply = {
          command: 'addRemote',
          error
        };
        break;
      }

      case 'editRemote': {
        const error = await dataSource.editRemote(
          msg.repo,
          msg.nameOld,
          msg.nameNew,
          msg.urlOld ?? null,
          msg.urlNew ?? null,
          msg.pushUrlOld ?? null,
          msg.pushUrlNew ?? null
        );
        reply = {
          command: 'editRemote',
          error
        };
        break;
      }

      case 'deleteRemote': {
        const error = await dataSource.deleteRemote(msg.repo, msg.name);
        reply = {
          command: 'deleteRemote',
          error
        };
        break;
      }

      case 'pruneRemote': {
        const error = await dataSource.pruneRemote(msg.repo, msg.name);
        reply = {
          command: 'pruneRemote',
          error
        };
        break;
      }

      case 'editUserDetails': {
        const location = msg.location === 'global' ? 'global' : 'local';
        const errors = await dataSource.editUserDetails(
          msg.repo,
          msg.name,
          msg.email,
          location,
          !!msg.deleteLocalName,
          !!msg.deleteLocalEmail
        );
        reply = {
          command: 'editUserDetails',
          errors
        };
        break;
      }

      case 'deleteUserDetails': {
        const location = msg.location === 'global' ? 'global' : 'local';
        const errors = await dataSource.deleteUserDetails(
          msg.repo,
          !!msg.name,
          !!msg.email,
          location
        );
        reply = {
          command: 'deleteUserDetails',
          errors
        };
        break;
      }

      case 'exportRepoConfig':
      case 'openExtensionSettings':
      case 'openExternalDirDiff':
      case 'openExternalUrl':
      case 'openTerminal': {
        reply = {
          command: msg.command,
          error: null
        };
        break;
      }

      default:
        reply = {
          command: msg.command,
          error: `Unrecognized command: ${msg.command}`
        };
        break;
    }

    if (reply) {
      orca.panels.post('msg', reply);
    }
    return reply;
  });

  orca.events.on('workspace.changed', async () => {
    try {
      await ensureStoredStates();
      const { activeRepo, repos } = await getReposState(orca, dataSource, storedRepoStates);
      if (activeRepo) {
        orca.panels.post('msg', {
          command: 'loadRepos',
          repos,
          lastActiveRepo: activeRepo,
          loadViewTo: null
        });
      }
    } catch {}
  });
}
