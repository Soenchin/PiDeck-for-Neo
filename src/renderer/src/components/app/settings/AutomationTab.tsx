import { memo } from "react";
import type { AppSettings, AutonomousModeSettings, DailySummarySettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
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
