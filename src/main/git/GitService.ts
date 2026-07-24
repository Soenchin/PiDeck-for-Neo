import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	GitBranchInfo,
	GitCommitSummary,
	GitCommitFile,
	GitRemoteSummary,
} from "../../shared/types";

const execFileAsync = promisify(execFile);

export class GitService {
	/**
	 * 判断给定目录是否处于一个 git 仓库内。
	 * 启用工作区模式前做前置校验，避免非 git 项目开启后只能看到空列表、
	 * 直到点击"新建工作区"才在 create 阶段报错。
	 */
	async isGitRepo(cwd: string): Promise<boolean> {
		try {
			await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
			return true;
		} catch {
			return false;
		}
	}

	async getBranches(cwd: string): Promise<GitBranchInfo> {
		try {
			// 获取当前分支和所有本地分支（不包含远程分支）
			const [{ stdout: currentRaw }, { stdout: localRaw }] = await Promise.all([
				execFileAsync("git", ["branch", "--show-current"], { cwd }),
				execFileAsync("git", ["branch", "--format=%(refname:short)"], { cwd }),
			]);

			const current = currentRaw.trim() || null;
			const branches = localRaw
				.split(/\r?\n/)
				.map((b) => b.trim())
				.filter(Boolean);

			// 当前分支排在最前
			const sorted = current
				? [current, ...branches.filter((b) => b !== current)]
				: branches;

			return { current, branches: sorted };
		} catch {
			// 非 Git 目录或未安装 git 时只返回空信息，UI 可以降级展示为 no git。
			return { current: null, branches: [] };
		}
	}

	async checkout(cwd: string, branch: string): Promise<GitBranchInfo> {
		try {
			await execFileAsync("git", ["checkout", branch], { cwd });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			// execFile 默认只输出 stdout；checkout 失败时 stderr 包含真正原因。
			throw new Error(`Git checkout "${branch}" failed: ${msg}`);
		}
		return this.getBranches(cwd);
	}

	/**
	 * 基于当前分支创建新分支并切换。
	 * 使用 checkout -b 命令在当前分支基础上创建新分支。
	 */
	async createBranch(cwd: string, branchName: string): Promise<GitBranchInfo> {
		await execFileAsync("git", ["checkout", "-b", branchName], { cwd });
		return this.getBranches(cwd);
	}

	/**
	 * 读取文件在 Git HEAD 中的原始内容，用于差异编辑器左侧基准列。
	 *
	 * 策略：通过 rev-parse 找到仓库根，用 node path.relative 计算 repoRoot→filePath 的相对路径，
	 * 再用 git -C repoRoot show HEAD:<relpath> 获取 HEAD 版本。
	 *
	 * 边界条件：
	 * - 文件不在任何 Git 仓库内（git 命令失败）→ 返回空字符串。
	 * - 文件是未跟踪的新增文件（HEAD 中不存在该路径）→ git show 报错，返回空字符串。
	 */
	async getOriginalContent(filePath: string): Promise<string> {
		try {
			const dir = dirname(filePath);
			const { stdout: rootRaw } = await execFileAsync(
				"git",
				["rev-parse", "--show-toplevel"],
				{ cwd: dir },
			);
			const repoRoot = rootRaw.trim();
			if (!repoRoot) return "";

			// 用 path.relative 计算相对路径，node 会自动处理跨平台分隔符
			const relPath = relative(repoRoot, filePath).replace(/\\/g, "/");
			if (!relPath || relPath.startsWith("..")) return "";

			const { stdout } = await execFileAsync(
				"git",
				["-C", repoRoot, "show", `HEAD:${relPath}`],
				{ maxBuffer: 32 * 1024 * 1024 },
			);
			return stdout;
		} catch {
			return "";
		}
	}

	/**
	 * 获取最近 maxCount 条 commit 摘要列表。
	 * 格式：hash | author | date | message
	 */
	async getCommits(cwd: string, maxCount = 50): Promise<GitCommitSummary[]> {
		try {
			const { stdout } = await execFileAsync(
				"git",
				[
					"log",
					`--max-count=${maxCount}`,
					"--format=%H%n%h%n%an%n%ai%n%s%n---END---",
				],
				{ cwd, maxBuffer: 4 * 1024 * 1024 },
			);
			const blocks = stdout.split("---END---\n");
			const commits: GitCommitSummary[] = [];
			for (const block of blocks) {
				const lines = block.trim().split(/\r?\n/);
				if (lines.length < 5) continue;
				commits.push({
					hash: lines[0],
					shortHash: lines[1],
					author: lines[2],
					date: lines[3],
					message: lines.slice(4).join("\n"),
				});
			}
			return commits;
		} catch {
			return [];
		}
	}

