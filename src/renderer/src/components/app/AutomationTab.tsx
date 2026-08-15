import { t } from "../../i18n";
import { TextField } from "../ui/TextField";
import {
	DEFAULT_AUTOMATION_SETTINGS,
	type AppSettings,
	type DailySummarySettings,
} from "../../../../shared/types";
import { SettingsSection, SettingSwitch } from "./SettingsControls";

export function AutomationTab(props: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => void;
}) {
	const automation = props.settings.automation;
	const dailySummary = {
		...DEFAULT_AUTOMATION_SETTINGS.dailySummary,
		...(automation?.dailySummary ?? {}),
	};
	const autonomousMode = {
		...DEFAULT_AUTOMATION_SETTINGS.autonomousMode,
		...(automation?.autonomousMode ?? {}),
		activities: {
			...DEFAULT_AUTOMATION_SETTINGS.autonomousMode.activities,
			...(automation?.autonomousMode?.activities ?? {}),
		},
	};

	const updateDailySummary = (patch: Partial<DailySummarySettings>) => {
		props.onChange({
			automation: {
				...automation,
				dailySummary: { ...dailySummary, ...patch },
			},
		});
	};

	return (
		<>
			<SettingsSection
				title={t("settings.automation.dailySummary.title")}
				description={t("settings.automation.dailySummary.desc")}
			>
				<SettingSwitch
					title={t("settings.automation.dailySummary.enable")}
					description={t("settings.automation.dailySummary.enableDesc")}
					checked={dailySummary.enabled}
					onChange={(checked) => updateDailySummary({ enabled: checked })}
				/>

				<TextField
					className="setting-field"
					label={t("settings.automation.dailySummary.time")}
					type="time"
					value={dailySummary.time}
					disabled={!dailySummary.enabled}
					onChange={(value) => {
						if (/^\d{2}:\d{2}$/.test(value)) updateDailySummary({ time: value });
					}}
				/>

				<SettingSwitch
					title={t("settings.automation.dailySummary.requireReview")}
					description={t("settings.automation.dailySummary.requireReviewDesc")}
					checked={dailySummary.requireReview}
					disabled={!dailySummary.enabled}
					onChange={(checked) => updateDailySummary({ requireReview: checked })}
				/>

				<TextField
					className="setting-field"
					label={t("settings.automation.dailySummary.minTurns")}
					type="number"
					min={1}
					value={String(dailySummary.minTurns)}
					disabled={!dailySummary.enabled}
					description={t("settings.automation.dailySummary.minTurnsDesc")}
					onChange={(value) =>
						updateDailySummary({ minTurns: Math.max(1, Number.parseInt(value, 10) || 5) })
					}
				/>
			</SettingsSection>

			<SettingsSection
				title={t("settings.automation.autonomous.title")}
				description={t("settings.automation.autonomous.developmentDesc")}
			>
				<SettingSwitch
					title={t("settings.automation.autonomous.enable")}
					description={t("settings.automation.autonomous.enableDesc")}
					checked={autonomousMode.enabled}
					disabled
					onChange={() => undefined}
				/>
				<TextField
					className="setting-field"
					label={t("settings.automation.autonomous.idleThreshold")}
					type="number"
					min={5}
					value={String(autonomousMode.idleThresholdMinutes)}
					disabled
					description={t("settings.automation.autonomous.idleThresholdDesc")}
					onChange={() => undefined}
				/>
				<SettingSwitch
					title={t("settings.automation.autonomous.activitySearch")}
					checked={autonomousMode.activities.search}
					disabled
					onChange={() => undefined}
				/>
				<SettingSwitch
					title={t("settings.automation.autonomous.activityGames")}
					checked={autonomousMode.activities.games}
					disabled
					onChange={() => undefined}
				/>
			</SettingsSection>

			<SettingsSection
				title={t("settings.automation.status.title")}
				description={t("settings.automation.status.desc")}
			>
				<div className="setting-row">
					<div>
						<strong>{t("settings.automation.status.dailySummaryStatus")}</strong>
						<small>
							{dailySummary.enabled
								? t("settings.automation.status.enabled", { time: dailySummary.time })
								: t("settings.automation.status.disabled")}
						</small>
					</div>
				</div>
				<div className="setting-row">
					<div>
						<strong>{t("settings.automation.status.autonomousStatus")}</strong>
						<small>{t("settings.automation.status.development")}</small>
					</div>
				</div>
			</SettingsSection>
		</>
	);
}
