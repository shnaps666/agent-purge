#!/usr/bin/env node
// agent-purge — 一个入口，把各家 harness 的系统提示词替换收进来。
// 能力与实测数字见 matrix.json。
//
// 命令只有两类，别再分第三类：
//   选东西（写 state.json）   use / mode / install / arm / slash
//   用东西（跑起来）           <harness> / 裸敲已 arm 的命令名 / web / ls / status
import { execFileSync, spawn } from "node:child_process";
// Windows: без UTF-8 кодовая страница консоли (866/1251) превращает кириллицу в кракозябры
if (process.platform === "win32") {
	try {
		execFileSync("cmd", ["/c", "chcp", "65001"], { stdio: "ignore" });
	} catch {}
}
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backends, oneshots } from "../backends/index.mjs";
import { resolveBin, spawnBin } from "../lib/spawn.mjs";
import { installCrashHandlers, recover } from "../lib/restore.mjs";
import { capsFor } from "../lib/caps.mjs";
import { MODES, armedOf, loadState, patchState, setArmed, setDefault } from "../lib/state.mjs";
import { ensureDataHome } from "../lib/home.mjs";

// bun --compile 产物：资源目录 = exe 所在目录；普通 node：包根
const ROOT = process.versions.bun ? dirname(process.execPath) : dirname(dirname(fileURLToPath(import.meta.url)));
// 数据（state.json + personas/）放用户目录，npm 升级不会连人设一起清掉
const DATA = ensureDataHome(ROOT).home;
const matrix = JSON.parse(readFileSync(join(ROOT, "matrix.json"), "utf8"));

const argv = process.argv.slice(2);

// коды действий persist-слоя → человеческий текст
const ACTION_RU = {
	"wrote-whole-file": "файл записан",
	"replaced-block": "блок заменён",
	"appended-block": "блок добавлен",
	"deleted-file": "файл удалён",
	"already-gone": "уже отсутствовало",
	"no-block": "блока не было",
};
function act(a) {
	return ACTION_RU[a] ?? a;
}

installCrashHandlers();
const recovered = recover(); // 上次进程被杀时留下的半改配置, 开机先回滚
if (recovered > 0) console.log(`[restore] откатил ${recovered} файл(а) конфигурации после прошлого аварийного выхода`);
if (argv.includes("--help") || argv.includes("-h")) {
	help(); // 永远优先于默认值
	process.exit(0); // иначе после справки запускается harness по умолчанию
}
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};
let cmd = argv[0];

if (!cmd || cmd.startsWith("-")) cmd = await defaultHarness();

// ── 选东西 ────────────────────────────────────────────────────────────────
switch (cmd) {
	case "use":
		await useCmd();
		break;
	case "mode":
		modeCmd();
		break;
	case "install":
	case "uninstall":
		await installCmd(cmd, argv.slice(1));
		break;
	case "arm":
	case "disarm":
	case "register":
	case "注册":
		await armCmd(cmd === "arm" || cmd === "register" || cmd === "注册" ? "arm" : "disarm", argv.slice(1));
		break;
	case "slash":
		await slashCmd(argv.slice(1));
		break;
	case "status":
		statusCmd();
		break;
	case "ls":
		await lsCmd();
		break;
	case "doctor":
	case "detect": {
		const { doctor } = await import("../lib/doctor.mjs");
		await doctor(argv);
		break;
	}
	case "matrix":
		printMatrix();
		break;
	case "armor":
		await armorCli(argv.slice(1));
		break;
	case "web":
		webCmd();
		break;
	default:
		await launch(cmd);
}

// ── 用东西 ────────────────────────────────────────────────────────────────

/** 无参：state.default 说跑谁就跑谁；没有默认就跑到 Web 去选 */
async function defaultHarness() {
	const { state } = loadState(DATA);
	const harness = state.default?.harness;
	if (!harness) {
		console.log("Harness по умолчанию не выбран. Два варианта:\n  agent-purge web           выбрать в браузере и нажать «сделать исполнителем по умолчанию»\n  agent-purge <harness>     запустить конкретный (например, agent-purge codex)");
		process.exit(0);
	}
	console.log(`[default] ${harness} · ${state.default.mode} · persona=${state.persona ?? "-"}(state.json)`);
	return harness;
}

