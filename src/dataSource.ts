import * as cp from 'node:child_process';
import * as path from 'node:path';

export const UNCOMMITTED = '*';
const EOL_REGEX = /\r\n|\r|\n/g;
const INVALID_BRANCH_REGEXP = /^\(.* .*\)$/;
const REMOTE_HEAD_BRANCH_REGEXP = /^remotes\/.*\/HEAD$/;
const GIT_LOG_SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';

export interface GitCommitNode {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  message: string;
  heads: string[];
  tags: { name: string; annotated: boolean }[];
  remotes: { name: string; remote: string | null }[];
  stash: {
    selector: string;
    baseHash: string;
    untrackedFilesHash: string | null;
  } | null;
}

export interface GitStash {
  hash: string;
  baseHash: string;
  untrackedFilesHash: string | null;
  selector: string;
  author: string;
  email: string;
  date: number;
  message: string;
}

export interface GitFileChange {
  oldFilePath: string;
  newFilePath: string;
  type: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitDetails {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  committerDate: number;
  signature: {
    key: string;
    signer: string;
    status: string;
  } | null;
  body: string;
  fileChanges: GitFileChange[];
}

const GIT_ENV = {
  ...process.env,
  LC_ALL: 'en_US.UTF-8',
  LANG: 'en_US.UTF-8',
  LANGUAGE: 'en_US.UTF-8'
};

export function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, env: GIT_ENV, maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(stderr || stdout || err.message);
      } else {
        resolve(stdout);
      }
    });
  });
}

export class DataSource {
  private gitFormatLog: string;
  private gitFormatCommitDetails: string;
  private gitFormatStash: string;

  constructor() {
    this.gitFormatLog = ['%H', '%P', '%an', '%ae', '%at', '%s'].join(GIT_LOG_SEPARATOR);
    this.gitFormatCommitDetails = [
      '%H', '%P',
      '%an', '%ae', '%at', '%cn', '%ce', '%ct',
      '%G?', '%GS', '%GK',
      '%B'
    ].join(GIT_LOG_SEPARATOR);
    this.gitFormatStash = ['%H', '%P', '%gd', '%an', '%ae', '%at', '%s'].join(GIT_LOG_SEPARATOR);
  }

  async repoRoot(p: string): Promise<string | null> {
    try {
      const out = await execGit(['rev-parse', '--show-toplevel'], p);
      return path.normalize(out.trim()).replace(/\\/g, '/');
    } catch {
      return null;
    }
  }

  async getRepoInfo(repo: string, showRemoteBranches = true, showStashes = true, hideRemotes: string[] = []) {
    try {
      const [branchesResult, remotes, stashes] = await Promise.all([
        this.getBranches(repo, showRemoteBranches, hideRemotes),
        this.getRemotes(repo),
        showStashes ? this.getStashes(repo) : Promise.resolve([])
      ]);
      return {
        branches: branchesResult.branches,
        head: branchesResult.head,
        remotes,
        stashes,
        error: null
      };
    } catch (e: any) {
      return {
        branches: [],
        head: null,
        remotes: [],
        stashes: [],
        error: typeof e === 'string' ? e : e?.message || 'Error loading repo info'
      };
    }
  }

