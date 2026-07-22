/**
 * PiDeck NUL Redirect Fix Extension
 *
 * Windows 的 Git Bash / MSYS2 可能把 `> nul` 当成普通文件重定向，
 * 导致项目目录出现名为 `nul` 的 Windows 保留设备名文件。PiDeck 在
 * bash 工具真正执行前将它改写为 POSIX 的 `/dev/null`。
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 将 Windows NUL 设备重定向改写为 /dev/null。
 *
 * 只处理引号外、未转义的重定向目标；因此不会修改 `echo "> nul"`、
 * `> nul.txt` 或 `\> nul`。platform 参数仅用于测试，生产调用默认使用当前平台。
 */
export function normalizeNulRedirects(command: string, platform = process.platform): string {
	if (platform !== "win32" || !/nul/i.test(command)) return command;

	let result = "";
	let inSingleQuotes = false;
	let inDoubleQuotes = false;
	let i = 0;
	let trailingBackslashes = 0;
	const redirectRe = /([12]?(?:&?>>?|>&))\s*nul(?=\s|$|[|&;()<>])/iy;

	while (i < command.length) {
		const char = command[i];
		if (char === "\\") {
			trailingBackslashes++;
			result += char;
			i++;
			continue;
		}

		const isEscaped = trailingBackslashes % 2 === 1;
		trailingBackslashes = 0;
		if (char === "'" && !inDoubleQuotes) {
			if (!inSingleQuotes && isEscaped) {
				result += char;
				i++;
				continue;
			}
			inSingleQuotes = !inSingleQuotes;
			result += char;
			i++;
			continue;
		}
		if (char === '"' && !inSingleQuotes && !isEscaped) {
			inDoubleQuotes = !inDoubleQuotes;
			result += char;
			i++;
			continue;
		}

		if (!inSingleQuotes && !inDoubleQuotes && !isEscaped) {
			redirectRe.lastIndex = i;
			const match = redirectRe.exec(command);
			if (match) {
				result += `${match[1]}/dev/null`;
				i += match[0].length;
				continue;
			}
		}

		result += char;
		i++;
	}
	return result;
}

export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const original = event.input.command;
		const normalized = normalizeNulRedirects(original);
		if (normalized === original) return;

		event.input.command = normalized;
		if (ctx.hasUI) ctx.ui.setStatus("nul-fix", "NUL → /dev/null");
	});
}
