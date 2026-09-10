import type { AutonomousModeSettings } from "../../shared/types";

export function buildAutonomousPrompt(input: {
	activities: AutonomousModeSettings["activities"];
	runDirectory: string;
}): string {
	const allowed = [
		input.activities.search ? "- 使用 AnySearch 阅读公开网页，整理真正有价值的资料；" : undefined,
		input.activities.games ? "- 使用 browser-skill 在独立 Agent Window 浏览公开网页或玩无风险小游戏；" : undefined,
		"- 将本轮产物写进指定活动目录。",
	].filter(Boolean).join("\n");
	return `你现在处于 PiDeck 空闲自主活动模式：主人已离开电脑。\n\n本次活动目录：${input.runDirectory}\n\n允许的活动：\n${allowed}\n\n安全边界：\n- 只允许在本次活动目录新建文件，绝不改动、删除、移动或读取其他私人文件；\n- 不执行 Git，不安装软件或依赖；\n- 不登录新账号，不发帖/评论/私信/点赞/关注，不购买、不付费，不处理验证码；\n- 不读取密码、Cookie、Token、私人消息或敏感信息；\n- browser-skill 必须先创建独立 browser session，绝不借用用户已有标签页。\n\n自行选一项活动。完成后简短说明本轮做了什么并结束回复；PiDeck 只会在主人仍离开且满足节流时决定是否续轮。`;
}

export function buildAutonomousContinuationPrompt(): string {
	return "主人仍处于离开状态。选择一项与上一轮不同的允许活动，继续遵守所有安全和文件边界；完成后简短说明并结束回复。";
}
