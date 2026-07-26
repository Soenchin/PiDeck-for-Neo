import { useRef } from "react";
import type { PetAggregateState } from "@shared/types";

/**
 * PetInteraction —— 拖拽 / 单击跳转 Agent / 双击逗弄。
 * 位移 < 3px 视为点击；两次 click 间隔 < 300ms 视为双击。
 */

const CLICK = 3, DBL_MS = 300;

type Props = { state: PetAggregateState; onDragStateChange?: (d: boolean) => void };

export function PetInteraction({ state, onDragStateChange }: Props) {
	/** 当前鼠标屏幕坐标；拖拽使用绝对位置，不再发送 dx/dy 增量。 */
	const lastScreen = useRef<{ x: number; y: number } | null>(null);
	/** 起始鼠标屏幕坐标，用于计算窗口目标位置和判断点击/拖拽。 */
	const startScreen = useRef<{ x: number; y: number } | null>(null);
	/** 主进程原子确认的窗口起点与拖拽会话令牌。 */
	const dragOrigin = useRef<{ x: number; y: number; token: number } | null>(null);
	const dragPending = useRef(false);
	const moveFrame = useRef<number | null>(null);
	const moved = useRef(0);
	const lastTap = useRef(0);
	const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const menu = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (state.mode === "hidden") return;
		void window.piDesktop.pet.contextMenu();
	};

	/** 每帧最多发一个绝对位置，避免高频 pointermove 堵住 IPC；只发送最新鼠标位置。 */
	const flushMove = () => {
		moveFrame.current = null;
		const origin = dragOrigin.current;
		const pointer = lastScreen.current;
		const start = startScreen.current;
		if (!origin || !pointer || !start || !dragPending.current) return;
		window.piDesktop.pet.moveTo({
			x: origin.x + pointer.x - start.x,
			y: origin.y + pointer.y - start.y,
			token: origin.token,
		});
	};

	const scheduleMove = () => {
		if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(flushMove);
	};

	const down = (e: React.PointerEvent) => {
		if (state.mode === "hidden" || e.button !== 0) return;
		lastScreen.current = { x: e.screenX, y: e.screenY };
		startScreen.current = { x: e.screenX, y: e.screenY };
		dragOrigin.current = null;
		dragPending.current = true;
		moved.current = 0;
		onDragStateChange?.(true);
		// 原子暂停巡游并读取主进程中的窗口起点。不能在 Renderer 自己猜窗口坐标，
		// 否则透明窗口合成延迟会让旧的增量重复叠加，表现为反向移动或飞远。
		void window.piDesktop.pet.startDrag().then((origin) => {
			if (!dragPending.current || !startScreen.current) return;
			dragOrigin.current = origin;
			scheduleMove();
		});
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
	};

	const move = (e: React.PointerEvent) => {
		if (!lastScreen.current || !startScreen.current) return;
		lastScreen.current = { x: e.screenX, y: e.screenY };
		moved.current = Math.max(moved.current, Math.abs(e.screenX - startScreen.current.x) + Math.abs(e.screenY - startScreen.current.y));
		if (!dragOrigin.current) return; // startDrag 尚未返回；返回时会补发最新鼠标位置
		scheduleMove();
	};

	const up = (e: React.PointerEvent) => {
		// pointercancel 的 button 通常是 -1，但它同样必须收口拖拽会话，
		// 否则失焦/系统手势后旧拖拽令牌会继续接收位置消息。
		if (e.type !== "pointercancel" && e.button !== 0) return; // 仅处理主按钮（左键），右键不触发点击/焦点
		if (moveFrame.current !== null) {
			cancelAnimationFrame(moveFrame.current);
			moveFrame.current = null;
		}
		lastScreen.current = null;
		startScreen.current = null;
		dragOrigin.current = null;
		dragPending.current = false;
		onDragStateChange?.(false);
		// 拖拽结束：让迟到的绝对位置消息失效；主进程会在 idle 时恢复巡游。
		void window.piDesktop.pet.setDragging(false);
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);

		if (moved.current < CLICK) {
			const now = Date.now();
			if (now - lastTap.current < DBL_MS) {
				lastTap.current = 0;
				if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
				void window.piDesktop.pet.tease();
				return;
			}
			lastTap.current = now;
			if (tapTimer.current) clearTimeout(tapTimer.current);
			tapTimer.current = setTimeout(() => { tapTimer.current = null; void window.piDesktop.pet.focusAgent(); }, DBL_MS);
		}
	};

	return <div style={{ position: "absolute", inset: 0, cursor: "grab", touchAction: "none" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={menu} />;
}
