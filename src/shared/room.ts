/**
 * Neo × ROCKET 双 Agent 房间共享类型与 IPC 通道。
 *
 * 设计约束：
 * - Neo 房间 agent 复用真实 Neo（全局 APPEND_SYSTEM.md 人设 + Houkai 记忆桥接）。
 * - ROCKET 房间 agent 走独立 agentDir，不加载 Neo 人设、不加载 Houkai 扩展，
 *   人设来自其项目 cwd 下的 CLAUDE.md，记忆走项目自带 memory/ 目录。
 * - 两人在主进程是两个独立 pi --mode rpc 进程，共享时间线由渲染层合并。
 */
import type { AgentStatus, ChatMessage, ImageContent } from "./types";

/** 房间参与者身份。固定只有 Neo 与 ROCKET 两人。 */
export type RoomParticipant = "neo" | "rocket";

/** 发送目标。@两人 会按顺序分别投递给两个独立 Session。 */
export type RoomSendTarget = "neo" | "rocket" | "both";

/** 房间持久化配置，落盘到 userData/room-config.json。 */
export interface RoomConfig {
  /** Neo 房间独立项目的 PiDeck Project id（隐藏项目）。 */
  neoProjectId: string;
  /** ROCKET 房间项目的 PiDeck Project id（隐藏项目，path 指向 X:/CC/projects/ROCKET）。 */
  rocketProjectId: string;
  /** Neo 房间 agent 的 cwd，一个干净的聊天工作区目录。 */
  neoWorkspacePath: string;
  /** ROCKET 项目路径固定为 X:/CC/projects/ROCKET。 */
  rocketProjectPath: string;
  /** ROCKET 独立 agentDir，用于彻底隔离 Neo 人设与 Houkai 扩展。 */
  rocketAgentDir: string;
  /** Neo 权威本地记忆路径；Neo 同时允许访问 Houkai。 */
  neoMemoryPath: string;
  /** ROCKET 唯一允许使用的记忆路径；ROCKET 严禁访问 Houkai。 */
  rocketMemoryPath: string;
  /** 已创建的 Neo 房间 agent id（运行期，重启后可能变化）。 */
  neoAgentId?: string;
  /** 已创建的 ROCKET 房间 agent id。 */
  rocketAgentId?: string;
  /** Neo 房间持久化 session 文件路径，跨重启恢复。 */
  neoSessionPath?: string;
  /** ROCKET 房间持久化 session 文件路径。 */
  rocketSessionPath?: string;
  /** 可选：Neo 房间模型偏好。 */
  neoModel?: { provider: string; modelId: string };
  /** 可选：ROCKET 房间模型偏好。 */
  rocketModel?: { provider: string; modelId: string };
  /** 纯 UI 清屏边界；此时间之前的消息不再显示，但仍保留在两边 Session 上下文中。 */
  timelineClearedAt?: number;
  createdAt: number;
}

/** 房间运行状态，由主进程推送给渲染层。 */
export interface RoomState {
  status: "idle" | "provisioning" | "ready" | "error";
  neoAgentId?: string;
  rocketAgentId?: string;
  neoStatus?: AgentStatus;
  rocketStatus?: AgentStatus;
  /** 与 RoomConfig 同步的持久化清屏边界。 */
  timelineClearedAt?: number;
  error?: string;
}

/** 房间发送消息入参。 */
export interface RoomSendInput {
  target: RoomSendTarget;
  /** 房间时间线与 Agent 自身 UI 历史中显示的用户文本。 */
  message: string;
  /**
   * 可选内部上下文：真正发给 Agent 的内容。用于「让另一位接话」等操作，
   * 避免把上一位 AI 的整段原话重复显示成主人气泡。
   */
  contextMessage?: string;
  images?: ImageContent[];
}

/** 房间停止入参。 */
export interface RoomStopInput {
  /** 不传则同时停止两人。 */
  participant?: RoomParticipant;
}

/** 房间切模型入参。 */
export interface RoomSetModelInput {
  participant: RoomParticipant;
  provider: string;
  modelId: string;
}

/** 清屏后返回的新边界，用于渲染层立即裁剪时间线。 */
export interface RoomClearResult {
  timelineClearedAt: number;
}

/** 进入房间时一次性读取的两边消息快照，补偿 IPC 订阅建立前已完成的历史加载事件。 */
export interface RoomMessagesSnapshot {
  neo: ChatMessage[];
  rocket: ChatMessage[];
}