  async getBranches(repo: string, showRemoteBranches: boolean, hideRemotes: string[]) {
    const args = ['branch'];
    if (showRemoteBranches) args.push('-a');
    args.push('--no-color');
    const hideRemotePatterns = hideRemotes.map(r => 'remotes/' + r + '/');

    try {
      const stdout = await execGit(args, repo);
      const branchData: { branches: string[]; head: string | null; error: string | null } = {
        branches: [],
        head: null,
        error: null
      };
      const lines = stdout.split(EOL_REGEX);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim() === '') continue;
        const name = line.substring(2).split(' -> ')[0].trim();
        if (
          INVALID_BRANCH_REGEXP.test(name) ||
          hideRemotePatterns.some(p => name.startsWith(p)) ||
          REMOTE_HEAD_BRANCH_REGEXP.test(name)
        ) {
          continue;
        }
        if (line[0] === '*') {
          branchData.head = name;
          branchData.branches.unshift(name);
        } else {
          branchData.branches.push(name);
        }
      }
      return branchData;
    } catch (e: any) {
      return { branches: [], head: null, error: typeof e === 'string' ? e : e?.message };
    }
  }

  async getRemotes(repo: string): Promise<string[]> {
    try {
      const stdout = await execGit(['remote'], repo);
      return stdout.split(EOL_REGEX).filter(r => r.trim() !== '');
    } catch {
      return [];
    }
  }

  async getStashes(repo: string): Promise<GitStash[]> {
    try {
      const stdout = await execGit(['reflog', '--format=' + this.gitFormatStash, 'refs/stash', '--'], repo);
      const lines = stdout.split(EOL_REGEX);
      const stashes: GitStash[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].split(GIT_LOG_SEPARATOR);
        if (line.length !== 7 || line[1] === '') continue;
        const parentHashes = line[1].split(' ');
        stashes.push({
          hash: line[0],
          baseHash: parentHashes[0],
          untrackedFilesHash: parentHashes.length === 3 ? parentHashes[2] : null,
          selector: line[2],
          author: line[3],
          email: line[4],
          date: parseInt(line[5]),
          message: line[6]
        });
      }
      return stashes;
    } catch {
      return [];
    }
  }

  async getCommits(
    repo: string,
    branches: string[] | null,
    maxCommits: number,
    showTags: boolean,
    showRemoteBranches: boolean,
    includeCommitsMentionedByReflogs: boolean,
    onlyFollowFirstParent: boolean,
    commitOrdering: string,
    remotes: string[],
    hideRemotes: string[],
    stashes: GitStash[] = []
  ) {
    try {
      const [commits, refData] = await Promise.all([
        this.getLog(
          repo,
          branches,
          maxCommits + 1,
          showTags,
          showRemoteBranches,
          includeCommitsMentionedByReflogs,
          onlyFollowFirstParent,
          commitOrdering,
          remotes,
          hideRemotes,
          stashes
        ),
        this.getRefs(repo, showRemoteBranches, false, hideRemotes)
      ]);

      const moreCommitsAvailable = commits.length === maxCommits + 1;
      if (moreCommitsAvailable) commits.pop();

      if (refData.head !== null) {
        for (let i = 0; i < commits.length; i++) {
          if (refData.head === commits[i].hash) {
            const numUncommitted = await this.getUncommittedChanges(repo);
            if (numUncommitted > 0) {
              commits.unshift({
                hash: UNCOMMITTED,
                parents: [refData.head],
                author: '*',
                email: '',
                date: Math.round(Date.now() / 1000),
                message: `Uncommitted Changes (${numUncommitted})`
              });
            }
            break;
          }
        }
      }

      const commitNodes: GitCommitNode[] = [];
      const commitLookup: Record<string, number> = {};
      for (let i = 0; i < commits.length; i++) {
        commitLookup[commits[i].hash] = i;
        commitNodes.push({
          ...commits[i],
          heads: [],
          tags: [],
          remotes: [],
          stash: null
        });
      }

      const toAdd: { index: number; data: GitStash }[] = [];
      for (let i = 0; i < stashes.length; i++) {
        if (typeof commitLookup[stashes[i].hash] === 'number') {
          commitNodes[commitLookup[stashes[i].hash]].stash = {
            selector: stashes[i].selector,
            baseHash: stashes[i].baseHash,
            untrackedFilesHash: stashes[i].untrackedFilesHash
          };
        } else if (typeof commitLookup[stashes[i].baseHash] === 'number') {
          toAdd.push({ index: commitLookup[stashes[i].baseHash], data: stashes[i] });
        }
      }

      toAdd.sort((a, b) => (a.index !== b.index ? a.index - b.index : b.data.date - a.data.date));
      for (let i = toAdd.length - 1; i >= 0; i--) {
        const stash = toAdd[i].data;
        commitNodes.splice(toAdd[i].index, 0, {
          hash: stash.hash,
          parents: [stash.baseHash],
          author: stash.author,
          email: stash.email,
          date: stash.date,
          message: stash.message,
          heads: [],
          tags: [],
          remotes: [],
          stash: {
            selector: stash.selector,
            baseHash: stash.baseHash,
            untrackedFilesHash: stash.untrackedFilesHash
          }
        });
      }

      for (let i = 0; i < commitNodes.length; i++) {
        commitLookup[commitNodes[i].hash] = i;
      }

      for (let i = 0; i < refData.heads.length; i++) {
        if (typeof commitLookup[refData.heads[i].hash] === 'number') {
          commitNodes[commitLookup[refData.heads[i].hash]].heads.push(refData.heads[i].name);
        }
      }

      if (showTags) {
        for (let i = 0; i < refData.tags.length; i++) {
          if (typeof commitLookup[refData.tags[i].hash] === 'number') {
            commitNodes[commitLookup[refData.tags[i].hash]].tags.push({
              name: refData.tags[i].name,
              annotated: refData.tags[i].annotated
            });
          }
        }
      }

      for (let i = 0; i < refData.remotes.length; i++) {
        if (typeof commitLookup[refData.remotes[i].hash] === 'number') {
          const name = refData.remotes[i].name;
          const remote = remotes.find(r => name.startsWith(r + '/')) || null;
          commitNodes[commitLookup[refData.remotes[i].hash]].remotes.push({
            name,
            remote
          });
        }
      }

      return {
        commits: commitNodes,
        head: refData.head,
        tags: Array.from(new Set(refData.tags.map(t => t.name))),
        moreCommitsAvailable,
        error: null
      };
    } catch (e: any) {
      return {
        commits: [],
        head: null,
        tags: [],
        moreCommitsAvailable: false,
        error: typeof e === 'string' ? e : e?.message || 'Error loading commits'
      };
    }
  }

  async getLog(
    repo: string,
    branches: string[] | null,
    num: number,
    includeTags: boolean,
    includeRemotes: boolean,
    includeCommitsMentionedByReflogs: boolean,
    onlyFollowFirstParent: boolean,
    order: string,
    remotes: string[],
    hideRemotes: string[],
    stashes: GitStash[]
  ) {
    const safeOrder = order === 'author-date' ? 'author-date' : order === 'topo' ? 'topo' : 'date';
    const args = ['-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + this.gitFormatLog, '--' + safeOrder + '-order'];
    if (onlyFollowFirstParent) {
      args.push('--first-parent');
    }
    if (branches !== null && branches.length > 0) {
      for (const b of branches) args.push(b);
    } else {
      args.push('--branches');
      if (includeTags) args.push('--tags');
      if (includeCommitsMentionedByReflogs) args.push('--reflog');
      if (includeRemotes) {
        if (hideRemotes.length === 0) {
          args.push('--remotes');
        } else {
          remotes.filter(r => !hideRemotes.includes(r)).forEach(r => args.push('--glob=refs/remotes/' + r));
        }
      }
      const stashBaseHashes = Array.from(new Set(stashes.map(s => s.baseHash)));
      for (const h of stashBaseHashes) args.push(h);
      args.push('HEAD');
    }
    args.push('--');

    try {
      const stdout = await execGit(args, repo);
      const lines = stdout.split(EOL_REGEX);
      const commits: { hash: string; parents: string[]; author: string; email: string; date: number; message: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].split(GIT_LOG_SEPARATOR);
        if (line.length !== 6) continue;
        commits.push({
          hash: line[0],
          parents: line[1] !== '' ? line[1].split(' ') : [],
          author: line[2],
          email: line[3],
          date: parseInt(line[4]),
          message: line[5]
        });
      }
      return commits;
    } catch {
      return [];
    }
  }

  async getRefs(repo: string, showRemoteBranches: boolean, showRemoteHeads: boolean, hideRemotes: string[]) {
    const args = ['show-ref'];
    if (!showRemoteBranches) args.push('--heads', '--tags');
    args.push('-d', '--head');
    const hideRemotePatterns = hideRemotes.map(r => 'refs/remotes/' + r + '/');

    try {
      const stdout = await execGit(args, repo);
      const refData: {
        head: string | null;
        heads: { hash: string; name: string }[];
        tags: { hash: string; name: string; annotated: boolean }[];
        remotes: { hash: string; name: string }[];
      } = { head: null, heads: [], tags: [], remotes: [] };

      const lines = stdout.split(EOL_REGEX);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].split(' ');
        if (line.length < 2) continue;
        const hash = line.shift()!;
        const ref = line.join(' ');
        if (ref.startsWith('refs/heads/')) {
          refData.heads.push({ hash, name: ref.substring(11) });
        } else if (ref.startsWith('refs/tags/')) {
          const annotated = ref.endsWith('^{}');
          refData.tags.push({
            hash,
            name: annotated ? ref.substring(10, ref.length - 3) : ref.substring(10),
            annotated
          });
        } else if (ref.startsWith('refs/remotes/')) {
          if (!hideRemotePatterns.some(p => ref.startsWith(p)) && (showRemoteHeads || !ref.endsWith('/HEAD'))) {
            refData.remotes.push({ hash, name: ref.substring(13) });
          }
        } else if (ref === 'HEAD') {
          refData.head = hash;
        }
      }
      return refData;
    } catch {
      return { head: null, heads: [], tags: [], remotes: [] };
    }
  }

  async getUncommittedChanges(repo: string): Promise<number> {
    try {
      const stdout = await execGit(['status', '--untracked-files=all', '--porcelain'], repo);
      const lines = stdout.split(EOL_REGEX).filter(l => l.trim() !== '');
      return lines.length;
    } catch {
      return 0;
    }
  }

  async getCommitDetails(repo: string, commitHash: string, hasParents: boolean) {
    try {
      const fromCommit = commitHash + (hasParents ? '^' : '');
      const [base, nameStatus, numStat] = await Promise.all([
        this.getCommitDetailsBase(repo, commitHash),
        this.getDiffNameStatus(repo, fromCommit, commitHash),
        this.getDiffNumStat(repo, fromCommit, commitHash)
      ]);
      base.fileChanges = generateFileChanges(nameStatus, numStat, null);
      return { commitDetails: base, error: null };
    } catch (e: any) {
      return { commitDetails: null, error: typeof e === 'string' ? e : e?.message };
    }
  }

  async getStashDetails(repo: string, commitHash: string, stash: any) {
    try {
      const [base, nameStatus, numStat, untrackedNameStatus, untrackedNumStat] = await Promise.all([
        this.getCommitDetailsBase(repo, commitHash),
        this.getDiffNameStatus(repo, stash.baseHash, commitHash),
        this.getDiffNumStat(repo, stash.baseHash, commitHash),
        stash.untrackedFilesHash !== null
          ? this.getDiffNameStatus(repo, stash.untrackedFilesHash, stash.untrackedFilesHash)
          : Promise.resolve([]),
        stash.untrackedFilesHash !== null
          ? this.getDiffNumStat(repo, stash.untrackedFilesHash, stash.untrackedFilesHash)
          : Promise.resolve([])
      ]);
      base.fileChanges = generateFileChanges(nameStatus, numStat, null);
      if (stash.untrackedFilesHash !== null) {
        generateFileChanges(untrackedNameStatus, untrackedNumStat, null).forEach(fc => {
          if (fc.type === 'A') {
            fc.type = 'U';
            base.fileChanges.push(fc);
          }
        });
      }
      return { commitDetails: base, error: null };
    } catch (e: any) {
      return { commitDetails: null, error: typeof e === 'string' ? e : e?.message };
    }
  }

  async getUncommittedDetails(repo: string) {
    try {
      const [nameStatus, numStat, status] = await Promise.all([
        this.getDiffNameStatus(repo, 'HEAD', ''),
        this.getDiffNumStat(repo, 'HEAD', ''),
        this.getStatus(repo)
      ]);
      return {
        commitDetails: {
          hash: UNCOMMITTED,
          parents: [],
          author: '',
          authorEmail: '',
          authorDate: 0,
          committer: '',
          committerEmail: '',
          committerDate: 0,
          signature: null,
          body: '',
          fileChanges: generateFileChanges(nameStatus, numStat, status)
        },
        error: null
      };
    } catch (e: any) {
      return { commitDetails: null, error: typeof e === 'string' ? e : e?.message };
    }
  }

  async getCommitComparison(repo: string, fromHash: string, toHash: string) {
    try {
      const targetHash = toHash === UNCOMMITTED ? '' : toHash;
      const [nameStatus, numStat, status] = await Promise.all([
        this.getDiffNameStatus(repo, fromHash, targetHash),
        this.getDiffNumStat(repo, fromHash, targetHash),
        toHash === UNCOMMITTED ? this.getStatus(repo) : Promise.resolve(null)
      ]);
      return {
        fileChanges: generateFileChanges(nameStatus, numStat, status),
        error: null
      };
    } catch (e: any) {
      return { fileChanges: [], error: typeof e === 'string' ? e : e?.message };
    }
  }

  async getCommitDetailsBase(repo: string, commitHash: string): Promise<GitCommitDetails> {
    const stdout = await execGit(
      ['-c', 'log.showSignature=false', 'show', '--quiet', commitHash, '--format=' + this.gitFormatCommitDetails],
      repo
    );
    const commitInfo = stdout.split(GIT_LOG_SEPARATOR);
    const sigStatus = commitInfo[8];
    return {
      hash: commitInfo[0],
      parents: commitInfo[1] !== '' ? commitInfo[1].split(' ') : [],
      author: commitInfo[2],
      authorEmail: commitInfo[3],
      authorDate: parseInt(commitInfo[4]),
      committer: commitInfo[5],
      committerEmail: commitInfo[6],
      committerDate: parseInt(commitInfo[7]),
      signature: ['G', 'U', 'X', 'Y', 'R', 'E', 'B'].includes(sigStatus)
        ? {
            status: sigStatus,
            signer: (commitInfo[9] || '').trim(),
            key: (commitInfo[10] || '').trim()
          }
        : null,
      body: commitInfo.slice(11).join(GIT_LOG_SEPARATOR).trimEnd(),
      fileChanges: []
    };
  }

  async execDiff(repo: string, fromHash: string, toHash: string, arg: string, filter = 'AMDR'): Promise<string[]> {
    let args: string[];
    if (fromHash === toHash) {
      args = ['diff-tree', arg, '-r', '--root', '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
    } else {
      args = ['diff', arg, '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
      if (toHash !== '') args.push(toHash);
    }
    const stdout = await execGit(args, repo);
    const lines = stdout.split('\0');
    if (fromHash === toHash) {
      lines.shift();
    }
    return lines;
  }

  async getDiffNameStatus(repo: string, fromHash: string, toHash: string, filter = 'AMDR') {
    const output = await this.execDiff(repo, fromHash, toHash, '--name-status', filter);
    const records: { type: string; oldFilePath: string; newFilePath: string }[] = [];
    let i = 0;
    while (i < output.length && output[i] !== '') {
      const type = output[i][0];
      if (type === 'A' || type === 'D' || type === 'M') {
        const p = output[i + 1]?.replace(/\\/g, '/');
        if (p) records.push({ type, oldFilePath: p, newFilePath: p });
        i += 2;
      } else if (type === 'R') {
        const oldP = output[i + 1]?.replace(/\\/g, '/');
        const newP = output[i + 2]?.replace(/\\/g, '/');
        if (oldP && newP) records.push({ type, oldFilePath: oldP, newFilePath: newP });
        i += 3;
      } else {
        break;
      }
    }
    return records;
  }

  async getDiffNumStat(repo: string, fromHash: string, toHash: string, filter = 'AMDR') {
    const output = await this.execDiff(repo, fromHash, toHash, '--numstat', filter);
    const records: { filePath: string; additions: number; deletions: number }[] = [];
    let i = 0;
    while (i < output.length && output[i] !== '') {
      const fields = output[i].split('\t');
      if (fields.length !== 3) break;
      if (fields[2] !== '') {
        records.push({
          filePath: fields[2].replace(/\\/g, '/'),
          additions: parseInt(fields[0]) || 0,
          deletions: parseInt(fields[1]) || 0
        });
        i += 1;
      } else {
        const filePath = output[i + 2]?.replace(/\\/g, '/');
        if (filePath) {
          records.push({
            filePath,
            additions: parseInt(fields[0]) || 0,
            deletions: parseInt(fields[1]) || 0
          });
        }
        i += 3;
      }
    }
    return records;
  }

  async getStatus(repo: string) {
    try {
      const stdout = await execGit(['status', '-s', '--untracked-files=all', '--porcelain', '-z'], repo);
      const output = stdout.split('\0');
      let i = 0;
      const status: { deleted: string[]; untracked: string[] } = { deleted: [], untracked: [] };
      while (i < output.length && output[i] !== '') {
        if (output[i].length < 4) break;
        const p = output[i].substring(3).replace(/\\/g, '/');
        const c1 = output[i][0];
        const c2 = output[i][1];
        if (c1 === 'D' || c2 === 'D') status.deleted.push(p);
        else if (c1 === '?' || c2 === '?') status.untracked.push(p);

        if (c1 === 'R' || c2 === 'R' || c1 === 'C' || c2 === 'C') {
          i += 2;
        } else {
          i += 1;
        }
      }
      return status;
    } catch {
      return { deleted: [], untracked: [] };
    }
  }

  async getConfig(repo: string, remotes: string[] = []) {
    try {
      const [consolidated, local, global] = await Promise.all([
        this.getConfigList(repo),
        this.getConfigList(repo, 'local'),
        this.getConfigList(repo, 'global')
      ]);

      const branches: Record<string, { pushRemote: string | null; remote: string | null }> = {};
      for (const key of Object.keys(local)) {
        if (key.startsWith('branch.')) {
          if (key.endsWith('.remote')) {
            const branchName = key.substring(7, key.length - 7);
            branches[branchName] = {
              pushRemote: branches[branchName]?.pushRemote ?? null,
              remote: local[key]
            };
          } else if (key.endsWith('.pushremote')) {
            const branchName = key.substring(7, key.length - 11);
            branches[branchName] = {
              pushRemote: local[key],
              remote: branches[branchName]?.remote ?? null
            };
          }
        }
      }

      return {
        config: {
          branches,
          diffTool: consolidated['diff.tool'] || null,
          guiDiffTool: consolidated['diff.guitool'] || null,
          pushDefault: consolidated['remote.pushdefault'] || null,
          remotes: remotes.map(remote => ({
            name: remote,
            url: consolidated['remote.' + remote + '.url'] || local['remote.' + remote + '.url'] || null,
            pushUrl: consolidated['remote.' + remote + '.pushurl'] || local['remote.' + remote + '.pushurl'] || null
          })),
          user: {
            name: {
              local: local['user.name'] || null,
              global: global['user.name'] || null
            },
            email: {
              local: local['user.email'] || null,
              global: global['user.email'] || null
            }
          }
        },
        error: null
      };
    } catch (e: any) {
      return { config: null, error: typeof e === 'string' ? e : e?.message };
    }
  }

  async getConfigList(repo: string, location?: 'local' | 'global'): Promise<Record<string, string>> {
    const args = ['--no-pager', 'config', '--list', '-z', '--includes'];
    if (location) args.push('--' + location);
    try {
      const stdout = await execGit(args, repo);
      const configs: Record<string, string> = {};
      const keyValuePairs = stdout.split('\0');
      for (let i = 0; i < keyValuePairs.length - 1; i++) {
        const comps = keyValuePairs[i].split(EOL_REGEX);
        if (comps.length > 1) {
          configs[comps[0]] = comps.slice(1).join('\n');
        }
      }
      return configs;
    } catch {
      return {};
    }
  }

  async getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
    try {
      const out = await execGit(['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', commitHash, '--'], repo);
      return out.trim().replace(/\s+/g, ' ');
    } catch {
      return null;
    }
  }

  async getTagDetails(repo: string, tagName: string) {
    try {
      const stdout = await execGit(
        ['for-each-ref', 'refs/tags/' + tagName, '--format=' + ['%(objectname)', '%(taggername)', '%(taggeremail)', '%(taggerdate:unix)', '%(contents)'].join(GIT_LOG_SEPARATOR)],
        repo
      );
      const data = stdout.split(GIT_LOG_SEPARATOR);
      return {
        tagHash: data[0],
        name: data[1],
        email: data[2].replace(/^<|>$/g, ''),
        date: parseInt(data[3]),
        message: data.slice(4).join(GIT_LOG_SEPARATOR).trimEnd(),
        error: null
      };
    } catch (e: any) {
      return { tagHash: '', name: '', email: '', date: 0, message: '', error: typeof e === 'string' ? e : e?.message };
    }
  }

  async runGitCommand(args: string[], repo: string): Promise<string | null> {
    return new Promise((resolve) => {
      cp.execFile('git', args, { cwd: repo, env: GIT_ENV, maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const out = (stderr || stdout || err.message || '').toString().trim();
          resolve(out || 'Git command failed');
        } else {
          resolve(null);
        }
      });
    });
  }

  async areStagedChanges(repo: string): Promise<boolean> {
    try {
      const stdout = await execGit(['diff-index', '--cached', 'HEAD'], repo);
      return stdout.trim() !== '';
    } catch {
      try {
        const stdout = await execGit(['diff', '--cached', '--name-only'], repo);
        return stdout.trim() !== '';
      } catch {
        return false;
      }
    }
  }

  async unsetGitConfig(repo: string, location: 'global' | 'local', key: string): Promise<string | null> {
    return new Promise((resolve) => {
      cp.execFile('git', ['config', '--' + location, '--unset', key], { cwd: repo, env: GIT_ENV }, (err, stdout, stderr) => {
        if (err) {
          if ((err as any).code === 5 || (err as any).status === 5) {
            resolve(null);
            return;
          }
          const out = (stderr || stdout || err.message || '').toString().trim();
          resolve(out || 'Git config unset failed');
        } else {
          resolve(null);
        }
      });
    });
  }

  async commitSquashIfStagedChangesExist(
    repo: string,
    obj: string,
    actionOn: string,
    squashMessageFormat = 0,
    signCommits = false
  ): Promise<string | null> {
    const changes = await this.areStagedChanges(repo);
    if (changes) {
      const args = ['commit'];
      if (signCommits) {
        args.push('-S');
      }
      if (squashMessageFormat === 0) {
        args.push('-m', `Merge ${actionOn.toLowerCase()} '${obj}'`);
      } else {
        args.push('--no-edit');
      }
      return this.runGitCommand(args, repo);
    }
    return null;
  }

  // 1. Branch operations
  async checkoutBranch(repo: string, branchName: string, remoteBranch: string | null): Promise<string | null> {
    const val = validateRefName(branchName, 'Branch');
    if (val) return val;
    const args = ['checkout'];
    if (remoteBranch === null) {
      args.push(branchName);
    } else {
      args.push('-b', branchName, remoteBranch);
    }
    return this.runGitCommand(args, repo);
  }

  async checkoutCommit(repo: string, commitHash: string): Promise<string | null> {
    if (!commitHash || commitHash.startsWith('-')) {
      return 'Invalid commit hash';
    }
    return this.runGitCommand(['checkout', commitHash], repo);
  }

  async createBranch(
    repo: string,
    branchName: string,
    commitHash: string,
    checkout: boolean,
    force: boolean
  ): Promise<(string | null)[]> {
    const val = validateRefName(branchName, 'Branch');
    if (val) return [val];
    const args: string[] = [];
    if (checkout && !force) {
      args.push('checkout', '-b');
    } else {
      args.push('branch');
      if (force) {
        args.push('-f');
      }
    }
    args.push(branchName, commitHash);
    const statuses: (string | null)[] = [await this.runGitCommand(args, repo)];
    if (statuses[0] === null && checkout && force) {
      statuses.push(await this.checkoutBranch(repo, branchName, null));
    }
    return statuses;
  }

  async deleteBranch(repo: string, branchName: string, forceDelete: boolean): Promise<string | null> {
    const val = validateRefName(branchName, 'Branch');
    if (val) return val;
    const args = ['branch', '--delete'];
    if (forceDelete) {
      args.push('--force');
    }
    args.push(branchName);
    return this.runGitCommand(args, repo);
  }

  async deleteRemoteBranch(repo: string, branchName: string, remote: string): Promise<string | null> {
    const val = validateRefName(branchName, 'Branch');
    if (val) return val;
    const remoteStatus = await this.runGitCommand(['push', remote, '--delete', branchName], repo);
    if (remoteStatus !== null && /remote ref does not exist/i.test(remoteStatus)) {
      const trackingBranchStatus = await this.runGitCommand(['branch', '-d', '-r', `${remote}/${branchName}`], repo);
      return trackingBranchStatus === null
        ? null
        : `Branch does not exist on the remote, deleting the remote tracking branch ${remote}/${branchName}.\n${trackingBranchStatus}`;
    }
    return remoteStatus;
  }

  async renameBranch(repo: string, oldName: string, newName: string): Promise<string | null> {
    const val1 = validateRefName(oldName, 'Branch');
    if (val1) return val1;
    const val2 = validateRefName(newName, 'Branch');
    if (val2) return val2;
    return this.runGitCommand(['branch', '-m', oldName, newName], repo);
  }

  async fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean): Promise<string | null> {
    const args = ['fetch', remote === null ? '--all' : remote];
    if (prune) {
      args.push('--prune');
    }
    if (pruneTags) {
      if (!prune) {
        return 'In order to Prune Tags, pruning must also be enabled when fetching from ' + (remote !== null ? 'a remote' : 'remote(s)') + '.';
      }
      args.push('--prune-tags');
    }
    return this.runGitCommand(args, repo);
  }

  async fetchIntoLocalBranch(
    repo: string,
    remote: string,
    remoteBranch: string,
    localBranch: string,
    force: boolean
  ): Promise<string | null> {
    const val = validateRefName(localBranch, 'Branch');
    if (val) return val;
    const args = ['fetch'];
    if (force) {
      args.push('-f');
    }
    args.push(remote, `${remoteBranch}:${localBranch}`);
    return this.runGitCommand(args, repo);
  }

  async pullBranch(
    repo: string,
    branchName: string,
    remote: string,
    createNewCommit: boolean,
    squash: boolean
  ): Promise<string | null> {
    const args = ['pull', remote, branchName];
    if (squash) {
      args.push('--squash');
    } else if (createNewCommit) {
      args.push('--no-ff');
    }
    const pullStatus = await this.runGitCommand(args, repo);
    return pullStatus === null && squash
      ? this.commitSquashIfStagedChangesExist(repo, `${remote}/${branchName}`, 'Branch')
      : pullStatus;
  }

  async pushBranch(
    repo: string,
    branchName: string,
    remote: string,
    setUpstream: boolean,
    mode: string
  ): Promise<string | null> {
    const val = validateRefName(branchName, 'Branch');
    if (val) return val;
    const args = ['push', remote, branchName];
    if (setUpstream) {
      args.push('--set-upstream');
    }
    if (mode && mode !== '') {
      args.push('--' + mode);
    }
    return this.runGitCommand(args, repo);
  }

  async pushBranchToMultipleRemotes(
    repo: string,
    branchName: string,
    remotes: string[],
    setUpstream: boolean,
    mode: string
  ): Promise<(string | null)[]> {
    if (!remotes || remotes.length === 0) {
      return ['No remote(s) were specified to push the branch ' + branchName + ' to.'];
    }
    const results: (string | null)[] = [];
    for (let i = 0; i < remotes.length; i++) {
      const result = await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode);
      results.push(result);
      if (result !== null) break;
    }
    return results;
  }

  // 2. Tag operations
  async addTag(
    repo: string,
    tagName: string,
    commitHash: string,
    type: number,
    message: string,
    force: boolean
  ): Promise<string | null> {
    const val = validateRefName(tagName, 'Tag');
    if (val) return val;
    const args = ['tag'];
    if (force) {
      args.push('-f');
    }
    if (type === 1) {
      args.push(tagName);
    } else {
      args.push('-a', tagName, '-m', message || '');
    }
    args.push(commitHash);
    return this.runGitCommand(args, repo);
  }

  async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null): Promise<string | null> {
    const val = validateRefName(tagName, 'Tag');
    if (val) return val;
    if (deleteOnRemote !== null && deleteOnRemote !== undefined) {
      const status = await this.runGitCommand(['push', deleteOnRemote, '--delete', tagName], repo);
      if (status !== null) return status;
    }
    return this.runGitCommand(['tag', '-d', tagName], repo);
  }

  async pushTag(repo: string, tagName: string, remote: string): Promise<string | null> {
    const val = validateRefName(tagName, 'Tag');
    if (val) return val;
    return this.runGitCommand(['push', remote, tagName], repo);
  }

  async pushTagToMultipleRemotes(repo: string, tagName: string, remotes: string[]): Promise<(string | null)[]> {
    if (!remotes || remotes.length === 0) {
      return ['No remote(s) were specified to push the tag ' + tagName + ' to.'];
    }
    const results: (string | null)[] = [];
    for (let i = 0; i < remotes.length; i++) {
      const result = await this.pushTag(repo, tagName, remotes[i]);
      results.push(result);
      if (result !== null) break;
    }
    return results;
  }

  // 3. Commit operations
  async cherrypickCommit(
    repo: string,
    commitHash: string,
    parentIndex: number,
    recordOrigin: boolean,
    noCommit: boolean
  ): Promise<string | null> {
    const args = ['cherry-pick'];
    if (noCommit) {
      args.push('--no-commit');
    }
    if (recordOrigin) {
      args.push('-x');
    }
    if (parentIndex > 0) {
      args.push('-m', parentIndex.toString());
    }
    args.push(commitHash);
    return this.runGitCommand(args, repo);
  }

  async revertCommit(repo: string, commitHash: string, parentIndex: number): Promise<string | null> {
    const args = ['revert', '--no-edit'];
    if (parentIndex > 0) {
      args.push('-m', parentIndex.toString());
    }
    args.push(commitHash);
    return this.runGitCommand(args, repo);
  }

  async resetToCommit(repo: string, commit: string, resetMode: string): Promise<string | null> {
    return this.runGitCommand(['reset', '--' + resetMode, commit], repo);
  }

  async dropCommit(repo: string, commitHash: string): Promise<string | null> {
    return this.runGitCommand(['rebase', '--onto', commitHash + '^', commitHash], repo);
  }

  async merge(
    repo: string,
    obj: string,
    actionOn: string,
    createNewCommit: boolean,
    squash: boolean,
    noCommit: boolean
  ): Promise<string | null> {
    const args = ['merge', obj];
    if (squash) {
      args.push('--squash');
    } else if (createNewCommit) {
      args.push('--no-ff');
    }
    if (noCommit) {
      args.push('--no-commit');
    }
    const mergeStatus = await this.runGitCommand(args, repo);
    return mergeStatus === null && squash && !noCommit
      ? this.commitSquashIfStagedChangesExist(repo, obj, actionOn)
      : mergeStatus;
  }

  async rebase(
    repo: string,
    obj: string,
    actionOn: string,
    ignoreDate: boolean,
    interactive: boolean
  ): Promise<string | null> {
    if (interactive) {
      return 'Interactive rebase is not supported in non-interactive environment.';
    }
    const args = ['rebase', obj];
    if (ignoreDate) {
      args.push('--ignore-date');
    }
    return this.runGitCommand(args, repo);
  }

  // 4. Stash operations & uncommitted
  async pushStash(repo: string, message: string, includeUntracked: boolean): Promise<string | null> {
    const args = ['stash', 'push'];
    if (includeUntracked) {
      args.push('--include-untracked');
    }
    if (message && message !== '') {
      args.push('--message', message);
    }
    return this.runGitCommand(args, repo);
  }

  async applyStash(repo: string, selector: string, reinstateIndex: boolean): Promise<string | null> {
    const args = ['stash', 'apply'];
    if (reinstateIndex) {
      args.push('--index');
    }
    args.push(selector);
    return this.runGitCommand(args, repo);
  }

  async popStash(repo: string, selector: string, reinstateIndex: boolean): Promise<string | null> {
    const args = ['stash', 'pop'];
    if (reinstateIndex) {
      args.push('--index');
    }
    args.push(selector);
    return this.runGitCommand(args, repo);
  }

  async dropStash(repo: string, selector: string): Promise<string | null> {
    return this.runGitCommand(['stash', 'drop', selector], repo);
  }

  async branchFromStash(repo: string, selector: string, branchName: string): Promise<string | null> {
    const val = validateRefName(branchName, 'Branch');
    if (val) return val;
    return this.runGitCommand(['stash', 'branch', branchName, selector], repo);
  }

  async cleanUntrackedFiles(repo: string, directories: boolean): Promise<string | null> {
    return this.runGitCommand(['clean', '-f' + (directories ? 'd' : '')], repo);
  }

  async resetUncommitted(repo: string, mode: 'mixed' | 'hard' = 'mixed'): Promise<string | null> {
    return this.resetToCommit(repo, 'HEAD', mode);
  }

  // Remotes
  async addRemote(
    repo: string,
    name: string,
    url: string,
    pushUrl: string | null,
    fetch: boolean
  ): Promise<string | null> {
    const val = validateRefName(name, 'Remote');
    if (val) return val;
    const addStatus = await this.runGitCommand(['remote', 'add', name, url], repo);
    if (addStatus !== null) return addStatus;
    if (pushUrl) {
      const pushUrlStatus = await this.runGitCommand(['remote', 'set-url', '--push', name, pushUrl], repo);
      if (pushUrlStatus !== null) return pushUrlStatus;
    }
    if (fetch) {
      return this.fetch(repo, name, false, false);
    }
    return null;
  }

  async deleteRemote(repo: string, name: string): Promise<string | null> {
    return this.runGitCommand(['remote', 'remove', name], repo);
  }

  async editRemote(
    repo: string,
    nameOld: string,
    nameNew: string,
    urlOld: string | null,
    urlNew: string | null,
    pushUrlOld: string | null,
    pushUrlNew: string | null
  ): Promise<string | null> {
    const valNew = validateRefName(nameNew, 'Remote');
    if (valNew) return valNew;
    if (!nameOld || typeof nameOld !== 'string' || nameOld.trim() === '') {
      return 'Remote name cannot be empty';
    }

    if (nameOld !== nameNew) {
      const renameStatus = await this.runGitCommand(['remote', 'rename', nameOld, nameNew], repo);
      if (renameStatus !== null) return renameStatus;
    }

    if (urlOld !== urlNew) {
      if (urlNew !== null) {
        const status = await this.runGitCommand(['remote', 'set-url', nameNew, urlNew], repo);
        if (status !== null) return status;
      } else if (urlOld !== null) {
        const status = await this.runGitCommand(['remote', 'set-url', '--delete', nameNew, urlOld], repo);
        if (status !== null) return status;
      }
    }

    if (pushUrlOld !== pushUrlNew) {
      if (pushUrlOld === null && pushUrlNew !== null) {
        const status = await this.runGitCommand(['remote', 'set-url', '--push', '--add', nameNew, pushUrlNew], repo);
        if (status !== null) return status;
      } else if (pushUrlOld !== null && pushUrlNew !== null) {
        const status = await this.runGitCommand(['remote', 'set-url', '--push', nameNew, pushUrlNew], repo);
        if (status !== null) return status;
      } else if (pushUrlOld !== null && pushUrlNew === null) {
        let status = await this.runGitCommand(['remote', 'set-url', '--push', '--delete', nameNew, pushUrlOld], repo);
        if (status !== null) {
          status = await this.runGitCommand(['config', '--unset-all', `remote.${nameNew}.pushurl`], repo);
        }
        if (status !== null) return status;
      }
    }

    return null;
  }

  async pruneRemote(repo: string, name: string): Promise<string | null> {
    return this.runGitCommand(['remote', 'prune', name], repo);
  }

  // User details
  async editUserDetails(
    repo: string,
    name: string,
    email: string,
    location: 'global' | 'local',
    deleteLocalName: boolean,
    deleteLocalEmail: boolean
  ): Promise<(string | null)[]> {
    const errors: (string | null)[] = [];
    errors.push(await this.runGitCommand(['config', '--' + location, 'user.name', name], repo));
    errors.push(await this.runGitCommand(['config', '--' + location, 'user.email', email], repo));
    if (deleteLocalName) {
      errors.push(await this.unsetGitConfig(repo, 'local', 'user.name'));
    }
    if (deleteLocalEmail) {
      errors.push(await this.unsetGitConfig(repo, 'local', 'user.email'));
    }
    return errors;
  }

  async deleteUserDetails(
    repo: string,
    name: boolean,
    email: boolean,
    location: 'global' | 'local'
  ): Promise<(string | null)[]> {
    const errors: (string | null)[] = [];
    if (name) {
      errors.push(await this.unsetGitConfig(repo, location, 'user.name'));
    }
    if (email) {
      errors.push(await this.unsetGitConfig(repo, location, 'user.email'));
    }
    if (errors.length === 0) {
      errors.push(null);
    }
    return errors;
  }
}

