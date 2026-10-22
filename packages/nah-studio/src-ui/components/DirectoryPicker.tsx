import { useEffect, useMemo, useRef, useState } from "react";

import { groupAgentsByDirectory } from "../lib/agents";
import { useStudio } from "../store";

/**
 * The directory scope, in the header.
 *
 * A directory is the unit a person thinks in: an agent is named after the
 * project it was working in, so a list of agents is a list of directory names
 * with the repeats still in it. Choosing a directory is choosing a place, and
 * every number on the screen then belongs to that place — all of its agents
 * together, not one agent inside it.
 *
 * On every view rather than only the overview, because the number you are
 * reading is the number for whatever this says — and a filter that only exists
 * on the screen you set it from is a filter you forget about.
 */
export const DirectoryPicker = () => {
	const { agents, selectedDirectory, setSelectedDirectory } = useStudio();
	const [open, setOpen] = useState(false);
	const container = useRef<HTMLDivElement>(null);

	const groups = useMemo(() => groupAgentsByDirectory(agents), [agents]);
	const selected = groups.find((group) => group.path === selectedDirectory);

	// Close on anything outside, or on escape: a menu left open behind you is a
	// menu you have to hunt for.
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!container.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (agents.length === 0) return null;

	return (
		<div className="relative" ref={container}>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-haspopup="true"
				aria-expanded={open}
				className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-black/40 px-2 py-1 font-mono text-[11px] text-zinc-300 transition hover:border-white/20 hover:text-white focus:border-violet-300/40 focus:outline-none"
			>
				<span className="eyebrow text-zinc-600">directory</span>
				<span className="max-w-[13rem] truncate">
					{selected ? selected.name : "all directories"}
				</span>
				<span aria-hidden className="text-zinc-600">
					▾
				</span>
			</button>

			{open && (
				<div className="panel-flat absolute right-0 z-40 mt-1.5 w-[min(22rem,calc(100vw-2rem))] p-1.5 shadow-2xl">
					<div className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 hover:bg-white/[0.04]">
						<button
							type="button"
							onClick={() => {
								setSelectedDirectory(null);
								setOpen(false);
							}}
							className="flex-1 text-left text-xs text-zinc-200"
						>
							all directories
						</button>
						<span className="eyebrow shrink-0">{agents.length}</span>
					</div>

					<div className="mt-1 border-t border-white/[0.06] px-1.5 pt-2">
						<p className="eyebrow mb-1">directories</p>
						{groups.length === 0 ? (
							<p className="px-1 py-2 text-[11px] text-zinc-600">
								No agents have reported a directory yet.
							</p>
						) : (
							<div className="max-h-72 overflow-y-auto">
								{groups.map((group) => (
									<button
										key={group.path}
										type="button"
										onClick={() => {
											setSelectedDirectory(group.path);
											setOpen(false);
										}}
										className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-white/[0.04] ${group.path === selectedDirectory ? "bg-white/[0.05]" : ""}`}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-xs text-zinc-100">
												{group.name}
											</span>
											<span
												className="block truncate font-mono text-[10px] text-zinc-600"
												title={group.path}
											>
												{group.path}
											</span>
										</span>
										<span className="eyebrow shrink-0">
											{group.agents.length}{" "}
											{group.agents.length === 1 ? "agent" : "agents"}
										</span>
										{group.running > 0 && (
											<span
												className="size-1.5 shrink-0 rounded-full bg-emerald-400"
												aria-hidden
											/>
										)}
									</button>
								))}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
};