async function launch(name) {
	const spec = matrix.harnesses[name];
	if (!spec) die(`неизвестный harness: ${name} (доступны: ${Object.keys(matrix.harnesses).join(", ")}; подкоманды — в --help)`);
	if (spec.class === "unsupported") die(`${name} не поддерживается: ${spec.reason}`);

	const { state } = loadState(DATA);
	// 由 state.json 决定注入方式；显式 --mode 永远压过它
	const explicitMode = flag("--mode", null);
	if (explicitMode !== null && !MODES.includes(explicitMode)) die(`--mode принимает только ${MODES.join(" / ")}`);
	const mode = explicitMode ?? state.default?.mode ?? "replace";

	// 裸敲 pi 的持久位（写 state.json，扩展下一会话读它）
	const autoFlag = name === "pi" ? flag("--auto", null) : null;
	if (autoFlag !== null) {
		if (autoFlag !== "on" && autoFlag !== "off") die("--auto принимает только on / off");
		const { setPiAuto } = await import("../lib/state.mjs");
		setPiAuto(DATA, autoFlag === "on");
		console.log(`[auto] запуск pi без аргументов ${autoFlag === "on" ? "будет" : "не будет"} инжектить персону (записано в state.json)`);
	}

	// pi 的人设落在哪一层：sys（默认，真系统提示词）或 user（塞进用户消息，给忽略 system 的模型）
	const layerFlag = name === "pi" ? flag("--layer", null) : null;
	if (layerFlag !== null) {
		if (layerFlag !== "sys" && layerFlag !== "user") die("--layer принимает только sys / user");
		const { setPiUserLayer } = await import("../lib/state.mjs");
		setPiUserLayer(DATA, layerFlag === "user");
		console.log(
			layerFlag === "user"
				? "[layer] персона дополнительно кладётся в пользовательское сообщение (для моделей, игнорирующих system; цена — лишний блок в каждом сообщении)"
				: "[layer] персона идёт в слой system (по умолчанию)",
		);
	}

	// 实测策略：该 harness 的哪一层真的能注入（数据来自 matrix.json armor 段）
	const { plan } = await import("../lib/armor.mjs");
	const strategy = plan(matrix, name);	if (!strategy.error) {
		if (strategy.requiresSeed) console.log(`[стратегия] ${name}: чистая инъекция в sys на замерах ${strategy.bare.sys}%, с seed-фразой персоны ${strategy.persona.sys}% — нужен seed-слой`);
		const noSys = strategy.blocked.find((b) => b.layer === "sys");
		if (noSys && mode !== "off") console.log(`[стратегия] ${name}: слой sys недоступен (${noSys.reason}), в этот раз только слой user`);
	}

	// 通道全废的家（闭源桌面 / 提示词在服务端）说清楚：这次只是原样启动，没注入任何东西
	{
		const c = capsFor(name);
		if (!c.shim.ok && !c.install.ok && !c.slash.ok && mode !== "off") {
			const why = [c.shim, c.install, c.slash].map((x) => x.why).filter(Boolean)[0];
			console.log(`[подсказка] ${name}: инъекция невозможна, запуск без изменений: ${why}`);
		}
	}

	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const personaName = flag("--persona", "active");
	let pickedName = personaName === "active" ? store.activeId() : personaName;
	let picked = store.read(pickedName);
	// 指针可能指向已删的 persona：回退到第一个，不让启动器直接死
	if (!picked && personaName === "active") {
		const first = store.list()[0];
		if (first) {
			console.warn(`[warn] active указывает на несуществующую persona: ${pickedName ?? "(пусто)"}, откат на ${first.id} (agent-purge use ${first.id} — записать указатель обратно)`);
			pickedName = first.id;
			picked = first;
		}
	}
	if (!picked) die(`нет persona: ${pickedName} (доступны: ${store.list().map((p) => p.id).join(", ")})`);
	const personaPath = store.materialize(picked.id);
	const personaText = picked.body.trim();
	const cwd = resolve(flag("--cwd", process.cwd()));

	// --ask：一次性问答，与 Web UI 共用 oneshots 规格；不给才启动交互式 harness
	// 透传：有 -- 就只收 -- 后面的；没有就把“不是 agent-purge 自己的 flag”全交给 harness
	// （这样裸命令 `pi -p "…"` / `codex exec "…"` 经 shim 进来也能把参数带到，--ask 也一样）
	const dd = argv.indexOf("--");
	let passthrough = [];
	if (dd !== -1) {
		passthrough = argv.slice(dd + 1);
	} else {
		const ownWithValue = new Set(["--ask", "--mode", "--persona", "--cwd", "--auto"]);
		const tail = argv.slice(1);
		for (let i = 0; i < tail.length; i++) {
			const t = tail[i];
			if (ownWithValue.has(t)) {
				i++;
				continue;
			}
			if (t === "--dry-run" || ownWithValue.has(t.split("=")[0])) continue;
			passthrough.push(t);
		}
	}

	const askIdx = argv.indexOf("--ask");
	let built;
	if (askIdx !== -1) {
		const raw = argv[askIdx + 1];
		if (!raw || raw.startsWith("--")) die('--ask требует запрос, например: agent-purge codex --ask "объясни этот код"');
		const prompt = raw.trim();
		const one = oneshots[name];
		if (!one) die(`${name} не поддерживает одноразовый запуск (доступны: ${Object.keys(oneshots).join(", ")})`);
		built = one({ prompt, personaPath, personaText, mode, cwd });
		if (passthrough.length) built.args = [...built.args, ...passthrough];
	} else {
		built = backends[name]?.({ personaPath, personaText, mode, args: passthrough, cwd, reason: spec.reason }) ?? {
			unsupported: "для этого harness ещё нет реализации",
		};
	}

	if (built.manual) {
		console.log(`${name}: нужны действия вручную`);
		built.manual.forEach((line) => console.log("  - " + line));
		process.exit(0);
	}
	if (built.unsupported) die(`${name} не поддерживается: ${built.unsupported}`);

	if (built.note) console.log(built.note);
	if (built.residueHint) console.log(`[residue] ${built.residueHint}`);
	// off 有两种来源：全局总电源关了，或者这一轮手动指定。措辞不能混，否则看日志的人会以为总开关坏了
	if (mode === "off") {
		const globalOff = (state.default?.mode ?? "") === "off";
		console.log(
			globalOff
				? "[off] общий выключатель выключен (state.default.mode=off): запуск как есть, расширения не ставятся, инъекции нет; чтобы включить — поднимите тумблер в UI или укажите --mode replace/strict/append"
				: "[off] в этот раз без инъекции (--mode off): запуск как есть; глобальное значение по умолчанию — " + (state.default?.mode ?? "?") + ", изменить: agent-purge mode <режим>",
		);
	}
	console.log(`[cmd] ${[built.cmd, ...built.args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a))].join(" ")}`);
	if (argv.includes("--dry-run")) process.exit(0);

	// pi：注入活在扩展里（命令行装不下 10K 人设）。
	//   mode ≠ off：确保扩展在位（没有就装、有就重写成人设最新版），并用 AGENT_PURGE_FORCE=1 明确告诉扩展“这次是启动器要注入”。
	//   mode = off：不装、也不喊注入。扩展就算挂在盘上，也会因为 mode=off + 没 FORCE 而保持沉默（裸敲 pi 原样跑）。
	if (name === "pi" && !built.unsupported && !built.manual) {
		const { installSlash } = await import("../lib/slashes.mjs");
		if (mode === "off") {
			// 不装、不喊注入：扩展就算在盘上，也会因为 mode=off + 没 FORCE 而沉默
			built.env = { ...built.env, AGENT_PURGE_MODE: "off" };
		} else {
			installSlash("pi", DATA, { personaId: picked.id, personaBody: personaText });
			built.env = { ...built.env, AGENT_PURGE_PERSONA: picked.id, AGENT_PURGE_MODE: mode, AGENT_PURGE_FORCE: "1" };
		}
	}

	if (!resolveBin(built.cmd)) {
		die(`${name}: не найден исполняемый файл ${built.cmd} (его нет в PATH; что найдено на машине — agent-purge doctor)`);
	}
	built.setup?.();
	// 一次性问答：stdin 直接给 NUL。否则 codex 这类会先“Reading additional input from stdin...”
	// 并阻塞到 EOF（非 TTY 环境必现）；stdin 关了它就直接跑。
	const stdio = askIdx !== -1 ? ["ignore", "inherit", "inherit"] : "inherit";
	const child = spawnBin(built.cmd, built.args, { cwd, stdio, env: { ...process.env, ...built.env } });
	const finish = (code) => {
		built.cleanup?.();
		process.exit(code ?? 1);
	};
	child.on("error", (e) => {
		console.error(`${name}: ${e.message}`);
		finish(1);
	});
	child.on("close", (code) => finish(code));
}

