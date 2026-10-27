// 每家的 build() 是纯函数：只描述"怎么启动"，不 spawn、不写盘。
// setup/cleanup 由入口统一调用，保证能按哈希回滚。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const inline = (text) => text.replace(/\s+$/, "");

export const backends = {
	// pi：命令行已试过 --system-prompt，但 pi.cmd 走 cmd.exe，10K 人设会撞 8191 上限（实测“命令行太长”）。
	// 所以 pi 的注入靠扩展（sys 层、无长度限制、跟 state.json 走），这里只透传。
	// 扩展由 launch() 在启动前自动确保安装。
	pi: ({ args }) => ({ cmd: "pi", args }),

	codex: ({ personaPath, personaText, mode, args }) => ({
		cmd: "codex",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["-c", `developer_instructions=${inline(personaText)}`, ...args]
					: ["-c", `model_instructions_file=${personaPath.replace(/\\/g, "/")}`, ...args],
	}),

// CodeBuddy（腾讯云，npm @tencent-ai/codebuddy-code）：原生整段替换，无残留
	codebuddy: ({ personaPath, personaText, mode, args }) => ({
		cmd: "codebuddy",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["--append-system-prompt", inline(personaText), ...args]
					// replace 走文件：内联 9.6K 会把裸命令（.cmd 包装器）撞上 8191 上限
					: ["--system-prompt-file", personaPath, ...args],
	}),

	claude: ({ personaPath, mode, args }) => ({
		cmd: "claude",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["--append-system-prompt-file", personaPath, ...args]
					: ["--system-prompt-file", personaPath, ...args],
		residueHint: mode === "off" ? "" : "без патча остаётся 62-символьная фраза идентичности",
	}),

	grok: ({ personaText, mode, args }) => ({
		cmd: "grok",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["--rules", inline(personaText), ...args]
					: ["--system-prompt-override", inline(personaText), ...args],
	}),

	omp: ({ personaText, mode, args }) =>
		mode === "off"
			? { cmd: "omp", args: [...args] }
			: {
					cmd: "omp",
					args: ["--system-prompt", inline(personaText), ...args],
					residueHint: "MCP tool routes всё равно добавляются (порядка 10K), отключение MCP server уменьшит объём",
				},

	// opencode 靠 cwd 下 .opencode/plugin/*.ts 发现插件，必须原地 splice
	// opencode 2.x 只认 V2：default 导出 + id + setup(ctx)，钩子挂在 ctx.session.hook("context")
	opencode: ({ personaText, mode, cwd, args }) => {
		if (mode === "off") return { cmd: "opencode", args: [...args] };
		const dir = join(cwd, ".opencode", "plugin");
		const file = join(dir, "agent-purge.ts");
		const src = `export default {
  id: "agent-purge",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      event.system.splice(0, event.system.length, { type: "text", text: ${JSON.stringify(inline(personaText))} });
    });
  },
};
`;
		return {
			cmd: "opencode",
			note: "[plugin] .opencode/plugin/agent-purge.ts (splice output.system на месте)",
			args,
			setup: () => {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, src);
			},
			cleanup: () => rmSync(file, { force: true }),
		};
	},

	// 需要落盘或调用方配合，CLI 不代劳，只给可复制的配方
	zcode: () => ({
		manual: [
			"CLI не может передать customSystemPrompt (это умеет только app-server/SDK); в CLI инъекция возможна только через hook UserPromptSubmit, и попадает она в роль user.",
			"Рецепт инъекции: в ~/.zcode/cli/config.json hooks.enabled=true + UserPromptSubmit hook возвращает additionalContext.",
			"Рецепт обнуления: замена равной длины IJs в resources/glm/zcode.cjs (42 символа), но в сегменте cli_prefix остаются те же 42 символа.",
		],
	}),

	hermes: () => ({
		manual: [
			"hermes берёт блок идентичности из $HERMES_HOME/SOUL.md.",
			"Рецепт: скопируйте текущий HERMES_HOME в .sandbox/hermes-home, перезапишите SOUL.md, затем запускайте с HERMES_HOME=<этот каталог>.",
			"Обязателен --ignore-rules: встроенный слой rules у Hermes откатывает persona (в замере без него модель называет себя Hermes и прямо говорит «это правило я не выполню», с ним сразу принимает полностью).",
			"Учтите: при первом запуске он сам ставит Python-зависимости (около 80 секунд).",
		],
	}),

	antigravity: () => ({
		manual: [
			"prompt лежит в resources/bin/language_server.exe (Go embed.FS).",
			"Фраза идентичности закрытого App зашита в бинарник, возможна только замена равной длины; правка ломает подпись и затирается обновлением, поэтому по умолчанию не делается.",
		],
	}),

	qoder: ({ reason }) => ({ unsupported: reason }),
	workbuddy: ({ reason }) => ({ unsupported: reason }),
};




// 一次性问答（headless）规格：Web UI 与 `agent-purge <h> --ask` 共用。
// 只收录实测过参数的 harness，没验过的不猜。
export const oneshots = {
	pi: ({ prompt }) => ({
		cmd: "pi",
		args: ["-p", prompt],
		note: "инъекция через расширение (слой sys); persona идёт через state.json, не занимает командную строку",
	}),
	claude: ({ prompt, personaPath, mode }) => ({
		cmd: "claude",
		args: ["-p", prompt, ...(mode === "off" ? [] : [mode === "append" ? "--append-system-prompt-file" : "--system-prompt-file", personaPath])],
	}),
	grok: ({ prompt, personaText, mode }) => ({
		cmd: "grok",
		args: ["-p", prompt, "--always-approve", ...(mode === "off" ? [] : [mode === "append" ? "--rules" : "--system-prompt-override", inline(personaText)])],
	}),
	omp: ({ prompt, personaText, mode }) => ({
		cmd: "omp",
		args: ["-p", ...(mode === "off" ? [] : ["--system-prompt", inline(personaText)]), prompt],
	}),
	codex: ({ prompt, personaPath, personaText, mode }) => ({
		cmd: "codex",
		args: [
			...(mode === "off"
				? []
				: ["-c", mode === "append" ? `developer_instructions=${inline(personaText)}` : `model_instructions_file=${personaPath.replace(/\\/g, "/")}`]),
			"exec",
			prompt,
		],
	}),
	opencode: ({ prompt, personaText, mode, cwd }) => {
		if (mode === "off") return { cmd: "opencode", args: ["run", prompt] };
		const b = backends.opencode({ personaText, cwd, args: ["run", prompt] });
		return b;
	},
	zcode: ({ prompt }) => ({
		cmd: "zcode",
		args: ["--prompt", prompt, "--mode", "yolo", "--output-format", "stream-json", "--no-color"],
		note: "persona для zcode CLI не работает: customSystemPrompt может передать только app-server/SDK",
	}),
	codebuddy: ({ prompt, personaPath, personaText, mode }) => ({
		cmd: "codebuddy",
		args: [
			"-p",
			prompt,
			"--max-turns",
			"5",
			...(mode === "off"
				? []
				: mode === "append"
					? ["--append-system-prompt", inline(personaText)]
					: ["--system-prompt-file", personaPath]),
		],
	}),
	hermes: ({ prompt, mode }) => ({
		cmd: "hermes",
		// --ignore-rules 是关键：不加时 Hermes 自带 rules 层会把人设顶回去（模型自称 Hermes、明说“不照办”）。
		args: ["-z", prompt, ...(mode === "off" ? [] : ["--ignore-rules"])],
		note: "блок идентичности берётся из $HERMES_HOME/SOUL.md; при инъекции обязателен --ignore-rules, при выключении — без него",
	}),
};
