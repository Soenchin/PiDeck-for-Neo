import { Cloud, GitBranch, History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
	GitCommitFile,
	GitCommitSummary,
	GitRemoteSummary,
} from "../../../../shared/types";
import { t } from "../../i18n";

export type GitPanelTab = "working-tree" | "commits" | "remote";

type WorkingTreeFile = {
	path: string;
	status?: string;
	toolName?: string;
	originalContent?: string;
	content?: string;
	changedLines?: number;
};

type GitPanelProps = {
	projectId?: string | null;
	workingTreeFiles: WorkingTreeFile[];
	onDiffWorkingTreeFile?: (
		path: string,
		originalContent?: string,
		content?: string,
	) => void;
	onDiffCommitFile?: (
		hash: string,
		filePath: string,
		oldContent: string,
		newContent: string,
	) => void;
	onFileContextMenu?: (path: string, x: number, y: number) => void;
};

const PREVIEW_LIMIT = 5;

function gitStatusIcon(status?: string): string {
	switch (status) {
		case "added":
			return "+";
		case "deleted":
			return "×";
		case "renamed":
			return "→";
		default:
			return "~";
	}
}

function gitStatusLabel(status?: string): string {
	if (status === "added") return t("drawer.gitFileAdded");
	if (status === "deleted") return t("drawer.gitFileDeleted");
	if (status === "renamed") return t("drawer.gitFileRenamed");
	return t("drawer.gitFileModified");
}

/**
 * Files 抽屉顶部的 Git 区块：
 * - 始终渲染（工作区干净时也显示提示）
 * - 三个 tab：工作区 / 提交 / 远端
 * - 提交与远端按需拉取，避免打开 Files 时就打一串 git 命令
 */
