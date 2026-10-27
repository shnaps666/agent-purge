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
		residueHint: mode === "off" ? "" : "不补丁时残留 62 字身份句",
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
					residueHint: "MCP tool routes 仍会追加（10K 量级），关掉 MCP server 可缩",
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
			note: "[plugin] .opencode/plugin/agent-purge.ts（原地 splice output.system）",
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
			"CLI 拿不到 customSystemPrompt（只有 app-server/SDK 能传）；CLI 只有 UserPromptSubmit hook 注入，且落在 user 角色。",
			"注入配方: ~/.zcode/cli/config.json 里 hooks.enabled=true + UserPromptSubmit hook 返回 additionalContext。",
			"归零配方: 等长替换 resources/glm/zcode.cjs 里的 IJs（42 字），但 cli_prefix 段仍留 42 字。",
		],
	}),

	hermes: () => ({
		manual: [
			"hermes 从 $HERMES_HOME/SOUL.md 取身份段。",
			"配方: 复制现有 HERMES_HOME 到 .sandbox/hermes-home，覆盖 SOUL.md，再 HERMES_HOME=<该目录> 启动。",
			"必须加 --ignore-rules: Hermes 自带的 rules 层会把人设顶回去（实测不加时它自称 Hermes 并明说“这一条我不照办”，加了立刻完全采纳）。",
			"注意首次启动会自装 Python 依赖（约 80 秒）。",
		],
	}),

	antigravity: () => ({
		manual: [
			"prompt 在 resources/bin/language_server.exe（Go embed.FS）。",
			"闭源 App 的身份句在二进制里，只能等长替换；改动会使签名失效、更新被覆盖，所以默认不做。",
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
		note: "注入靠扩展（sys 层）；人设走 state.json，不占命令行",
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
		note: "persona 对 zcode CLI 不生效：customSystemPrompt 只有 app-server/SDK 能传",
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
		note: "身份段来自 $HERMES_HOME/SOUL.md；注入时必须带 --ignore-rules，关电源时不带",
	}),
};
