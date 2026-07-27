/**
 * Neo × ROCKET 房间状态 Hook。
 *
 * 不在主进程维护消息文本：渲染层订阅既有的 agents.onMessages，按两人 agentId 过滤，
 * 合并成一条共享时间线。双人 user 消息（@两人时）按内容+时间近邻去重显示为一条"主人"气泡。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTab, AvailableModel, ChatMessage } from "../../../shared/types";
import type {
	RoomSendTarget,
	RoomState,
	RoomParticipant,
	RoomSetModelInput,
} from "../../../shared/room";
import {
	filterRoomTimelineAfter,
	sortRoomTimelineStable,
	toRoomTimelineItems,
} from "./roomTimeline";

export type RoomAuthor = "human" | "neo" | "rocket" | "system";

export interface RoomTimelineItem {
	/** 消息 id；去重后的用户气泡使用合成 id。 */
	id: string;
	author: RoomAuthor;
	/** 该条消息来自哪个参与者（human 气泡为 null，方便渲染头像/对齐）。 */
	participant: RoomParticipant | null;
	message: ChatMessage;
}

/** @两人投递时，同一句话会分别出现在两个 Session 中；近邻时间窗内同文本视为同一条。 */
const DEDUP_WINDOW_MS = 6000;

export interface UseRoomResult {
	state: RoomState;
	neoAgentId?: string;
	rocketAgentId?: string;
	neoStatus?: string;
	rocketStatus?: string;
	neoContextPercent?: number | null;
	rocketContextPercent?: number | null;
	timeline: RoomTimelineItem[];
	/** 任一参与者正在生成。 */
	busy: boolean;
	ready: boolean;
	/** 各参与者当前选中的供应商与模型 id。 */
	neoProvider?: string;
	rocketProvider?: string;
	neoModelId?: string;
	rocketModelId?: string;
	neoModels: AvailableModel[];
	rocketModels: AvailableModel[];
	send: (
		target: RoomSendTarget,
		message: string,
		images?: ChatMessage["images"],
		contextMessage?: string,
	) => Promise<void>;
	abort: (participant?: RoomParticipant) => Promise<void>;
	stop: (participant?: RoomParticipant) => Promise<void>;
	clear: () => Promise<void>;
	newTable: () => Promise<void>;
	setModel: (input: RoomSetModelInput) => Promise<void>;
	refresh: () => Promise<void>;
}