// ── 选东西的实现 ───────────────────────────────────────────────────────────

async function useCmd() {
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const arg = argv[1];
	const { state, migrated } = loadState(DATA);
	migrated.forEach((m) => console.log(`[migrate] ${m}`));

	const id = arg && !arg.startsWith("-") ? arg : state.persona;
	if (!id) {
		console.log(`текущая persona: (не выбрана)\nдоступны: ${store.list().map((p) => p.id).join(", ")}`);
		return;
	}
	if (!store.read(id)) die(`нет persona: ${id} (доступны: ${store.list().map((p) => p.id).join(", ")})`);
	store.setActive(id); // 写 active.md 快照 + state.persona 指针

	// user 层的 /purge 命令文件是烘焙进去的，换人设必须重渲染
	const { refreshSlashes } = await import("../lib/slashes.mjs");
	const refreshed = refreshSlashes(DATA, state.armed ? Object.entries(state.armed).filter(([, a]) => a.includes("slash")).map(([k]) => k) : [], {
		personaId: id,
		personaBody: store.read(id).body.trim(),
	});
	console.log(`persona ← ${id} (active.md синхронизирован)`);
	refreshed.forEach((f) => console.log(`[slash] перезаписан ${f}`));
	if (Object.keys(state.armed ?? {}).length) {
		console.log("у включённых harness персона подхватится со следующего запуска; если нужен снимок в конфиге прямо сейчас: agent-purge install <h>");
	}
}