	/**
	 * 获取指定 commit 中变更的文件列表。
	 * 使用 --name-status -z 避免文件名解析问题。
	 */
	async getCommitFiles(cwd: string, hash: string): Promise<GitCommitFile[]> {
		try {
			const { stdout: repoRootRaw } = await execFileAsync(
				"git",
				["rev-parse", "--show-toplevel"],
				{ cwd },
			);
			const repoRoot = resolve(repoRootRaw.trim());
			const projectRoot = resolve(cwd);
			const { stdout } = await execFileAsync(
				"git",
				["show", "--name-status", "-z", "--format=", hash],
				{ cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 },
			);
			const files: GitCommitFile[] = [];
			const fields = stdout.split("\0");
			for (let i = 0; i < fields.length - 1; ) {
				const statusToken = fields[i++];
				if (!statusToken) continue;
				const statusChar = statusToken[0];
				const oldOrCurrentPath = fields[i++];
				const isRename = statusChar === "R" || statusChar === "C";
				const currentPath = isRename ? fields[i++] : oldOrCurrentPath;
				if (!currentPath) continue;
				// 嵌套项目只展示自己目录内的 commit 文件，和 getChangedFiles 同口径。
				const absolutePath = resolve(repoRoot, currentPath);
				const projectRelativePath = relative(projectRoot, absolutePath);
				if (
					projectRelativePath === ".." ||
					projectRelativePath.startsWith(`..${sep}`) ||
					isAbsolute(projectRelativePath)
				) {
					continue;
				}
				const status =
					statusChar === "A" ? "added"
						: statusChar === "D" ? "deleted"
							: statusChar === "R" ? "renamed"
								: "modified";
				// path 返回绝对路径，与 getChangedFiles 一致，方便前端直接喂给 FileDiffViewer。
				// relativePath / oldPath 保留仓库相对路径，供 git show 使用。
				files.push({
					path: absolutePath,
					relativePath: currentPath,
					status,
					oldPath: isRename ? oldOrCurrentPath : undefined,
				});
			}
			return files;
		} catch {
			return [];
		}
	}