export function useRoom(): UseRoomResult {
	const [state, setState] = useState<RoomState>({ status: "idle" });
	const [neoMessages, setNeoMessages] = useState<ChatMessage[]>([]);
	const [rocketMessages, setRocketMessages] = useState<ChatMessage[]>([]);
	const [neoStatus, setNeoStatus] = useState<string | undefined>();
	const [rocketStatus, setRocketStatus] = useState<string | undefined>();
	const [neoContextPercent, setNeoContextPercent] = useState<number | null>();
	const [rocketContextPercent, setRocketContextPercent] = useState<number | null>();
	const [neoModels, setNeoModels] = useState<AvailableModel[]>([]);
	const [rocketModels, setRocketModels] = useState<AvailableModel[]>([]);
	const [neoProvider, setNeoProvider] = useState<string>();
	const [rocketProvider, setRocketProvider] = useState<string>();
	const [neoModelId, setNeoModelId] = useState<string>();
	const [rocketModelId, setRocketModelId] = useState<string>();
	const stateRef = useRef(state);
	/** 每条房间消息第一次出现时的排序锚点；流式更新只改内容，不允许改变座位。 */
	const timelineOrderAnchorsRef = useRef(new Map<string, number>());
	stateRef.current = state;

	const refresh = useCallback(async () => {
		try {
			const s = await window.piDesktop.room.getState();
			setState(s);
			// getState 会按需 provisioning；紧接着读取快照，避免历史加载事件早于订阅建立而丢失。
			const snapshot = await window.piDesktop.room.getMessages();
			setNeoMessages(snapshot.neo);
			setRocketMessages(snapshot.rocket);
		} catch (error) {
			console.error("[room] getState failed", error);
		}
	}, []);

	// 订阅房间状态推送。
	useEffect(() => {
		const off = window.piDesktop.room.onState((next) => setState(next));
		// 挂载即拉一次，触发主进程 provisioning。
		void refresh();
		return off;
	}, [refresh]);

	const neoAgentId = state.neoAgentId;
	const rocketAgentId = state.rocketAgentId;

	// Agent 就绪后拉取各自可选模型与 runtime state（含当前 modelId），
	// 给房间面板的模型 chip 用。模型不需频繁刷新，进入房间拉一次即可。
	useEffect(() => {
		if (!neoAgentId) return;
		let off = false;
		void Promise.all([
			window.piDesktop.agents.availableModels(neoAgentId),
			window.piDesktop.agents.runtimeState(neoAgentId),
		]).then(([models, rs]) => {
			if (off) return;
			setNeoModels(models);
			setNeoProvider(rs.provider);
			setNeoModelId(rs.modelId);
			setNeoContextPercent(rs.contextPercent);
		}).catch(() => undefined);
		return () => { off = true; };
	}, [neoAgentId]);
	useEffect(() => {
		if (!rocketAgentId) return;
		let off = false;
		void Promise.all([
			window.piDesktop.agents.availableModels(rocketAgentId),
			window.piDesktop.agents.runtimeState(rocketAgentId),
		]).then(([models, rs]) => {
			if (off) return;
			setRocketModels(models);
			setRocketProvider(rs.provider);
			setRocketModelId(rs.modelId);
			setRocketContextPercent(rs.contextPercent);
		}).catch(() => undefined);
		return () => { off = true; };
	}, [rocketAgentId]);

	// 订阅两人消息流：既有的 agents.onMessages 全量推送某 agent 的消息，按 agentId 过滤即可。
	useEffect(() => {
		const off = window.piDesktop.agents.onMessages(({ agentId, messages }) => {
			if (agentId === neoAgentId) setNeoMessages(messages);
			else if (agentId === rocketAgentId) setRocketMessages(messages);
		});
		return off;
	}, [neoAgentId, rocketAgentId]);

	// 订阅全局 AgentTab[] 状态，按两人 agentId 过滤出实时 status（更细粒度于 room state 推送）。
	useEffect(() => {
		const off = window.piDesktop.agents.onState((tabs: AgentTab[]) => {
			const neo = tabs.find((t) => t.id === neoAgentId);
			const rocket = tabs.find((t) => t.id === rocketAgentId);
			setNeoStatus(neo?.status);
			setRocketStatus(rocket?.status);
		});
		return off;
	}, [neoAgentId, rocketAgentId]);

	// 每次某位 Agent 回到 idle 后刷新其上下文占用；运行中不轮询，避免流式输出期间制造 IPC 噪音。
	useEffect(() => {
		if (!neoAgentId || neoStatus !== "idle") return;
		void window.piDesktop.agents.runtimeState(neoAgentId)
			.then((rs) => setNeoContextPercent(rs.contextPercent))
			.catch(() => undefined);
	}, [neoAgentId, neoStatus]);
	useEffect(() => {
		if (!rocketAgentId || rocketStatus !== "idle") return;
		void window.piDesktop.agents.runtimeState(rocketAgentId)
			.then((rs) => setRocketContextPercent(rs.contextPercent))
			.catch(() => undefined);
	}, [rocketAgentId, rocketStatus]);

	// 合并时间线 + 去重 双投递用户气泡。
	const timeline = useMemo<RoomTimelineItem[]>(() => {
		const combined = sortRoomTimelineStable(
			filterRoomTimelineAfter(
				[
					...toRoomTimelineItems(neoMessages, "neo"),
					...toRoomTimelineItems(rocketMessages, "rocket"),
				],
				state.timelineClearedAt,
			),
			timelineOrderAnchorsRef.current,
		);
		// 去重：相邻（按时间序）的 human 气泡，若文本完全一致且时间差在窗内，保留第一条。
		const out: RoomTimelineItem[] = [];
		for (const item of combined) {
			if (item.author === "human") {
				const prev = out[out.length - 1];
				if (
					prev &&
					prev.author === "human" &&
					prev.message.text === item.message.text &&
					Math.abs(prev.message.timestamp - item.message.timestamp) <= DEDUP_WINDOW_MS
				) {
					// 同一条主人消息，跳过重复。
					continue;
				}
			}
			out.push(item);
		}
		return out;
	}, [neoMessages, rocketMessages, state.timelineClearedAt]);

	const busy =
		neoStatus === "running" || rocketStatus === "running" ||
		state.neoStatus === "running" || state.rocketStatus === "running";
	const ready = state.status === "ready" && Boolean(neoAgentId) && Boolean(rocketAgentId);

	const send = useCallback(
		async (
			target: RoomSendTarget,
			message: string,
			images?: ChatMessage["images"],
			contextMessage?: string,
		) => {
			if (!message.trim() && !images?.length) return;
			await window.piDesktop.room.send({ target, message, images, contextMessage });
		},
		[],
	);

	const abort = useCallback(async (participant?: RoomParticipant) => {
		await window.piDesktop.room.abort(participant ? { participant } : undefined);
	}, []);
	const stop = useCallback(async (participant?: RoomParticipant) => {
		await window.piDesktop.room.stop(participant ? { participant } : undefined);
	}, []);
	const clear = useCallback(async () => {
		const result = await window.piDesktop.room.clear();
		timelineOrderAnchorsRef.current.clear();
		setState((current) => ({ ...current, timelineClearedAt: result.timelineClearedAt }));
	}, []);
	const newTable = useCallback(async () => {
		const nextState = await window.piDesktop.room.newTable();
		timelineOrderAnchorsRef.current.clear();
		setNeoMessages([]);
		setRocketMessages([]);
		setState(nextState);
	}, []);
	const setModel = useCallback(async (input: RoomSetModelInput) => {
		await window.piDesktop.room.setModel(input);
		if (input.participant === "neo") {
			setNeoProvider(input.provider);
			setNeoModelId(input.modelId);
		} else {
			setRocketProvider(input.provider);
			setRocketModelId(input.modelId);
		}
	}, []);

	return {
		state,
		neoAgentId,
		rocketAgentId,
		neoStatus,
		rocketStatus,
		neoContextPercent,
		rocketContextPercent,
		timeline,
		busy,
		ready,
		neoProvider,
		rocketProvider,
		neoModelId,
		rocketModelId,
		neoModels,
		rocketModels,
		send,
		abort,
		stop,
		clear,
		newTable,
		setModel,
		refresh,
	};
}