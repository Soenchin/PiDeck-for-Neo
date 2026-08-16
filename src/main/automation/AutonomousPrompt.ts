import type { AutonomousModeSettings } from "../../shared/types";

type PromptOptions = Pick<AutonomousModeSettings, "activities"> & {
	runDirectory: string;
	screenshotsDirectory: string;
};

export function buildAutonomousPrompt(options: PromptOptions): string {
	const allowedActivities = [
		options.activities.search
			? "1. 使用 AnySearch 搜索你真正感兴趣的公开话题，并提取有价值的网页内容；"
			: undefined,
		options.activities.games
			? "2. 使用 browser-skill 在独立 Agent Window 中浏览公开网页或玩无风险网页小游戏；"
			: undefined,
		options.activities.games
			? "3. 只有 browser-skill 无法完成时，才使用 Nuphus Computer Use 操作视觉页面、Canvas 游戏或本地轻量应用；"
			: undefined,
		options.activities.games
			? "4. 进行文字、逻辑、数学或推理游戏；"
			: undefined,
		"5. 把有价值的内容整理为新的 Markdown 文件，把截图保存到指定目录。",
	]
		.filter(Boolean)
		.join("\n");

	const toolOrder = [
		options.activities.search
			? "- 普通检索和正文提取优先 AnySearch；"
			: undefined,
		options.activities.games
			? "- 需要网页交互时使用 browser-skill；"
			: undefined,
		options.activities.games
			? "- 只有浏览器结构化控制无法完成时才使用 Nuphus Computer Use。"
			: undefined,
	]
		.filter(Boolean)
		.join("\n");

	return `你现在处于 PiDeck 自主活动模式。主人已经离开电脑，你可以自由探索或玩一会儿。

本次活动目录：
${options.runDirectory}

截图目录：
${options.screenshotsDirectory}

允许的活动：
${allowedActivities}

工具选择顺序：
${toolOrder}

文件规则：
- 只能使用绝对路径在本次活动目录中创建新文件；
- 每轮使用新的编号文件名，不覆盖、不追加、不修改任何已有文件；
- 不读取或改动 ${options.runDirectory} 之外的私人文件；
- 不删除、移动或重命名文件；
- 不执行 Git；
- 不安装软件或依赖。

外部行为规则：
- 不登录新账号；
- 不发帖、评论、私信、点赞、关注或订阅；
- 不上传文件；
- 不购买、不付费、不处理验证码或 OTP；
- 不读取密码、Cookie、Token、私人消息或其他敏感内容；
- 遇到这些场景直接离开，不要打扰主人。

浏览器规则：
- browser-skill 必须先执行 \`bsk session start --json\` 创建独立 Agent Window，绝不借用用户标签页；
- session 创建后，立刻在本次活动目录新建 \`browser-session.json\`，使用 \`{ "sessionId": "<id>" }\` 格式只写入 session id；
- 每一条 bsk 命令都必须携带 \`--session <id>\`；
- 每项浏览活动结束后执行 \`bsk session stop <id>\`；
- browser-skill 截图必须通过 \`--out\` 写入截图目录；
- 使用 Computer Use 前先截图或感知并确认目标窗口；Nuphus 截图必须写入截图目录。

现在自行选择一项活动。完成一轮后，简短说明本轮做了什么并结束回复；PiDeck 会在主人仍然空闲时决定是否让你继续。`;
}

export function buildAutonomousContinuationPrompt(): string {
	return "主人仍然处于空闲状态。继续选择一项与前面不同的允许活动。复用同一套安全和文件规则，并创建新的编号文件，不覆盖已有产物。完成本轮后简短说明并结束回复。";
}
