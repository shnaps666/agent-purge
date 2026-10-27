// 通道能力表：这家 harness 到底能不能用这条通道，不能用是为什么。
//
// 为什么要有这张表：UI 上给一个能点的开关、点了却什么都没发生，比不给开关更糟
// （实测踩过：zcode 是闭源桌面，双击启动根本不经过 PATH，裸命令接管对它永远无效）。
// 真相只有一处：矩阵（matrix.json）+ 持久化后端表（persist.mjs）+ /purge 支持表（slashes.mjs）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { targets as persistTargets } from "./persist.mjs";
import { resolveReal } from "./shim.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 通道存在、但本机没能真跑一次的（模型白名单 / 没有 CLI）：UI 标「文档」，不标「实测」 */
const NOT_LIVE_TESTED = new Set(["claude", "zcode"]);
const matrix = readMatrix();

function readMatrix() {
	try {
		return JSON.parse(readFileSync(join(ROOT, "matrix.json"), "utf8"));
	} catch (e) {
		throw new Error(`не удалось прочитать matrix.json: ${e.message}`);
	}
}

/** 有 /purge 机制的 harness —— **只算能把内容写进系统提示词的**（目前只有 pi） */
export const SLASH_IDS = new Set(["pi"]);
/** 有可写配置文件/插件的 harness（其余家只能点名启动或打补丁） */
export const PERSIST_IDS = new Set(Object.keys(persistTargets));
/** 能把内容真的送进 system 数组的层；user 层（上下文块/用户消息）一律不对外提供 */
const SYS_LAYER = "sys";
/** 被隐藏的落点叫什么（给 UI 写一行实话用）；只有“曾经真有过落点”的才写 */
const HIDDEN_LABEL = {
	claude: { install: "~/.claude/CLAUDE.md (блок <system-reminder>)", slash: "~/.claude/commands/purge.md" },
	codex: { slash: "~/.codex/prompts/purge.md" },
	opencode: { slash: "~/.opencode/command/purge.md" },
};

/** 桌面形态优先、终端只是附带的：双击启动绕开 PATH，shim 注定拦不到 */
const DESKTOP_FIRST = new Set(["zcode", "antigravity", "qoder", "workbuddy"]);

/** 人工核过的特例原因（写不出通用条件的那种） */const WHY = {
	antigravity: {
		shim: "десктопная версия запускается как бинарник, путь через PATH не перехватить; только маршрут binary patch",
		install: "только бинарный патч (notes/), конфига для записи нет",
	},
	qoder: { shim: "промпт на стороне сервера, локально не перехватить" },
	workbuddy: { shim: "промпт на стороне сервера, локально не перехватить" },
	codebuddy: {
		install: "только settings.json (переключатели плагинов/модели), нет записи, куда вставить текст в промпт; на практике только аргументы запуска или обёртка",
	},
};

/** 整家不可注入时的统一说明（matrix.reason 没有覆盖到的人工补） */
const BLOCKED = { antigravity: "системный промпт меняется только бинарным патчем, на уровне конфига точки записи нет" };

/**
 * 会话内热切 = 进程每轮重拼 system。触发面分两种：
 *  command —— 会话里打 /purge（只有 pi 的扩展钩子能做到）
 *  state   —— 改设置/换人设，下一轮就生效（插件每轮读 state.json）
 */
const HOT = {
	pi: { kind: "command", needs: "slash", how: "хук расширения before_agent_start: /purge или смена настроек, действует со следующего раунда" },
	opencode: { kind: "state", needs: "install", how: "хук плагина chat.system.transform читает state.json + active.md каждый раунд: смена настроек действует со следующего раунда" },
};

/** 没有每轮拼装点的：说明为什么只能重启 */
const NOT_HOT = {
	claude: "system собирается только при старте; в сессии можно вставить лишь в сообщение user (проверено 0/2)",
	codex: "config.toml читается при старте; в сессии нет хука, пересобирающего system",
	grok: "AGENTS.md читается один раз при старте",
	omp: "rules читается один раз при старте",
	hermes: "SOUL.md хоть и перечитывается каждый раунд, но командного интерфейса внутри сессии нет — можно только править файл",
	zcode: "десктопная версия закрытая, нет плагинов и хуков команд",
	codebuddy: "только аргументы запуска",
	antigravity: "константа клиента, только бинарный патч",
	qoder: "промпт на стороне сервера",
	workbuddy: "промпт на стороне сервера",
};