export function GitPanel(props: GitPanelProps) {
	const [tab, setTab] = useState<GitPanelTab>("working-tree");
	const [expandedWorkingTree, setExpandedWorkingTree] = useState(false);
	const [expandedCommits, setExpandedCommits] = useState(false);
	const [expandedRemoteCommits, setExpandedRemoteCommits] = useState(false);
	const [commits, setCommits] = useState<GitCommitSummary[]>([]);
	const [commitsLoading, setCommitsLoading] = useState(false);
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(
		null,
	);
	const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([]);
	const [commitFilesLoading, setCommitFilesLoading] = useState(false);
	const [remoteSummary, setRemoteSummary] = useState<GitRemoteSummary | null>(
		null,
	);
	const [remoteCommits, setRemoteCommits] = useState<GitCommitSummary[]>([]);
	const [remoteLoading, setRemoteLoading] = useState(false);
	const [fetching, setFetching] = useState(false);
	const [isGitRepo, setIsGitRepo] = useState(true);

	const projectId = props.projectId;

	const loadCommits = useCallback(async () => {
		if (!projectId || !window.piDesktop?.git?.commits) return;
		setCommitsLoading(true);
		try {
			const next = await window.piDesktop.git.commits(projectId, 50);
			setCommits(next);
			// 有 commits 说明是 git 仓库；空列表也可能是空仓库，保持 true。
			setIsGitRepo(true);
		} catch {
			setCommits([]);
			setIsGitRepo(false);
		} finally {
			setCommitsLoading(false);
		}
	}, [projectId]);

	const loadRemote = useCallback(async () => {
		if (!projectId || !window.piDesktop?.git) return;
		setRemoteLoading(true);
		try {
			const [summary, list] = await Promise.all([
				window.piDesktop.git.remoteSummary(projectId),
				window.piDesktop.git.remoteCommits(projectId, 30),
			]);
			setRemoteSummary(summary);
			setRemoteCommits(list);
			setIsGitRepo(true);
		} catch {
			setRemoteSummary(null);
			setRemoteCommits([]);
		} finally {
			setRemoteLoading(false);
		}
	}, [projectId]);

	const loadCommitFiles = useCallback(
		async (hash: string) => {
			if (!projectId || !window.piDesktop?.git?.commitFiles) return;
			setSelectedCommitHash(hash);
			setCommitFilesLoading(true);
			try {
				const files = await window.piDesktop.git.commitFiles(projectId, hash);
				setCommitFiles(files);
			} catch {
				setCommitFiles([]);
			} finally {
				setCommitFilesLoading(false);
			}
		},
		[projectId],
	);

	// 切换项目时重置 tab 内容，避免旧项目提交串到新项目。
	useEffect(() => {
		setTab("working-tree");
		setCommits([]);
		setSelectedCommitHash(null);
		setCommitFiles([]);
		setRemoteSummary(null);
		setRemoteCommits([]);
		setIsGitRepo(true);
		if (!projectId || !window.piDesktop?.git?.isRepo) return;
		void window.piDesktop.git
			.isRepo(projectId)
			.then(setIsGitRepo)
			.catch(() => setIsGitRepo(false));
	}, [projectId]);

	useEffect(() => {
		if (!isGitRepo) return;
		if (tab === "commits") void loadCommits();
		if (tab === "remote") void loadRemote();
	}, [tab, isGitRepo, loadCommits, loadRemote]);

	const onDiffCommitFile = props.onDiffCommitFile;

	const openCommitFileDiff = useCallback(
		async (hash: string, file: GitCommitFile) => {
			if (!projectId || !window.piDesktop?.git?.commitFileContent) return;
			if (!onDiffCommitFile) return;
			// path 是绝对路径；git show 用 relativePath / oldPath。
			const oldRelPath = file.oldPath ?? file.relativePath;
			const newRelPath = file.relativePath;
			const [oldContent, newContent] = await Promise.all([
				file.status === "added"
					? Promise.resolve("")
					: window.piDesktop.git.commitFileContent(
							projectId,
							hash,
							oldRelPath,
							"old",
						),
				file.status === "deleted"
					? Promise.resolve("")
					: window.piDesktop.git.commitFileContent(
							projectId,
							hash,
							newRelPath,
							"new",
						),
			]);
			onDiffCommitFile(hash, file.path, oldContent, newContent);
		},
		[projectId, onDiffCommitFile],
	);

	const renderCommitList = (list: GitCommitSummary[]) =>
		list.map((commit) => {
			const selected = selectedCommitHash === commit.hash;
			return (
				<div key={commit.hash} className="git-commit-block">
					<button
						type="button"
						className={`git-commit-row${selected ? " active" : ""}`}
						title={commit.hash}
						onClick={() => {
							if (selected) {
								setSelectedCommitHash(null);
								setCommitFiles([]);
								return;
							}
							void loadCommitFiles(commit.hash);
						}}
					>
						<span className="git-commit-short">{commit.shortHash}</span>
						<span className="git-commit-msg">{commit.message}</span>
						<span className="git-commit-meta">
							{t("drawer.gitCommitBy", {
								author: commit.author,
								date: commit.date.split(" ")[0] ?? commit.date,
							})}
						</span>
					</button>
					{selected && (
						<div className="git-commit-files">
							{commitFilesLoading ? (
								<div className="git-loading">{t("common.loading")}</div>
							) : commitFiles.length === 0 ? (
								<div className="git-clean-message">{t("drawer.gitChangesNone")}</div>
							) : (
								commitFiles.map((file) => {
									const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
									return (
										<button
											type="button"
											key={`${commit.hash}:${file.path}`}
											className="modified-file-row git-commit-file-row"
											title={file.path}
											onClick={() => void openCommitFileDiff(commit.hash, file)}
										>
											<span className="modified-file-icon done">
												{gitStatusIcon(file.status)}
											</span>
											<span className="modified-file-name">{fileName}</span>
											<span className="modified-file-lines">
												{gitStatusLabel(file.status)}
											</span>
										</button>
									);
								})
							)}
						</div>
					)}
				</div>
			);
		});

	const visibleCommits = expandedCommits
		? commits
		: commits.slice(0, PREVIEW_LIMIT);
	const visibleRemoteCommits = expandedRemoteCommits
		? remoteCommits
		: remoteCommits.slice(0, PREVIEW_LIMIT);
	const hiddenCommitsCount = Math.max(0, commits.length - visibleCommits.length);
	const hiddenRemoteCommitsCount = Math.max(
		0,
		remoteCommits.length - visibleRemoteCommits.length,
	);
	const latestWorkingTree = [...props.workingTreeFiles].reverse();
	const visibleWorkingTree = expandedWorkingTree
		? latestWorkingTree
		: latestWorkingTree.slice(0, PREVIEW_LIMIT);
	const hiddenWorkingTreeCount = Math.max(
		0,
		latestWorkingTree.length - visibleWorkingTree.length,
	);

	if (!projectId) return null;

	return (
		<div className="modified-files-section git-section">
			<div className="git-tab-bar" role="tablist" aria-label="Git">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "working-tree"}
					className={`git-tab${tab === "working-tree" ? " active" : ""}`}
					onClick={() => setTab("working-tree")}
				>
					<GitBranch size={13} strokeWidth={2} />
					<span>{t("drawer.gitTabWorkingTree")}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "commits"}
					className={`git-tab${tab === "commits" ? " active" : ""}`}
					onClick={() => setTab("commits")}
				>
					<History size={13} strokeWidth={2} />
					<span>{t("drawer.gitTabCommits")}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "remote"}
					className={`git-tab${tab === "remote" ? " active" : ""}`}
					onClick={() => setTab("remote")}
				>
					<Cloud size={13} strokeWidth={2} />
					<span>{t("drawer.gitTabRemote")}</span>
				</button>
			</div>

			{!isGitRepo ? (
				<div className="git-clean-message">{t("drawer.gitNotARepo")}</div>
			) : tab === "working-tree" ? (
				<>
					<div className="modified-files-header">
						<span>{t("drawer.gitChangedFiles")}</span>
					</div>
					{latestWorkingTree.length === 0 ? (
						<div className="git-clean-message">{t("drawer.gitChangesNone")}</div>
					) : (
						<>
							{visibleWorkingTree.map((file) => {
								const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
								const isRunning = file.status === "running";
								return (
									<div
										key={file.path}
										className={`modified-file-row${isRunning ? " running" : ""}`}
										title={file.path}
										onContextMenu={(event) => {
											event.preventDefault();
											props.onFileContextMenu?.(
												file.path,
												event.clientX,
												event.clientY,
											);
										}}
										onClick={() =>
											props.onDiffWorkingTreeFile?.(
												file.path,
												file.originalContent,
												file.content,
											)
										}
									>
										<span
											className={`modified-file-icon${isRunning ? "" : " done"}`}
										>
											{file.toolName === "git" || !file.toolName
												? gitStatusIcon(file.status)
												: isRunning
													? "◌"
													: "✓"}
										</span>
										<span className="modified-file-name">{fileName}</span>
										{(file.toolName === "git" || !file.toolName) &&
											file.status !== "deleted" && (
												<span className="modified-file-lines">
													{gitStatusLabel(file.status)}
												</span>
											)}
										{file.toolName && file.toolName !== "git" && (
											<span className="modified-file-tool">{file.toolName}</span>
										)}
									</div>
								);
							})}
							{latestWorkingTree.length > PREVIEW_LIMIT && (
								<button
									className="modified-files-toggle"
									type="button"
									onClick={() => setExpandedWorkingTree((current) => !current)}
								>
									{expandedWorkingTree
										? t("common.collapse")
										: t("drawer.moreFiles", { count: hiddenWorkingTreeCount })}
								</button>
							)}
						</>
					)}
				</>
			) : tab === "commits" ? (
				<div className="git-commits-section">
					<div className="modified-files-header">
						<span>{t("drawer.gitCommitsTitle")}</span>
					</div>
					{commitsLoading ? (
						<div className="git-loading">{t("common.loading")}</div>
					) : commits.length === 0 ? (
						<div className="git-clean-message">{t("drawer.gitNoCommits")}</div>
					) : (
						<>
							{renderCommitList(visibleCommits)}
							{commits.length > PREVIEW_LIMIT && (
								<button
									className="modified-files-toggle git-list-toggle"
									type="button"
									onClick={() => setExpandedCommits((current) => !current)}
								>
									{expandedCommits
										? t("drawer.gitCollapse")
										: t("drawer.gitExpand", { count: hiddenCommitsCount })}
								</button>
							)}
						</>
					)}
				</div>
			) : (
				<div className="git-remote-section">
					<div className="modified-files-header">
						<span>{t("drawer.gitRemoteTitle")}</span>
					</div>
					{remoteLoading ? (
						<div className="git-loading">{t("common.loading")}</div>
					) : (
						<>
							{remoteSummary ? (
								<div className="git-remote-summary">
									<span className="git-remote-branch">
										{remoteSummary.trackingBranch}
									</span>
									{remoteSummary.ahead > 0 && (
										<span className="git-remote-ahead">
											{t("drawer.gitRemoteAhead", {
												ahead: remoteSummary.ahead,
											})}
										</span>
									)}
									{remoteSummary.behind > 0 && (
										<span className="git-remote-behind">
											{t("drawer.gitRemoteBehind", {
												behind: remoteSummary.behind,
											})}
										</span>
									)}
									{remoteSummary.ahead === 0 && remoteSummary.behind === 0 && (
										<span className="git-remote-synced">
											{t("drawer.gitChangesNone")}
										</span>
									)}
								</div>
							) : (
								<div className="git-clean-message">
									{t("drawer.gitRemoteNoUpstream")}
								</div>
							)}
							<div className="git-remote-commits-list">
								{remoteCommits.length === 0 ? (
									<div className="git-clean-message">
										{t("drawer.gitNoRemoteCommits")}
									</div>
								) : (
									<>
										{renderCommitList(visibleRemoteCommits)}
										{remoteCommits.length > PREVIEW_LIMIT && (
											<button
												className="modified-files-toggle git-list-toggle"
												type="button"
												onClick={() =>
														setExpandedRemoteCommits((current) => !current)
													}
											>
												{expandedRemoteCommits
													? t("drawer.gitCollapse")
													: t("drawer.gitExpand", {
															count: hiddenRemoteCommitsCount,
														})}
											</button>
										)}
									</>
								)}
							</div>
							<button
								type="button"
								className="git-fetch-btn"
								disabled={fetching}
								onClick={async () => {
									if (!projectId || !window.piDesktop?.git?.fetch) return;
									setFetching(true);
									try {
										const ok = await window.piDesktop.git.fetch(projectId);
										if (!ok) {
											// 失败时仍尝试刷新本地 refs，避免 UI 卡在旧状态。
										}
										await loadRemote();
									} finally {
										setFetching(false);
									}
								}}
							>
								{fetching
									? t("drawer.gitRemoteFetching")
									: t("drawer.gitRemoteFetch")}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}