export function validateRefName(name: string, kind = 'Branch'): string | null {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return `${kind} name cannot be empty`;
  }
  if (name.startsWith('-')) {
    return `${kind} name cannot start with "-"`;
  }
  return null;
}

function generateFileChanges(
  nameStatusRecords: { type: string; oldFilePath: string; newFilePath: string }[],
  numStatRecords: { filePath: string; additions: number; deletions: number }[],
  status: { deleted: string[]; untracked: string[] } | null
): GitFileChange[] {
  const fileChanges: GitFileChange[] = [];
  const fileLookup: Record<string, number> = {};

  for (let i = 0; i < nameStatusRecords.length; i++) {
    fileLookup[nameStatusRecords[i].newFilePath] = fileChanges.length;
    fileChanges.push({
      oldFilePath: nameStatusRecords[i].oldFilePath,
      newFilePath: nameStatusRecords[i].newFilePath,
      type: nameStatusRecords[i].type,
      additions: null,
      deletions: null
    });
  }

  if (status !== null) {
    for (let i = 0; i < status.deleted.length; i++) {
      const filePath = status.deleted[i];
      if (typeof fileLookup[filePath] === 'number') {
        fileChanges[fileLookup[filePath]].type = 'D';
      } else {
        fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: 'D', additions: null, deletions: null });
      }
    }
    for (let i = 0; i < status.untracked.length; i++) {
      const filePath = status.untracked[i];
      fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: 'U', additions: null, deletions: null });
    }
  }

  for (let i = 0; i < numStatRecords.length; i++) {
    if (typeof fileLookup[numStatRecords[i].filePath] === 'number') {
      fileChanges[fileLookup[numStatRecords[i].filePath]].additions = numStatRecords[i].additions;
      fileChanges[fileLookup[numStatRecords[i].filePath]].deletions = numStatRecords[i].deletions;
    }
  }

  return fileChanges;
}