function modeCmd() {
	const want = argv[1];
	const { state } = loadState(DATA);
	const current = state.default?.mode ?? "replace";
	if (!want) {
		console.log(
			[
				`текущий способ инъекции: ${current}`,
				"  strict  только персона (родной промпт теряется полностью, самый чистый)",
				"  replace персона впереди + из родного промпта вырезается фраза-идентичность (по умолчанию, вендор всё ещё узнаёт вас)",
				"  append  персона только в начало, родной промпт не тронут (самый осторожный)",
				"  off     без инъекции (управляемый harness можно запускать как обычно)",
			].join("\n"),
		);
		return;
	}
	if (!MODES.includes(want)) die(`mode принимает только ${MODES.join(" / ")}`);
	setDefault(DATA, { harness: state.default?.harness ?? "codex", mode: want });
	console.log(`mode ← ${want} (state.json; применится при следующем запуске, --mode перекрывает разово)`);
}

async function installCmd(verb, rest) {
	const id = rest[0];
	const ids = id === "--all" || !id ? Object.keys(matrix.harnesses).filter((h) => matrix.harnesses[h].class !== "unsupported") : [id];
	const { backends: be } = await import("../backends/index.mjs");
	for (const h of ids) {
		const b = be[h];
		if (!b) die(`неизвестный harness: ${h}`);
		const fn = verb === "install" ? b.install : b.uninstall;
		if (!fn) {
			console.log(`${h}: нет постоянной установки (для перехвата имени — arm, для команды в сессии — slash)`);
			continue;
		}
		const spec = matrix.harnesses[h];
		const { createStore } = await import("../lib/personas.mjs");
		const store = createStore(DATA);
		const pid = store.activeId();
		const r = fn({ personaPath: store.materialize(pid), personaText: store.read(pid).body.trim(), root: DATA, reason: spec.reason }) ?? {};
		const ok = verb === "install" ? r.ok !== false : r.ok !== false;
		console.log(`${ok ? "✓" : "✗"} ${verb} ${h}${r.file ? ` → ${r.file}` : ""}${r.note ? `  (${r.note})` : ""}`);
		if (ok) setArmed(DATA, h, "install", verb === "install");
	}
}

