/**
 * 会话文件路径归一化工具
 * 用于置顶状态、会话匹配、Agent 会话关联等场景的路径比较
 */

/**
 * 归一化会话路径，用于跨平台一致的比较和存储键值
 * - 反斜杠统一为正斜杠
 * - Windows 路径转小写（盘符 + 路径）
 * - 去除尾部斜杠
 */
export function normalizeSessionPath(sessionPath?: string): string {
	if (!sessionPath) return "";
	return sessionPath
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/**
 * 判断两个会话路径是否指向同一个文件
 */
export function isSameSessionPath(left?: string, right?: string): boolean {
	const normalizedLeft = normalizeSessionPath(left);
	const normalizedRight = normalizeSessionPath(right);
	return Boolean(
		normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
	);
}
