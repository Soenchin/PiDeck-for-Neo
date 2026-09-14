import { memo, useEffect, useRef, useState } from "react";
import type { AppSettings, AutonomousModeSettings, DailySummarySettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Input } from "../../ui-shadcn/input";
import { Button } from "../../ui-shadcn/button";
import { desktopApi } from "../../../desktopApi";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingBox, SettingRow, SettingSwitchRow } from "./SettingRows";

type AutomationTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
};

/** Automation controls remain in their own tab: both features can create Agents or request memory writes. */
export const AutomationTab = memo(function AutomationTab(props: AutomationTabProps) {
	const automation = props.draft.automation;
	const [manualRunState, setManualRunState] = useState<"idle" | "running" | "started" | "failed" | "disabled" | "already-running">("idle");
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	/** IPC 只确认已受理，不把它显示成候选生成成功。主进程拥有运行与审核状态。 */
	const runDailySummaryNow = async () => {
		setManualRunState("running");
		try {
			const result = await desktopApi.automation.runDailySummaryNow();
			if (mounted.current) setManualRunState(result.started ? "started" : result.reason ?? "failed");
		} catch {
			if (mounted.current) setManualRunState("failed");
		}
	};
	const updateDaily = (patch: Partial<DailySummarySettings>) => props.updateDraft({
		automation: { ...automation, dailySummary: { ...automation.dailySummary, ...patch } },
	});
	const updateAutonomous = (patch: Partial<AutonomousModeSettings>) => props.updateDraft({
		automation: { ...automation, autonomousMode: { ...automation.autonomousMode, ...patch } },
	});
	const updateModel = (field: "provider" | "modelId", value: string) => {
		const current = automation.autonomousMode.model ?? { provider: "", modelId: "" };
		const next = { ...current, [field]: value };
		updateAutonomous({ model: next.provider.trim() || next.modelId.trim() ? next : undefined });
	};

	return (
		<>
			<SettingsSection title={t("automation.daily.title")} description={t("automation.daily.description")}>
				<SettingBox>
					<SettingSwitchRow
						title={<><span>{t("automation.daily.enabled")}</span><DirtyMarker dirty={props.isDirty("automation")} label={t("automation.daily.enabled")} /></>}
						checked={automation.dailySummary.enabled}
						onChange={(enabled) => updateDaily({ enabled })}
					/>
					<SettingRow title={t("automation.daily.time")} alignEnd={false}>
						<Input type="time" value={automation.dailySummary.time} disabled={!automation.dailySummary.enabled}
							onChange={(event) => updateDaily({ time: event.target.value })} />
					</SettingRow>
					<SettingRow title={t("automation.daily.minTurns")} description={t("automation.daily.minTurnsDesc")} alignEnd={false}>
						<Input type="number" min={1} value={String(automation.dailySummary.minTurns)} disabled={!automation.dailySummary.enabled}
							onChange={(event) => updateDaily({ minTurns: Math.max(1, Number.parseInt(event.target.value, 10) || 1) })} />
					</SettingRow>
					<SettingRow title={t("automation.daily.runNow")} description={t("automation.daily.runNowDesc")} alignEnd>
						<Button size="sm" variant="outline" disabled={!automation.dailySummary.enabled || props.isDirty("automation") || manualRunState === "running"}
							onClick={() => void runDailySummaryNow()}>
							{manualRunState === "running" ? t("automation.daily.running") : t("automation.daily.runNow")}
						</Button>
					</SettingRow>
					{manualRunState !== "idle" && manualRunState !== "running" && (
						<p role="status" className="px-3 py-2 text-caption text-muted-foreground">{t(`automation.daily.${manualRunState}`)}</p>
					)}
				</SettingBox>
			</SettingsSection>

			<SettingsSection title={t("automation.autonomous.title")} description={t("automation.autonomous.description")}>
				<SettingBox>
					<SettingSwitchRow title={t("automation.autonomous.enabled")} checked={automation.autonomousMode.enabled}
						onChange={(enabled) => updateAutonomous({ enabled })} />
					<SettingRow title={t("automation.autonomous.idleThreshold")} description={t("automation.autonomous.idleThresholdDesc")} alignEnd={false}>
						<Input type="number" min={40} value={String(automation.autonomousMode.idleThresholdMinutes)} disabled={!automation.autonomousMode.enabled}
							onChange={(event) => updateAutonomous({ idleThresholdMinutes: Math.max(40, Number.parseInt(event.target.value, 10) || 40) })} />
					</SettingRow>
					<SettingRow title={t("automation.autonomous.modelProvider")} description={t("automation.autonomous.modelDesc")} alignEnd={false}>
						<Input value={automation.autonomousMode.model?.provider ?? ""} disabled={!automation.autonomousMode.enabled}
							onChange={(event) => updateModel("provider", event.target.value)} />
					</SettingRow>
					<SettingRow title={t("automation.autonomous.modelId")} alignEnd={false}>
						<Input value={automation.autonomousMode.model?.modelId ?? ""} disabled={!automation.autonomousMode.enabled}
							onChange={(event) => updateModel("modelId", event.target.value)} />
					</SettingRow>
					<SettingSwitchRow title={t("automation.autonomous.search")} checked={automation.autonomousMode.activities.search}
						disabled={!automation.autonomousMode.enabled}
						onChange={(search) => updateAutonomous({ activities: { ...automation.autonomousMode.activities, search } })} />
					<SettingSwitchRow title={t("automation.autonomous.games")} checked={automation.autonomousMode.activities.games}
						disabled={!automation.autonomousMode.enabled}
						onChange={(games) => updateAutonomous({ activities: { ...automation.autonomousMode.activities, games } })} />
				</SettingBox>
			</SettingsSection>
		</>
	);
});