async function armCmd(verb, rest) {
	const { installShim, uninstallShim, ensureUserPath } = await import("../lib/shim.mjs");
	const { installSlash, uninstallSlash } = await import("../lib/slashes.mjs");
	const { install, uninstall } = await import("../lib/persist.mjs");
	const { capsFor } = await import("../lib/caps.mjs");
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const pid = store.activeId();
	if (!pid) die("нет persona: сначала agent-purge use <id>");

	const supported = Object.keys(matrix.harnesses).filter((h) => matrix.harnesses[h].class !== "unsupported");
	const namedTarget = rest.filter((x) => !x.startsWith("-"));
	const targets = rest.includes("--all") || !namedTarget.length ? supported : namedTarget;

	// 全局 --all 就是总电源：撤的时候必须把 default.mode 置 off，
	// 否则 `agent-purge <h>` 这条入口照样注入（实测：关了总开关还能接管，就是这里漏的）。
	// 开的时候把上次的 mode 还回去。单家操作不动 mode。
	if (rest.includes("--all")) {
		const { state: cur } = loadState(DATA);
		const m = cur.default?.mode ?? "off";
		if (verb === "disarm" && m !== "off" && cur.default?.harness) {
			setDefault(DATA, { harness: cur.default.harness, mode: "off" });
			patchState(DATA, { prevMode: m });
		}
		if (verb === "arm" && m === "off" && cur.default?.harness) {
			const back = MODES.includes(cur.prevMode) && cur.prevMode !== "off" ? cur.prevMode : "replace";
			setDefault(DATA, { harness: cur.default.harness, mode: back });
		}
	}

	// 通道默认全开（常驻 + 裸命令接管 + /purge）；只想做其中一个就显式点名
	const named = ["--install", "--shim", "--slash"].filter((f) => rest.includes(f));
	const channels = named.length ? named.map((f) => f.slice(2)) : ["install", "shim", "slash"];
	let armedAny = 0;

	for (const h of targets) {
		if (!matrix.harnesses[h]) die(`неизвестный harness: ${h}`);
		const done = [];
		const skip = [];

		for (const ch of channels) {
			// 先过能力表：这家形态上做不到的通道（如 zcode 桌面 + shim），不写文件，直接说明原因
			if (verb === "arm") {
				const cap = capsFor(h)[ch];
				if (cap && !cap.ok) {
					skip.push(`${ch}: ${cap.why}`);
					continue;
				}
			}
			if (ch === "install") {
				const r = verb === "arm" ? install(h, { root: DATA, active: store.refreshActive() }) : uninstall(h);
				if (r.error) skip.push(`постоянная установка: ${r.error}`);
				else {
					setArmed(DATA, h, "install", verb === "arm");
					done.push(verb === "arm" ? `установка: ${act(r.action)}` : `снятие установки: ${act(r.action)}`);
				}
			}
			if (ch === "shim") {
				const r = verb === "arm" ? installShim(DATA, h) : uninstallShim(DATA, h);
				if (r.error) skip.push(`shim: ${r.error}`);
				else {
					setArmed(DATA, h, "shim", verb === "arm");
					done.push(verb === "arm" ? "перехват имени команды" : "перехват имени снят");
				}
			}
			if (ch === "slash") {
				const r =
					verb === "arm"
						? installSlash(h, DATA, { personaId: pid, personaBody: store.read(pid).body.trim() })
						: uninstallSlash(h, DATA);
				if (r.error) skip.push(`/purge: ${r.error}`);
				else {
					setArmed(DATA, h, "slash", verb === "arm");
					if (verb === "arm") done.push(`/purge (слой ${r.layer})`);
					else if (r.removed?.length) done.push(`/purge снят: ${r.removed.length}`);
				}
			}
		}
		const icon = done.length ? "✓" : "·";
		if (done.length) armedAny += 1;
		
console.log(`${icon} ${verb} ${h.padEnd(11)} ${done.join(" · ") || "нет доступных каналов"}${skip.length ? "  пропущено: " + skip.join("; ") : ""}`);
	}

	if (verb === "arm" && armedAny && channels.includes("shim")) {
		const r = ensureUserPath();
		console.log(r.changed ? `[path] ${r.dir} → в начало PATH пользователя (${r.how})` : `[path] ${r.dir} на месте (${r.how})`);
	}
	if (verb === "arm") {
		if (!armedAny) {
			console.log(`\nни один канал не установлен (${targets.join(", ")}): причины по каждому — в «пропущено» выше.`);
		} else {
			const h0 = targets[0];
			const lines = [];
			if (channels.includes("shim")) lines.push(`откройте новый терминал и наберите ${h0} → пойдёт через обёртку в PATH, инъекция работает`);
			if (channels.includes("slash")) {
				lines.push(
					h0 === "pi"
						? "запуск pi без аргументов не инжектит (установлено только горячее переключение); переписать можно командой /purge on в сессии, состояние — /purge status"
						: "инъекция только по команде /purge в сессии (она разворачивается в пользовательское сообщение)",
				);
			}
			if (channels.includes("install")) lines.push("конфиг изменён: подействует и на запуски не через agent-purge, и на открытые из GUI (после перезапуска того агента)");
			console.log("\nчто дальше:\n" + lines.map((l) => "  - " + l).join("\n") + "\nпроверить: agent-purge status");
		}
	}
}

