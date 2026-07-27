/**
 * Neo × ROCKET 房间面板：共享时间线 + 带发送目标选择的输入框 + 模型 chip + 让另一位接话。
 *
 * 三人围桌的轻量体验：主人 @Neo / @ROCKET / @两人，两个独立 pi Session 各自回答，
 * 合并时间线按发言者头像区分。Agent 之间不自动互相触发，控制权在主人手里，
 * 但每条对方发言下提供「让另一位接话」，点击即把对方的话转交给另一人延续讨论。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square, AlertCircle, Repeat2, Eraser, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AvailableModel, ImageContent } from "../../../../shared/types";
import type { RoomParticipant, RoomSendTarget } from "../../../../shared/room";
import { useRoom, type RoomAuthor } from "../../hooks/useRoom";
import { t } from "../../i18n";
import { ConfirmDialog } from "../app/AppParts";

type Target = RoomSendTarget;
type Participant = RoomParticipant;

const TARGET_LABEL: Record<Target, string> = {
	neo: "Neo",
	rocket: "ROCKET",
	both: "两人",
};

function authorName(author: RoomAuthor): string {
	if (author === "human") return t("room.you");
	if (author === "neo") return "Neo";
	if (author === "rocket") return "ROCKET";
	return "";
}

export function RoomPanel() {
	const room = useRoom();
	const [text, setText] = useState("");
	const [target, setTarget] = useState<Target>("both");
	const [images, setImages] = useState<ImageContent[]>([]);
	const [roomActionBusy, setRoomActionBusy] = useState(false);
	const [roomActionError, setRoomActionError] = useState<string>();
	const [confirmNewTable, setConfirmNewTable] = useState(false);
	const timelineRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = timelineRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [room.timeline.length]);

	const canSend = (text.trim().length > 0 || images.length > 0) && !room.busy && room.ready;

	const handleSend = async () => {
		if (!canSend) return;
		const payload = text;
		const imgs = images.length ? images : undefined;
		setText("");
		setImages([]);
		await room.send(target, payload, imgs);
	};

	/** 把某条非人类发言的内容转交给另一位延续讨论，保持主控权在主人手里。 */
	const handleRelay = async (author: RoomAuthor, content: string) => {
		if (author !== "neo" && author !== "rocket") return;
		const other: Participant = author === "neo" ? "rocket" : "neo";
		const otherLabel = other === "neo" ? "Neo" : "ROCKET";
		const internalContext = `${content.trim()}\n\n[${t("room.relayHint", { other: otherLabel })}]`;
		await room.send(
			other,
			t("room.relayDisplay", { other: otherLabel }),
			undefined,
			internalContext,
		);
	};

	const handleClear = async () => {
		if (room.busy || roomActionBusy) return;
		setRoomActionError(undefined);
		setRoomActionBusy(true);
		try {
			await room.clear();
		} catch (error) {
			setRoomActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setRoomActionBusy(false);
		}
	};

	const handleNewTable = async () => {
		if (room.busy || roomActionBusy) return;
		setConfirmNewTable(false);
		setRoomActionError(undefined);
		setRoomActionBusy(true);
		try {
			await room.newTable();
		} catch (error) {
			setRoomActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setRoomActionBusy(false);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void handleSend();
		}
	};

	const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = event.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					event.preventDefault();
					void fileToImageContent(file).then((ic) => setImages((prev) => [...prev, ic]));
				}
			}
		}
	};

	return (
		<div className="room-panel">
			{confirmNewTable && (
				<ConfirmDialog
					title={t("room.newTable")}
					message={t("room.newTableConfirm")}
					confirmLabel={t("room.newTableConfirmAction")}
					danger
					onCancel={() => setConfirmNewTable(false)}
					onConfirm={() => void handleNewTable()}
				/>
			)}
			<header className="room-header">
				<div className="room-title-block">
					<span className="room-brand">{t("room.panelTitle")}</span>
					<span className="room-subtitle">{t("room.entrySub")}</span>
				</div>
				<div className="room-header-tools">
					<div className="room-status-pills">
						<ParticipantPill name="Neo" status={room.neoStatus} contextPercent={room.neoContextPercent} />
						<ParticipantPill name="小 R" status={room.rocketStatus} contextPercent={room.rocketContextPercent} />
					</div>
					<div className="room-history-actions">
						<button
							type="button"
							className="room-header-action"
							disabled={room.busy || roomActionBusy}
							onClick={() => void handleClear()}
							title={t("room.clearTitle")}
							aria-label={t("room.clear")}
						>
							<Eraser size={15} />
						</button>
						<button
							type="button"
							className="room-header-action danger"
							disabled={room.busy || roomActionBusy}
							onClick={() => setConfirmNewTable(true)}
							title={t("room.newTableTitle")}
							aria-label={t("room.newTable")}
						>
							<RotateCcw size={15} />
						</button>
					</div>
				</div>
			</header>

			<section className="room-timeline" ref={timelineRef}>
				{roomActionError && (
					<div className="room-notice error">
						<AlertCircle size={14} />
						<span>{roomActionError}</span>
					</div>
				)}
				{room.state.status === "provisioning" && (
					<div className="room-notice">{t("room.provisioning")}</div>
				)}
				{room.state.status === "error" && (
					<div className="room-notice error">
						<AlertCircle size={14} />
						<span>{room.state.error ?? t("room.errorGeneric")}</span>
					</div>
				)}
				{room.timeline.length === 0 && room.ready && (
					<div className="room-empty">{t("room.empty")}</div>
				)}
				{room.timeline.map((item) => (
					<RoomBubble
						key={item.id}
						item={item}
						onRelay={
							item.author === "neo" || item.author === "rocket"
								? () => void handleRelay(item.author, item.message.text)
								: undefined
						}
					/>
				))}
			</section>

			<footer className="room-composer">
				<div className="room-target-row">
					<div className="room-target-group">
						{(["neo", "rocket", "both"] as Target[]).map((tg) => (
							<button
								key={tg}
								type="button"
								className={`room-target-chip${target === tg ? " active" : ""}`}
								onClick={() => setTarget(tg)}
								aria-label={`@${TARGET_LABEL[tg]}`}
							>
								@{TARGET_LABEL[tg]}
							</button>
						))}
					</div>
					<div className="room-model-group">
						<ModelChip
							participant="neo"
							models={room.neoModels}
							currentProvider={room.neoProvider}
							currentId={room.neoModelId}
							disabled={!room.neoAgentId}
							onPick={(model) => room.setModel({ participant: "neo", provider: model.provider, modelId: model.id })}
						/>
						<ModelChip
							participant="rocket"
							models={room.rocketModels}
							currentProvider={room.rocketProvider}
							currentId={room.rocketModelId}
							disabled={!room.rocketAgentId}
							onPick={(model) => room.setModel({ participant: "rocket", provider: model.provider, modelId: model.id })}
						/>
					</div>
				</div>
				<div className="room-input-row">
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
						placeholder={t("room.composerPlaceholder")}
						rows={1}
					/>
					{room.busy ? (
						<button
							type="button"
							className="room-send stop"
							onClick={() => void room.abort()}
							title={t("room.stop")}
						>
							<Square size={14} />
						</button>
					) : (
						<button
							type="button"
							className="room-send"
							disabled={!canSend}
							onClick={() => void handleSend()}
							title={t("room.send")}
						>
							<ArrowUp size={14} />
						</button>
					)}
				</div>
				{images.length > 0 && (
					<div className="room-thumb-row">
						{images.map((img, i) => (
							<img
								key={i}
								src={`data:${img.mimeType};base64,${img.data}`}
								alt="preview"
								onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
								title={t("room.removeImage")}
							/>
						))}
					</div>
				)}
			</footer>
		</div>
	);
}