function reason(id, channel) {
	return WHY[id]?.[channel] ?? null;
}

/**
 * 单家能力。ctx 可传 { bin, found }（来自 detect，省一次 PATH 扫描）；不传就现查。
 * 返回 { injectable, shim:{ok,why}, install:{ok,why}, slash:{ok,why} }
 */
export function capsFor(id, ctx = {}) {
	const spec = matrix.harnesses[id] ?? {};
	const injectable = spec.inject === false || spec.class === "unsupported" ? false : true;
	const blocked = !injectable
		? `в этот инструмент не внедрить${spec.reason ? ": " + spec.reason : BLOCKED[id] ? ": " + BLOCKED[id] : typeof spec.override === "string" ? ": " + spec.override : ""}`
		: null;

	const cliPath = ctx.bin ?? null;
	const hasCli = Boolean(cliPath) || Boolean(resolveReal(id));
	const desktop = DESKTOP_FIRST.has(id);

	const shimWhy = blocked
		? blocked
		: !hasCli
			? desktop
				? "на машине нет входа из командной строки; десктопный запуск двойным щелчком/из меню «Пуск» тоже не проходит через PATH — перехват по имени команды для него не работает"
				: `в PATH на этой машине не найден ${id} (сначала установите его в PATH)`
			: desktop
				? `действует только для \`${id}\`, набранного в терминале; запуск с иконки на рабочем столе обходит PATH`
				: null;

	const t = persistTargets[id];
	// user 层不算能力：写下去也压不住 harness 自己的身份，装了等于白装
	const layerWhy =
		t && t.layer && t.layer !== SYS_LAYER
			? `${id}: постоянный файл попадает только в слой ${t.layer} (${t.note ?? "блок контекста"}) — системный промпт он не перекрывает; слой sys достигается только подменой при старте (agent-purge ${id})`
			: null;
	const installWhy = blocked ? blocked : !PERSIST_IDS.has(id) ? (reason(id, "install") ?? "нет конфига, доступного для записи") : layerWhy;

	const slashWhy = blocked
		? blocked
		: !SLASH_IDS.has(id)
			? `${id}: нет /purge, который меняет системный промпт (/purge разворачивается в сообщение пользователя, на практике не работает; только расширение pi умеет переписать systemPrompt в before_agent_start)`
			: null;

	return {
		injectable,
		shim: { ok: !shimWhy || (desktop && hasCli), why: shimWhy },
		install: {
			ok: !installWhy,
			why: installWhy,
			// 有落点、但落点压不住系统提示词 → 不当作可选项给出去（UI 也不显示）
			hidden: Boolean(layerWhy),
			hiddenLabel: layerWhy ? (HIDDEN_LABEL[id]?.install ?? t?.file?.()) : null,
			layer: t?.layer ?? null,
			note: t?.note ?? null,
			verified: NOT_LIVE_TESTED.has(id) ? false : true,
		},
		hot: (() => {
			const h = HOT[id];
			if (!h) return { ok: false, kind: null, why: NOT_HOT[id] ?? `системный промпт ${id} собирается только при запуске`, how: null, needs: null };
			// 热切靠哪个通道：那个通道不可用就不算热切能力
			const dependent = h.needs === "slash" ? !slashWhy : !installWhy;
			return {
				ok: Boolean(dependent),
				kind: h.kind,
				why: dependent ? null : h.needs === "slash" ? slashWhy : installWhy,
				how: h.how,
				needs: h.needs,
			};
		})(),
		slash: {
			ok: !slashWhy,
			why: slashWhy,
			// 不能改系统提示词的 /purge 一律不摆出来：一个点了没反应的按钮比没有更糟
			hidden: Boolean(slashWhy),
			hiddenLabel: HIDDEN_LABEL[id]?.slash ?? null,
		},
	};
}

/** 一次算全部（CLI --all / Web 首屏用） */
export function capsAll(ids, detectMap = {}) {
	return Object.fromEntries(ids.map((id) => [id, capsFor(id, detectMap[id] ?? {})]));
}

/** 至少有一条通道能用吗？全不能用 = 这家只能「原样启动」 */
export function anyChannel(id, ctx) {
	const c = capsFor(id, ctx);
	return c.shim.ok || c.install.ok || c.slash.ok;
}