async function slashCmd(rest) {
	const { installSlash, uninstallSlash, slashStatus } = await import("../lib/slashes.mjs");
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const id = rest[0];
	if (!id || id === "status") {
		const rows = slashStatus(DATA);
		const live = rows.filter((s) => s.offered);
		live.forEach((s) => {
			console.log(`${s.installed ? "✓" : " "} ${s.id.padEnd(9)} ${s.layer.padEnd(4)} ${s.trigger.padEnd(22)} persona=${s.personaId ?? "-"}`);
			console.log(`   ${s.note}`);
		});
		// 只列“能把内容写进 system 数组”的；user 层不要再诱人点
		const dead = rows.filter((s) => !s.offered);
		if (dead.length) {
			const still = dead.filter((s) => s.installed).map((s) => s.id);
			console.log(`\nснято с поддержки (слой user, системный промпт не перекрывает): ${dead.map((s) => s.id).join(", ")}`);
			if (still.length) console.log(`старые файлы ещё на диске: agent-purge slash off ${still.join(" ")}`);
		}
		return;
	}
	if (id === "off") {
		const target = rest[1];
		const ids =
			target && target !== "--all"
				? rest.slice(1).filter((x) => !x.startsWith("-"))
				: slashStatus(DATA).filter((s) => s.installed).map((s) => s.id);
		if (!ids.length) console.log("нет установленных /purge");
		ids.forEach((h) => {
			const r = uninstallSlash(h, DATA);
			if (!r.error) {
				setArmed(DATA, h, "slash", false);
				console.log(`✓ /purge удалён: ${h}${r.removed?.length ? " → " + r.removed.join(", ") : " (его и не было)"}`);
			}
		});
		return;
	}
	const targets = id === "--all" ? slashStatus(DATA).filter((s) => s.offered).map((s) => s.id) : [id];
	const pid = store.activeId();
	if (!pid) die("нет persona: сначала agent-purge use <id>");
	for (const h of targets) {
		const r = installSlash(h, DATA, { personaId: pid, personaBody: store.read(pid).body.trim() });
		if (r.error) {
			console.log(`- ${h}: ${r.error}`);
			continue;
		}
		setArmed(DATA, h, "slash", true);
		console.log(`✓ /purge → ${h} (слой ${r.layer}) ${r.file}`);
		console.log(`   ${r.note}`);
	}
}

async function statusCmd() {
	const { migrated } = loadState(DATA);
	migrated.forEach((m) => console.log(`[migrate] ${m}`));
	// armed 是缓存，磁盘才是真相：先把假记录摘掉，再报数
	const { reconcileArmed } = await import("../lib/armed.mjs");
	const fixed = await reconcileArmed(DATA);
	if (fixed.length) console.log(`[сверка] armed исправлен: ${fixed.join(", ")}`);
	const { state } = loadState(DATA);
	return Promise.all([import("../lib/shim.mjs"), import("../lib/slashes.mjs")]).then(([shimMod, slashMod]) => {
		const shims = shimMod.shimStatus();
		const slashes = slashMod.slashStatus(DATA);

		console.log(`persona  ${state.persona ?? "(не выбрана)"}`);
		console.log(`default  ${state.default ? `${state.default.harness} · ${state.default.mode}` : "(не выбран)"}   его запускает agent-purge без аргументов`);
		console.log(`state    ${join(DATA, "state.json")}`);
		console.log("");
		console.log("harness     shim   slash  install   слой /purge  куда ставится");
		for (const [h] of Object.entries(matrix.harnesses)) {
			const armed = armedOf(state, h);
			const sh = shims.find((s) => s.id === h);
			const sl = slashes.find((s) => s.id === h);
			const cap = capsFor(h, { bin: sh?.target ?? null });
			const mark = (on) => (on ? " ✓  " : " ·  ");
			const slashCol = sl && sl.offered ? (sl.layer === "sys" ? "sys(гор.)" : "user") : "—";
			// install 列不写“注册没注册”，写“能不能装”：装了是 ✓，能装没装是「可用」，没落点才是 —
			const installCol = armed.includes("install") ? " ✓ " : cap.install.ok ? "можно" : " — ";
			const landing = cap.install.ok ? `${cap.install.layer || "?"}${cap.install.verified === false ? "(не проверено)" : ""}` : (cap.install.why || "");
			console.log(
				`${h.padEnd(11)}${mark(sh?.installed).padEnd(7)}${mark(sl?.installed).padEnd(7)}${installCol.padEnd(10)}${slashCol.padEnd(10)}${landing}`,
			);
		}
		const dir = shimMod.shimDir();
		const ps = shimMod.pathState();
		const where = !ps.present ? "нет в PATH" : ps.first ? "уже в начале PATH" : "в PATH, но не первым (может сработать настоящая команда)";
		console.log(`\nкаталог shim ${dir} (${where})`);
		if (!ps.first) console.log(`исправить: agent-purge arm <h> --shim (PATH поправится автоматически)`);
	});
}

async function lsCmd() {
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const { state } = loadState(DATA);
	const fit = store.resolve({ harness: state.default?.harness, model: null });
	for (const p of store.list()) {
		const mark = p.id === store.activeId() ? "*" : " ";
		const best = fit?.persona?.id === p.id && fit?.matched ? " ← лучше всего подходит текущему harness" : "";
		const desc = p.meta?.description ?? p.meta?.desc ?? "";
		console.log(`${mark} ${p.id.padEnd(14)} ${String(p.meta?.name ?? "").padEnd(12)} ${desc.slice(0, 44)}${best}`);
	}
	console.log(`\n* = active (переключить: agent-purge use <id>)`);
}

