import type { ReactNode } from "react";

/**
 * The primitives every view is built from.
 *
 * Small on purpose. A design system that grows a bespoke component per screen
 * stops being a system, and the point of matching the docs site is that these are
 * the same shapes, not lookalikes.
 */

export const Panel = ({
	title,
	action,
	children,
	className = "",
	bodyClassName = "p-4",
}: {
	title?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}) => (
	<section className={`panel ${className}`}>
		{title !== undefined && (
			<header className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
				<h2 className="eyebrow">{title}</h2>
				{action}
			</header>
		)}
		<div className={bodyClassName}>{children}</div>
	</section>
);

export const Button = ({
	children,
	onClick,
	variant = "ghost",
	disabled,
	type = "button",
	className = "",
	title,
}: {
	children: ReactNode;
	onClick?: () => void;
	variant?: "primary" | "ghost" | "danger";
	disabled?: boolean;
	type?: "button" | "submit";
	className?: string;
	title?: string;
}) => {
	const base =
		"inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40";
	const styles = {
		primary: "bg-violet-200 text-zinc-950 hover:bg-white",
		ghost:
			"border border-white/[0.08] text-zinc-300 hover:border-white/20 hover:text-white hover:bg-white/[0.04]",
		danger: "border border-rose-400/25 text-rose-300 hover:bg-rose-400/10",
	}[variant];
	return (
		<button
			type={type}
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={`${base} ${styles} ${className}`}
		>
			{children}
		</button>
	);
};

export const Field = ({
	label,
	hint,
	children,
	className = "",
}: {
	label: string;
	hint?: string;
	children: ReactNode;
	className?: string;
}) => (
	<label className={`flex flex-col gap-1.5 ${className}`}>
		<span className="eyebrow">{label}</span>
		{children}
		{hint && (
			<span className="text-[11px] leading-4 text-zinc-600">{hint}</span>
		)}
	</label>
);

export const inputClass =
	"w-full rounded-lg border border-white/[0.08] bg-black/40 px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-violet-300/40 focus:outline-none";

/** A status dot plus a word. Colour alone never carries the meaning. */
export const StatusDot = ({
	status,
	className = "",
}: { status: string; className?: string }) => {
	const colour =
		status === "ok" || status === "passed"
			? "bg-emerald-400"
			: status === "error" || status === "failed"
				? "bg-rose-400"
				: status === "interrupted"
					? "bg-amber-400"
					: "bg-zinc-600";
	return (
		<span
			aria-hidden
			className={`inline-block size-1.5 shrink-0 rounded-full ${colour} ${className}`}
		/>
	);
};

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "good";

/**
 * How a run's outcome should read, in one place.
 *
 * A trace's status was `error` or nothing, which quietly painted every unfinished
 * run green: a turn that was still going, and a turn whose process was killed, both
 * fell through to "good". `interrupted` is now its own status, and it is amber
 * rather than red on purpose — nothing reported a failure, so it should not read
 * as one.
 */
export const traceTone = (status: string): BadgeTone =>
	status === "ok" || status === "passed"
		? "good"
		: status === "error" || status === "failed"
			? "danger"
			: status === "interrupted"
				? "warn"
				: "neutral";