	/**
	 * 获取指定 commit 中某个文件在 old（commit^）或 new（commit）侧的内容。
	 * side: "old" 为 commit^ 版本，"new" 为 commit 版本。
	 */
	async getCommitFileContent(
		cwd: string,
		hash: string,
		filePath: string,
		side: "old" | "new",
	): Promise<string> {
		try {
			// filePath 为仓库根相对路径；在 repo root 上执行 show，避免嵌套 cwd 解析偏差。
			const { stdout: repoRootRaw } = await execFileAsync(
				"git",
				["rev-parse", "--show-toplevel"],
				{ cwd },
			);
			const repoRoot = resolve(repoRootRaw.trim());
			const normalizedPath = filePath.replace(/\\/g, "/");
			const ref =
				side === "old"
					? `${hash}^:${normalizedPath}`
					: `${hash}:${normalizedPath}`;
			const { stdout } = await execFileAsync(
				"git",
				["show", ref],
				{ cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
			);
			return stdout;
		} catch {
			return "";
		}
	}

	/**
	 * 获取本地分支与 upstream 的 ahead/behind 信息。
	 * 返回 null 表示没有 upstream 或不是 git 仓库。
	 */
	async getRemoteSummary(cwd: string): Promise<GitRemoteSummary | null> {
		try {
			const [
				{ stdout: remoteRaw },
				{ stdout: aheadRaw },
				{ stdout: behindRaw },
			] = await Promise.all([
				execFileAsync(
					"git",
					["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
					{ cwd },
				),
				execFileAsync(
					"git",
					["rev-list", "--count", "HEAD", "--not", "@{u}"],
					{ cwd },
				),
				execFileAsync(
					"git",
					["rev-list", "--count", "@{u}", "--not", "HEAD"],
					{ cwd },
				),
			]);

			const trackingBranch = remoteRaw.trim();
			const remote = trackingBranch.split("/")[0];
			const ahead = Number(aheadRaw.trim()) || 0;
			const behind = Number(behindRaw.trim()) || 0;

			// 尝试读取远端最新 commit hash
			let remoteHeadHash: string | undefined;
			try {
				const { stdout } = await execFileAsync(
					"git",
					["rev-parse", "@{u}"],
					{ cwd },
				);
				remoteHeadHash = stdout.trim() || undefined;
			} catch {
				// 无远端 commit 时不报错
			}

			return {
				remote,
				trackingBranch,
				ahead,
				behind,
				remoteHeadHash,
				hasUnfetchedChanges: false, // 本地 ref 已是最新
			};
		} catch {
			return null;
		}
	}

	/**
	 * 获取当前分支 upstream 上的最新 commit 列表（本地 remote-tracking refs）。
	 * 不自动 fetch，只读取已有的 @{u} 历史。
	 */
	async getRemoteCommits(cwd: string, maxCount = 50): Promise<GitCommitSummary[]> {
		try {
			const { stdout } = await execFileAsync(
				"git",
				[
					"log",
					"@{u}",
					`--max-count=${maxCount}`,
					"--format=%H%n%h%n%an%n%ai%n%s%n---END---",
				],
				{ cwd, maxBuffer: 4 * 1024 * 1024 },
			);
			const blocks = stdout.split("---END---\n");
			const commits: GitCommitSummary[] = [];
			for (const block of blocks) {
				const lines = block.trim().split(/\r?\n/);
				if (lines.length < 5) continue;
				commits.push({
					hash: lines[0],
					shortHash: lines[1],
					author: lines[2],
					date: lines[3],
					message: lines.slice(4).join("\n"),
				});
			}
			return commits;
		} catch {
			return [];
		}
	}

	/**
	 * 执行 git fetch --prune，刷新本地 remote-tracking refs。
	 * 返回 true 表示成功；false 表示失败（可能是网络问题或非 git 目录）。
	 */
	async fetch(cwd: string): Promise<boolean> {
		try {
			await execFileAsync(
				"git",
				["fetch", "--prune"],
				{ cwd, timeout: 120_000 }, // 最多等 2 分钟
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 获取工作区中相对于 HEAD 被修改的文件列表（包括已暂存和未暂存的修改，
	 * 以及未跟踪的新增文件）。前端根据此列表展示 Git 工作区变动概览。
	 * 返回 { path, status } 数组，status 值为 "modified" | "added" | "deleted" | "renamed"。
	 */
	async getChangedFiles(
		cwd: string,
	): Promise<{ path: string; status: string }[]> {
		try {
			const { stdout: repoRootRaw } = await execFileAsync(
				"git",
				["rev-parse", "--show-toplevel"],
				{ cwd },
			);
			const repoRoot = resolve(repoRootRaw.trim());
			const projectRoot = resolve(cwd);
			const [{ stdout: stagedRaw }, { stdout: unstagedRaw }, { stdout: untrackedRaw }] =
				await Promise.all([
					execFileAsync(
						"git",
						["diff", "--cached", "--name-status", "-z", "--diff-filter=ACDMR"],
						{ cwd: repoRoot },
					),
					execFileAsync(
						"git",
						["diff", "--name-status", "-z", "--diff-filter=ACDMR"],
						{ cwd: repoRoot },
					),
					execFileAsync(
						"git",
						["ls-files", "--others", "--exclude-standard", "-z"],
						{ cwd: repoRoot },
					),
				]);

			const files: { path: string; status: string }[] = [];
			const seen = new Set<string>();

			// Git 始终返回仓库根相对路径；嵌套项目只展示自己目录内的变更。
			const addFile = (repoRelativePath: string, status: string) => {
				if (!repoRelativePath) return;
				const absolutePath = resolve(repoRoot, repoRelativePath);
				const projectRelativePath = relative(projectRoot, absolutePath);
				if (
					projectRelativePath === ".." ||
					projectRelativePath.startsWith(`..${sep}`) ||
					isAbsolute(projectRelativePath) ||
					seen.has(absolutePath)
				) return;
				seen.add(absolutePath);
				files.push({ path: absolutePath, status });
			};

			// `-z` 让 Git 用 NUL 分隔状态和路径，避免空格、引号或非 ASCII 文件名被拆坏。
			// rename/copy 会额外返回旧路径；文件树徽标应绑定到当前存在的新路径。
			const addDiffEntries = (raw: string) => {
				const fields = raw.split("\0");
				for (let index = 0; index < fields.length - 1; ) {
					const statusToken = fields[index++];
					const statusChar = statusToken[0];
					const oldOrCurrentPath = fields[index++];
					const isRenameOrCopy = statusChar === "R" || statusChar === "C";
					const currentPath = isRenameOrCopy ? fields[index++] : oldOrCurrentPath;
					const status =
						statusChar === "A" ? "added"
							: statusChar === "D" ? "deleted"
								: statusChar === "R" ? "renamed"
									: "modified";
					addFile(currentPath, status);
				}
			};

			addDiffEntries(stagedRaw);
			addDiffEntries(unstagedRaw);

			for (const path of untrackedRaw.split("\0")) {
				addFile(path, "added");
			}

			return files;
		} catch {
			return [];
		}
	}
}