function webCmd() {
	const port = Number(flag("--port", "7788"));
	// --detach：脱离当前终端后台存活，日志丢弃
	if (argv.includes("--detach")) {
		const child = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--serve", String(port)], {
			detached: true,
			stdio: "ignore",
			shell: false,
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
		child.unref();
		console.log(`agent-purge web запущен в фоне → http://127.0.0.1:${port} (pid ${child.pid})`);
		process.exit(0);
	}
	return import("../web/server.mjs").then(({ serveWeb }) => serveWeb(port));
}

// ── 其余 ──────────────────────────────────────────────────────────────────

async function armorCli(rest) {
	const { renderMatrix, renderPlan, plans, plan, preflight, runBench, runJudge } = await import("../lib/armor.mjs");
	const color = !argv.includes("--no-color") && Boolean(process.stdout.isTTY);
	const sub = rest[0]?.startsWith("-") ? "matrix" : rest[0] ?? "matrix";
	const opts = (name, fallback) => {
		const i = rest.indexOf(name);
		return i === -1 ? fallback : rest[i + 1];
	};
	const flags = rest.filter((x) => x.startsWith("--"));
	// 位置参数 ≠ 非 - 开头的 token：`--base https://x` 的值不是 harness 名
	const VALUE_FLAGS = new Set(["--base", "--key", "--model", "--task", "--layers", "--only", "--repeat", "--concurrency", "--timeout", "--out", "--dir", "--probe"]);
	const positionals = (from = 1) => {
		const out = [];
		for (let i = from; i < rest.length; i++) {
			const a = rest[i];
			if (a.startsWith("--")) {
				if (VALUE_FLAGS.has(a)) i++;
				continue;
			}
			if (!a.startsWith("-")) out.push(a);
		}
		return out;
	};

	if (sub === "matrix") return renderMatrix(matrix, { color });

	if (sub === "plan") {
		const ids = positionals();
		const list = ids.length ? ids.map((id) => plan(matrix, id)) : plans(matrix);
		list.forEach((p, i) => {
			if (i) console.log();
			renderPlan(p, { color });
		});
		if (!ids.length) console.log(`\n${"─".repeat(48)}\nзапустить пачкой: agent-purge armor run --task crack-bare --layers off,sys,user --only ${list.map((p) => p.id).join(",")}`);
		return;
	}

	if (sub === "preflight" || sub === "check") {
		const ids = positionals();
		const env = { base: opts("--base", process.env.MG_BASE), key: opts("--key", process.env.MG_KEY), model: opts("--model", process.env.MG_MODEL) };
		let bad = 0;
		for (const id of ids.length ? ids : ["pi"]) {
			const r = preflight(matrix, id, env);
			console.log(`${r.ok ? "✓" : "✗"} ${id}`);
			r.checks.forEach((c) => console.log(`   ${c.ok ? "ok  " : "MISS"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`));
			if (!r.ok) bad++;
		}
		if (bad) process.exitCode = 1;
		return;
	}

	if (sub === "run") {
		if (flags.includes("--help")) {
			console.log(`agent-purge armor run --task crack-bare --layers off,sys,user --only pi,codex --repeat 2 --concurrency 3
  --base <url>  --key <key>  --model <id>    апстрим (по умолчанию MG_BASE / MG_KEY / MG_MODEL)
  --task crack-bare|crack-persona           формулировка (чистая / с seed-фразой персоны)
  --layers off,sys,user|off,sys
  --out <dir>`);
			return;
		}
		const env = {
			MG_BASE: opts("--base", process.env.MG_BASE),
			MG_KEY: opts("--key", process.env.MG_KEY),
			MG_MODEL: opts("--model", process.env.MG_MODEL),
		};
		if (!env.MG_BASE || !env.MG_KEY) {
			console.error("нет апстрима: --base / --key (или переменные MG_BASE / MG_KEY). Пример:\n  agent-purge armor run --base https://api.deepseek.com/v1 --key $env:MG_KEY --model deepseek-flash --task crack-bare --layers off,sys --only pi");
			process.exit(2);
		}
		const pass = [];
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (["--base", "--key", "--model"].includes(a)) { i++; continue; }
			pass.push(a);
		}
		const { code } = runBench(pass, env);
		process.exitCode = code;
		return;
	}

	if (sub === "judge") {
		const pass = [];
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (["--base", "--key", "--model"].includes(a)) { i++; continue; }
			pass.push(a);
		}
		const { code } = runJudge(pass, {
			MG_BASE: opts("--base", process.env.MG_BASE),
			MG_KEY: opts("--key", process.env.MG_KEY),
			MG_MODEL: opts("--model", process.env.MG_MODEL),
		});
		process.exitCode = code;
		return;
	}

	console.error(`неизвестная подкоманда: armor ${sub} (доступны: matrix | plan | preflight | run | judge)`);
	process.exit(2);
}

