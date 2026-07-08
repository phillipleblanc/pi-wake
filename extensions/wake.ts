import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

const CUSTOM_TYPE = "wake";
const DEFAULT_MESSAGE = "continue";
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const FOOTER_REFRESH_MS = 10_000;

type WakeSource = "command" | "tool" | "restore";

interface WakeJob {
	id: string;
	key: string;
	message: string;
	duration: string;
	scheduledAt: number;
	dueAt: number;
	source: WakeSource;
	timeout?: ReturnType<typeof setTimeout>;
}

interface WakeEntryData {
	version: 1;
	action: "schedule" | "fired" | "cancel" | "clear";
	id?: string;
	key?: string;
	message?: string;
	duration?: string;
	scheduledAt?: number;
	dueAt?: number;
	source?: WakeSource;
	replacedId?: string;
	firedAt?: number;
	cancelledAt?: number;
}

interface ScheduleResult {
	job: WakeJob;
	replaced?: WakeJob;
}

const stripMatchingQuotes = (value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1).trim();
		}
	}
	return trimmed;
};

const normalizeMessage = (message?: string): string => {
	const normalized = stripMatchingQuotes(message ?? "").replace(/\s+/g, " ").trim();
	return normalized || DEFAULT_MESSAGE;
};

const keyForMessage = (message: string): string => message;

const parseDurationMs = (input: string): number => {
	const compact = input.trim().toLowerCase().replace(/\s+/g, "");
	if (!compact) throw new Error("Duration is required (examples: 30s, 2m, 1h30m).");

	const unitMs: Record<string, number> = {
		ms: 1,
		s: 1_000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};

	const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
	let total = 0;
	let index = 0;
	let matched = false;
	let match: RegExpExecArray | null;

	while ((match = re.exec(compact)) !== null) {
		if (match.index !== index) {
			throw new Error(`Invalid duration "${input}". Use units like 30s, 2m, 1h30m, or 1h30s.`);
		}

		matched = true;
		const amount = Number(match[1]);
		if (!Number.isFinite(amount) || amount < 0) {
			throw new Error(`Invalid duration amount "${match[1]}".`);
		}
		total += amount * unitMs[match[2]];
		index = re.lastIndex;
	}

	if (!matched || index !== compact.length) {
		throw new Error(`Invalid duration "${input}". Use units like 30s, 2m, 1h30m, or 1h30s.`);
	}
	if (!Number.isFinite(total) || total <= 0) {
		throw new Error("Duration must be greater than zero.");
	}

	return Math.ceil(total);
};

const formatDuration = (ms: number): string => {
	let remaining = Math.max(0, Math.round(ms));
	if (remaining < 1_000) return `${remaining}ms`;

	const days = Math.floor(remaining / 86_400_000);
	remaining %= 86_400_000;
	const hours = Math.floor(remaining / 3_600_000);
	remaining %= 3_600_000;
	const minutes = Math.floor(remaining / 60_000);
	remaining %= 60_000;
	const seconds = Math.ceil(remaining / 1_000);

	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (seconds) parts.push(`${seconds}s`);
	return parts.join(" ") || "0s";
};

const sanitizeStatusText = (text: string): string => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

