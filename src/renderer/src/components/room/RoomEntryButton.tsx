/** Neo × ROCKET 房间的左侧栏常驻入口。 */
import { t } from "../../i18n";

export function RoomEntryButton({
	active,
	onClick,
}: {
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={`conversation room-entry${active ? " active" : ""}`}
			onClick={onClick}
			title={t("room.entryTitle")}
		>
			<span className="room-entry-name">{t("room.entryName")}</span>
		</button>
	);
}