function printMatrix() {
	const rows = Object.entries(matrix.harnesses).map(([name, s]) => ({
		harness: name,
		class: s.class,
		override: s.override === true ? "yes" : s.override ? String(s.override) : "no",
		inject: s.inject ? "yes" : "no",
		hot: s.hotSwitch ? "yes" : "no",
		chars: s.defaultSystemChars != null ? `${s.defaultSystemChars} → ${s.purgedSystemChars ?? "?"}` : "—",
		armor: s.armor ? `${s.armor.probe.bare.sys ?? "—"}${s.armor.probe.bare.sys == null ? "" : "%"} / ${s.armor.probe.bare.user ?? "—"}${s.armor.probe.bare.user == null ? "" : "%"}` : "не измерено",
		version: s.measuredVersion ?? "—",
	}));
	const head = ["harness", "class", "override", "inject", "hot", "system chars", "инъекция sys/user", "version"];
	const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)));
	const line = (cells) => cells.map((c, i) => String(c).padEnd(width[i])).join("  ");
	console.log(line(head));
	console.log(width.map((w) => "-".repeat(w)).join("  "));
	rows.forEach((r) => console.log(line(Object.values(r))));
	const residues = Object.entries(matrix.harnesses).filter(([, s]) => s.residue);
	if (residues.length) {
		console.log("\nостаток:");
		residues.forEach(([n, s]) => console.log(`  ${n}: ${s.residue}`));
	}
}

function help() {
	console.log(`agent-purge — подменяет системный промпт любого harness на вашу персона

Коротко: сначала «выбрать», потом «запускать». Выбрали один раз — дальше все входы следуют за выбором.

① ВЫБРАТЬ (пишется в state.json, общее для всех входов, применяется сразу)
   agent-purge use <id>           сменить persona (список — ls, * = текущая)
   agent-purge mode <m>           strict(только персона) / replace(по умолчанию) / append / off
   agent-purge web                выбрать harness · persona · mode в браузере

② ЗАПУСКАТЬ (три входа, результат одинаковый)
   agent-purge                    без аргументов = запустить тот harness, что в default
   agent-purge <h> [--ask "…"]    указать конкретный; --dry-run покажет команду, после -- аргументы уходят агенту
   <h>                            после web / arm имя команды уже запускает с персоной

③ ПОСТАВИТЬ (чтобы и «другие входы» несли персону; одна команда ставит всё, можно указать канал)
   agent-purge arm <h>|--all                 постоянная установка + перехват имени + /purge (всё сразу)
   agent-purge 注册 [--all]                  китайский псевдоним, то же самое
   agent-purge arm <h> --shim                только перехват имени команды (обёртка в начало PATH)
   agent-purge arm <h> --install             только постоянная установка в конфиг
   agent-purge arm <h> --slash               только команда /purge в сессии
   agent-purge disarm <h>|--all              снять всё перечисленное

④ ПОСМОТРЕТЬ
   agent-purge status             таблица: у каждого harness shim / slash / install и что вообще возможно
   agent-purge ls                 список persona
   agent-purge matrix             матрица возможностей (matrix.json)
   agent-purge armor [...]        plan|preflight|run|judge — замеры инъекции
   agent-purge doctor             что найдено на машине (кто установлен, версии)

СМЫСЛ КАНАЛОВ
   shim      в начало PATH кладётся обёртка с тем же именем; набираете команду — запуск идёт через agent-purge (инъекция в слой sys)
   install   правится собственный конфиг/плагин harness (подействует и на запуски не через agent-purge)
   slash     команда /purge в сессии: **умеет только pi** (расширение переписывает systemPrompt в before_agent_start — настоящий слой sys, переключение на лету)
         у остальных такой возможности нет: /purge разворачивается в пользовательское сообщение, на замерах 0/2 — поэтому не предлагается
   Сила инъекции: считается только слой sys. Слой user (блок контекста / пользовательское сообщение) у codex/claude/opencode/grok/hermes на замерах 0/2 — не предлагается вовсе.

harness: pi, opencode, codex, claude, grok, omp, hermes, zcode, antigravity, qoder, workbuddy, codebuddy
         у qoder / workbuddy нет точки сборки промпта (он на сервере) — можно править только файлы контекстных правил.
`);
}

function die(message) {
	console.error(message);
	process.exit(2);
}