/** 参与者模型 chip：复用父 RoomPanel 已拉取的模型列表，避免重复订阅房间状态。 */
function ModelChip({
	participant,
	models,
	currentProvider,
	currentId,
	disabled,
	onPick,
}: {
	participant: Participant;
	models: AvailableModel[];
	currentProvider?: string;
	currentId?: string;
	disabled?: boolean;
	onPick: (model: AvailableModel) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const label = participant === "neo" ? "Neo" : "ROCKET";
	const current = models.find(
		(model) => model.id === currentId && (!currentProvider || model.provider === currentProvider),
	);
	const currentLabel = current
		? `${current.provider} / ${current.name ?? current.id}`
		: currentId ?? t("room.modelDefault");

	const pick = async (model: AvailableModel) => {
		setOpen(false);
		await onPick(model);
	};

	return (
		<span className={`room-model-chip${open ? " open" : ""}`}>
			<button
				type="button"
				className="room-model-trigger"
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
				title={t("room.modelTitle")}
			>
				<span className="room-model-dot" />
				{label}: {currentLabel}
			</button>
			{open && !disabled && (
				<div className="room-model-menu" role="listbox">
					{models.length === 0 && <div className="room-model-empty">{t("room.modelLoading")}</div>}
					{models.map((m) => (
						<button
							key={`${m.provider}/${m.id}`}
							type="button"
							className={`room-model-item${m.id === currentId && (!currentProvider || m.provider === currentProvider) ? " active" : ""}`}
							onClick={() => void pick(m)}
						>
							<span className="room-model-name">
								<span className="room-model-provider">{m.provider}</span>
								<span>{m.name ?? m.id}</span>
							</span>
							<span className="room-model-id">{m.id}</span>
						</button>
					))}
				</div>
			)}
		</span>
	);
}

function ParticipantPill({
	name,
	status,
	contextPercent,
}: {
	name: string;
	status?: string;
	contextPercent?: number | null;
}) {
	const dot = status === "running" ? "running" : status === "error" ? "error" : status === "closed" ? "closed" : "idle";
	const contextLabel = typeof contextPercent === "number" ? `${Math.round(contextPercent)}%` : "—";
	return (
		<span
			className={`room-pill room-pill-${dot}`}
			title={t("room.contextTitle", { name, percent: contextLabel })}
		>
			<span className="room-pill-dot" />
			{name}
			<span className="room-pill-context">{contextLabel}</span>
		</span>
	);
}

function RoomBubble({
	item,
	onRelay,
}: {
	item: ReturnType<typeof useRoom>["timeline"][number];
	onRelay?: () => void;
}) {
	const isHuman = item.author === "human";
	const cls = isHuman
		? "room-bubble human"
		: item.author === "neo"
			? "room-bubble neo"
			: item.author === "rocket"
				? "room-bubble rocket"
				: "room-bubble system";
	const imgs = item.message.images ?? [];
	return (
		<div className={cls}>
			{!isHuman && <div className="room-bubble-author">{authorName(item.author as RoomAuthor)}</div>}
			<div className="room-bubble-body">
				<ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.text || (imgs.length ? t("room.imageOnly") : "")}</ReactMarkdown>
				{imgs.length > 0 && (
					<div className="room-bubble-images">
						{imgs.map((img, i) => (
							<img
								key={i}
								className="room-bubble-image"
								src={`data:${img.mimeType};base64,${img.data}`}
								alt="附件"
							/>
						))}
					</div>
				)}
			</div>
			{onRelay && (
				<button type="button" className="room-relay-btn" onClick={onRelay} title={t("room.relay")}>
					<Repeat2 size={13} />
					<span>{t("room.relay")}</span>
				</button>
			)}
		</div>
	);
}

function fileToImageContent(file: File): Promise<ImageContent> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			const commaIdx = dataUrl.indexOf(",");
			resolve({
				type: "image",
				mimeType: file.type || "image/png",
				data: commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl,
			});
		};
		reader.readAsDataURL(file);
	});
}