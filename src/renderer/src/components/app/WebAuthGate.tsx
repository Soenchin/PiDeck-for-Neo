import { useEffect, useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import {
	getWebAuthToken,
	setWebAuthToken,
	verifyWebAuth,
	type WebAuthResult,
} from "../../browserApi";

/**
 * 局域网 Web 端访问令牌门槛：没有有效令牌时不渲染工作台。
 * Electron 桌面端不会走到这里（App.tsx 仅在 isLanWeb 时启用）。
 */
export function WebAuthGate(props: { onAuthenticated: () => void }) {
	const [token, setToken] = useState(getWebAuthToken());
	const [checking, setChecking] = useState(false);
	const [failure, setFailure] = useState<Exclude<WebAuthResult, "ok"> | null>(null);

	// 门槛出现即视为基础界面就绪，通知开屏遮罩退场，避免挡住令牌输入。
	useEffect(() => {
		window.dispatchEvent(new Event("neonisch-boot-ready"));
	}, []);

	async function submit(event: FormEvent) {
		event.preventDefault();
		const trimmed = token.trim();
		if (!trimmed || checking) return;
		setChecking(true);
		setWebAuthToken(trimmed);
		const result = await verifyWebAuth();
		setChecking(false);
		if (result === "ok") {
			props.onAuthenticated();
			return;
		}
		setFailure(result);
	}

	return (
		<div className="web-auth-gate">
			<form className="web-auth-card" onSubmit={submit}>
				<strong className="web-auth-title">{t("webAuth.title")}</strong>
				<small className="web-auth-desc">{t("webAuth.desc")}</small>
				<TextField
					className="setting-field"
					label={t("webAuth.tokenLabel")}
					value={token}
					placeholder={t("webAuth.placeholder")}
					onChange={(value) => {
						setToken(value);
						setFailure(null);
					}}
				/>
				{failure === "unauthorized" && (
					<small className="setting-status error">{t("webAuth.invalid")}</small>
				)}
				{failure === "error" && (
					<small className="setting-status error">{t("webAuth.networkError")}</small>
				)}
				<Button variant="primary" type="submit" loading={checking} disabled={!token.trim()}>
					{checking ? t("webAuth.checking") : t("webAuth.submit")}
				</Button>
			</form>
		</div>
	);
}