export const Badge = ({
	children,
	tone = "neutral",
	title,
}: {
	children: ReactNode;
	tone?: BadgeTone;
	title?: string;
}) => {
	const styles = {
		neutral: "border-white/[0.08] text-zinc-500",
		accent: "border-violet-300/25 bg-violet-300/[0.06] text-violet-200",
		warn: "border-amber-300/25 bg-amber-300/[0.06] text-amber-200",
		danger: "border-rose-400/25 bg-rose-400/[0.06] text-rose-300",
		good: "border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-300",
	}[tone];
	return (
		<span
			title={title}
			className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] ${styles}`}
		>
			{children}
		</span>
	);
};

export const Empty = ({ title, hint }: { title: string; hint?: string }) => (
	<div className="flex flex-col items-center gap-1.5 px-4 py-12 text-center">
		<p className="text-xs text-zinc-400">{title}</p>
		{hint && (
			<p className="max-w-md text-[11px] leading-5 text-zinc-600">{hint}</p>
		)}
	</div>
);

export const ErrorNote = ({
	error,
	onRetry,
}: { error: string; onRetry?: () => void }) => (
	<div className="flex items-start gap-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-4">
		<div className="flex-1">
			<p className="eyebrow text-rose-300/80">request failed</p>
			<p className="mt-1.5 text-xs leading-5 text-rose-100/90">{error}</p>
		</div>
		{onRetry && (
			<Button onClick={onRetry} variant="ghost">
				retry
			</Button>
		)}
	</div>
);

/**
 * A sparkline.
 *
 * Hand-drawn as an SVG path rather than pulled from a charting library: this is one
 * polyline, and a dependency that ships 150 kB to render it would be a strange
 * thing for a debugging tool to install on someone's machine.
 */
export const Sparkline = ({
	values,
	width = 120,
	height = 28,
	className = "text-violet-300",
	fill = true,
}: {
	values: number[];
	width?: number;
	height?: number;
	className?: string;
	fill?: boolean;
}) => {
	if (values.length < 2)
		return <div style={{ width, height }} className={className} />;
	const max = Math.max(...values, 1);
	const min = Math.min(...values, 0);
	const span = max - min || 1;
	const step = width / (values.length - 1);
	const points = values.map((value, index) => {
		const x = index * step;
		const y = height - ((value - min) / span) * (height - 2) - 1;
		return [x, y] as const;
	});
	const line = points
		.map(
			([x, y], index) =>
				`${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`,
		)
		.join(" ");
	const area = `${line} L${width},${height} L0,${height} Z`;
	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			className={className}
			aria-hidden
		>
			{fill && <path d={area} fill="currentColor" opacity={0.12} />}
			<path
				d={line}
				fill="none"
				stroke="currentColor"
				strokeWidth={1.25}
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
			{(() => {
				const [lastX, lastY] = points[points.length - 1]!;
				return <circle cx={lastX} cy={lastY} r={1.75} fill="currentColor" />;
			})()}
		</svg>
	);
};

/**
 * A stat tile: figure, label, trend.
 *
 * The delta is coloured against nothing in particular — there is no baseline to
 * compare to, so a green "up" arrow would be claiming something untrue. It shows
 * the previous window and lets the reader judge.
 */
export const Stat = ({
	label,
	value,
	spark,
	detail,
	tone = "default",
}: {
	label: string;
	value: string;
	spark?: number[];
	detail?: string;
	tone?: "default" | "warn" | "danger";
}) => (
	<div className="panel px-4 py-3.5">
		<p className="eyebrow">{label}</p>
		<p
			className={`num mt-2 text-2xl leading-none font-medium tracking-tight ${
				tone === "danger"
					? "text-rose-300"
					: tone === "warn"
						? "text-amber-300"
						: "text-zinc-100"
			}`}
		>
			{value}
		</p>
		<div className="mt-2.5 flex items-end justify-between gap-3">
			{detail ? (
				<p className="text-[11px] leading-4 text-zinc-600">{detail}</p>
			) : (
				<span />
			)}
			{spark && <Sparkline values={spark} />}
		</div>
	</div>
);

/** A distribution as a row of buckets — the shape scores actually arrive in. */
export const Histogram = ({
	bins,
	height = 56,
	highlight,
}: {
	bins: number[];
	height?: number;
	highlight?: number;
}) => {
	const max = Math.max(...bins, 1);
	return (
		<div className="flex items-end gap-[3px]" style={{ height }}>
			{bins.map((count, index) => {
				const centre = bins.length > 1 ? index / (bins.length - 1) : 1;
				const near =
					highlight === undefined ||
					Math.abs(centre - highlight) < 0.5 / bins.length;
				return (
					<div
						key={index}
						className={`flex-1 rounded-t-[2px] transition-all ${near ? "bg-violet-300/70" : "bg-zinc-700/50"}`}
						style={{ height: `${Math.max(2, (count / max) * height)}px` }}
						title={`${count} run${count === 1 ? "" : "s"}`}
					/>
				);
			})}
		</div>
	);
};
