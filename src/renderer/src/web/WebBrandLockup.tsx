/**
 * WebBrandLockup — Web 端品牌区（与桌面 AppParts.BrandLockup 同视觉）。
 *
 * 不直接复用 AppParts.BrandLockup 是为了避免把桌面端整棵渲染组件树
 * （SurfaceComponents / atoms / desktopApi 等）拖进 Web 包；这里只用
 * 自包含的 Logo A 资产与字标，无任何桌面端依赖。
 */
import neonischAppMark from "../assets/images/neonisch-app-mark.svg";

export function WebBrandLockup() {
	return (
		<div className="brand-lockup flex h-9 min-w-0 items-center gap-2.5" aria-label="NeoNisch">
			<img
				src={neonischAppMark}
				alt=""
				draggable={false}
				className="brand-mark size-[26px] shrink-0"
			/>
			<span
				className="brand-wordmark translate-x-0.5 truncate text-[16px] font-semibold leading-none text-zinc-950 dark:text-white"
				aria-hidden="true"
			>
				NeoNisch
			</span>
		</div>
	);
}