const formatTokens = (count: number): string => {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

const formatCwdForFooter = (cwd: string, home?: string): string => {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
};

const parseWakeArgs = (args: string): { duration: string; message?: string } => {
	const trimmed = args.trim();
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const durationParts: string[] = [];

	for (const token of tokens) {
		try {
			parseDurationMs(token);
			durationParts.push(token);
		} catch {
			break;
		}
	}

	if (durationParts.length === 0) throw new Error("Usage: /wake <duration> [message]");

	const duration = durationParts.join("");
	const message = tokens.slice(durationParts.length).join(" ");
	return { duration, message: message || undefined };
};

const formatDueTime = (dueAt: number): string => new Date(dueAt).toLocaleTimeString();

const formatJob = (job: WakeJob, now = Date.now()): string =>
	`in ${formatDuration(job.dueAt - now)} (${formatDueTime(job.dueAt)}) — ${JSON.stringify(job.message)}`;

const makeJobId = (): string => randomUUID().slice(0, 8);

export default function (pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	const jobs = new Map<string, WakeJob>();

	const clearTimer = (job: WakeJob) => {
		if (job.timeout) {
			clearTimeout(job.timeout);
			job.timeout = undefined;
		}
	};

	const clearTimers = () => {
		for (const job of jobs.values()) clearTimer(job);
	};

	const requestWakeFooterRender = (ctx = currentCtx) => {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("wake", undefined); // Clear status-line output from older extension versions.
		requestFooterRender?.();
	};

	const getNextWake = (): WakeJob | undefined => [...jobs.values()].sort((a, b) => a.dueAt - b.dueAt)[0];

	const getWakeFooterText = (): string | undefined => {
		const next = getNextWake();
		if (!next) return undefined;
		return `next wake: ${formatDuration(next.dueAt - Date.now())}`;
	};

	const installWakeFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("wake", undefined);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const rerender = () => tui.requestRender();
			requestFooterRender = rerender;

			const unsubscribeBranch = footerData.onBranchChange(rerender);
			const interval = setInterval(() => {
				if (jobs.size > 0) rerender();
			}, FOOTER_REFRESH_MS);

			return {
				dispose() {
					clearInterval(interval);
					unsubscribeBranch();
					if (requestFooterRender === rerender) requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const message = entry.message as AssistantMessage;
						const usage = message.usage;
						if (!usage) continue;

						totalInput += usage.input ?? 0;
						totalOutput += usage.output ?? 0;
						totalCacheRead += usage.cacheRead ?? 0;
						totalCacheWrite += usage.cacheWrite ?? 0;
						totalCost += usage.cost?.total ?? 0;

						const latestPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
						latestCacheHitRate = latestPromptTokens > 0 ? ((usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}

					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					const autoIndicator = " (auto)";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					let contextPercentStr: string;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					} else {
						contextPercentStr = contextPercentDisplay;
					}
					const wakeFooterText = getWakeFooterText();
					statsParts.push(wakeFooterText ? `${contextPercentStr} • ${wakeFooterText}` : contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel() || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}

					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) rightSide = rightSideWithoutProvider;
					}

					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
					let statsLine: string;
					if (totalNeeded <= width) {
						statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = [...extensionStatuses.entries()]
							.filter(([key]) => key !== "wake")
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	};

	const findJobById = (id: string): WakeJob | undefined => {
		for (const job of jobs.values()) {
			if (job.id === id) return job;
		}
		return undefined;
	};

	const fireJob = (id: string) => {
		const job = findJobById(id);
		if (!job) return;

		clearTimer(job);
		jobs.delete(job.key);
		requestWakeFooterRender();

		try {
			if (currentCtx?.hasUI) {
				currentCtx.ui.notify(`Wake: ${job.message}`, "info");
			}

			if (currentCtx?.isIdle()) {
				pi.sendUserMessage(job.message);
			} else {
				pi.sendUserMessage(job.message, { deliverAs: "followUp" });
			}

			pi.appendEntry<WakeEntryData>(CUSTOM_TYPE, {
				version: 1,
				action: "fired",
				id: job.id,
				key: job.key,
				message: job.message,
				duration: job.duration,
				scheduledAt: job.scheduledAt,
				dueAt: job.dueAt,
				source: job.source,
				firedAt: Date.now(),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			currentCtx?.ui.notify(`Wake failed: ${message}`, "error");
		}
	};

	const armTimer = (job: WakeJob) => {
		clearTimer(job);
		const delay = job.dueAt - Date.now();
		const timeoutMs = Math.max(0, Math.min(delay, MAX_SET_TIMEOUT_MS));

		job.timeout = setTimeout(() => {
			const current = jobs.get(job.key);
			if (!current || current.id !== job.id) return;

			if (Date.now() >= job.dueAt) {
				fireJob(job.id);
			} else {
				armTimer(job);
			}
		}, timeoutMs);
	};

	const scheduleWake = (duration: string, messageInput: string | undefined, source: WakeSource, ctx?: ExtensionContext): ScheduleResult => {
		const delayMs = parseDurationMs(duration);
		const message = normalizeMessage(messageInput);
		const key = keyForMessage(message);
		const scheduledAt = Date.now();
		const dueAt = scheduledAt + delayMs;
		const replaced = jobs.get(key);

		if (replaced) clearTimer(replaced);

		const job: WakeJob = {
			id: makeJobId(),
			key,
			message,
			duration,
			scheduledAt,
			dueAt,
			source,
		};

		jobs.set(key, job);
		armTimer(job);
		requestWakeFooterRender(ctx);

		pi.appendEntry<WakeEntryData>(CUSTOM_TYPE, {
			version: 1,
			action: "schedule",
			id: job.id,
			key: job.key,
			message: job.message,
			duration: job.duration,
			scheduledAt: job.scheduledAt,
			dueAt: job.dueAt,
			source,
			replacedId: replaced?.id,
		});

		return { job, replaced };
	};

	const cancelWake = (messageInput: string | undefined, ctx?: ExtensionContext): { cancelled?: WakeJob; message: string } => {
		const message = normalizeMessage(messageInput);
		const key = keyForMessage(message);
		const job = jobs.get(key);

		if (job) {
			clearTimer(job);
			jobs.delete(key);
			pi.appendEntry<WakeEntryData>(CUSTOM_TYPE, {
				version: 1,
				action: "cancel",
				id: job.id,
				key,
				message,
				cancelledAt: Date.now(),
			});
			requestWakeFooterRender(ctx);
		}

		return { cancelled: job, message };
	};

	const clearWakes = (ctx?: ExtensionContext): number => {
		const count = jobs.size;
		clearTimers();
		jobs.clear();
		pi.appendEntry<WakeEntryData>(CUSTOM_TYPE, {
			version: 1,
			action: "clear",
			cancelledAt: Date.now(),
		});
		requestWakeFooterRender(ctx);
		return count;
	};

	const reconstructFromSession = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		clearTimers();
		jobs.clear();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
			const data = entry.data as Partial<WakeEntryData> | undefined;
			if (!data || data.version !== 1) continue;

			if (data.action === "clear") {
				jobs.clear();
				continue;
			}

			if (data.action === "schedule") {
				if (
					typeof data.id !== "string" ||
					typeof data.key !== "string" ||
					typeof data.message !== "string" ||
					typeof data.duration !== "string" ||
					typeof data.scheduledAt !== "number" ||
					typeof data.dueAt !== "number"
				) {
					continue;
				}

				jobs.set(data.key, {
					id: data.id,
					key: data.key,
					message: data.message,
					duration: data.duration,
					scheduledAt: data.scheduledAt,
					dueAt: data.dueAt,
					source: data.source ?? "restore",
				});
				continue;
			}

			if (data.action === "cancel") {
				if (typeof data.key === "string") jobs.delete(data.key);
				continue;
			}

			if (data.action === "fired") {
				if (typeof data.key !== "string") continue;
				const current = jobs.get(data.key);
				if (current && (!data.id || current.id === data.id)) jobs.delete(data.key);
			}
		}

		for (const job of jobs.values()) armTimer(job);
		requestWakeFooterRender(ctx);
	};

	const activeWakeList = (): string => {
		if (jobs.size === 0) return "No wake jobs scheduled.";
		const now = Date.now();
		const lines = [...jobs.values()]
			.sort((a, b) => a.dueAt - b.dueAt)
			.map((job, index) => `${index + 1}. ${formatJob(job, now)}`);
		return `Active wake jobs:\n${lines.join("\n")}`;
	};

	const scheduleMessage = ({ job, replaced }: ScheduleResult): string => {
		const base = `Wake scheduled ${formatJob(job)}.`;
		if (!replaced) return base;
		return `${base} Replaced previous wake for ${JSON.stringify(job.message)} that was due ${formatJob(replaced)}.`;
	};

	pi.on("session_start", async (_event, ctx) => {
		installWakeFooter(ctx);
		reconstructFromSession(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => reconstructFromSession(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimers();
		jobs.clear();
		if (ctx.hasUI) {
			ctx.ui.setStatus("wake", undefined);
			ctx.ui.setFooter(undefined);
		}
		requestFooterRender = undefined;
		currentCtx = undefined;
	});

	pi.registerCommand("wake", {
		description: "Schedule a future message (usage: /wake <duration> [message])",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const trimmed = args.trim();

			try {
				if (!trimmed || trimmed === "list") {
					ctx.ui.notify(`${activeWakeList()}\n\nUsage: /wake <duration> [message]`, "info");
					return;
				}

				if (trimmed === "clear" || trimmed === "cancel all" || trimmed === "cancel --all") {
					const count = clearWakes(ctx);
					ctx.ui.notify(`Cancelled ${count} wake job(s).`, "info");
					return;
				}

				if (trimmed === "cancel" || trimmed.startsWith("cancel ")) {
					const message = trimmed === "cancel" ? undefined : trimmed.slice("cancel".length).trim();
					const result = cancelWake(message, ctx);
					if (result.cancelled) {
						ctx.ui.notify(`Cancelled wake for ${JSON.stringify(result.message)}.`, "info");
					} else {
						ctx.ui.notify(`No wake found for ${JSON.stringify(result.message)}.`, "warning");
					}
					return;
				}

				const parsed = parseWakeArgs(trimmed);
				const result = scheduleWake(parsed.duration, parsed.message, "command", ctx);
				ctx.ui.notify(scheduleMessage(result), result.replaced ? "warning" : "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerTool({
		name: "wake",
		label: "Wake",
		description:
			"Schedule a future user message in this pi session after a duration (examples: 30s, 2m, 1h30m). Defaults to sending \"continue\". Duplicate messages replace existing wake jobs for that message.",
		promptSnippet: "Schedule a future user message to continue or check a long-running background job without blocking the session.",
		promptGuidelines: [
			"Use wake when waiting for a long-running background job, such as a tmux build or test run, instead of calling bash with sleep.",
			"Use wake with a distinct message for each concurrent background job; scheduling wake with the same message replaces the previous wake for that message.",
		],
		parameters: Type.Object({
			duration: Type.String({ description: "How long to wait, e.g. 30s, 2m, 1h, 1h30m, or 1h30s." }),
			message: Type.Optional(
				Type.String({ description: "Message to send when the wake fires. Defaults to \"continue\"." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const result = scheduleWake(params.duration, params.message, "tool", ctx);
			return {
				content: [{ type: "text", text: scheduleMessage(result) }],
				details: {
					id: result.job.id,
					message: result.job.message,
					duration: result.job.duration,
					dueAt: result.job.dueAt,
					replacedId: result.replaced?.id,
				},
			};
		},
	});
}
