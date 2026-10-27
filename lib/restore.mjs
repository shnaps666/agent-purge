// 崩溃安全的文件交换。
//
// 为什么需要它：bench / launch 会临时改写 harness 自己的配置（hermes 的 config.yaml、
// opencode 插件、codex 的 config.toml）。如果进程被 Ctrl-C、OOM 或超时杀掉，
// 只在内存里保存"原内容"是回不去的 —— 实测中 hermes 的 config.yaml 就被留在了半改状态，
// 下一次启动直接 duplicate key 报错。
//
// 做法：每次改写前把原文落到 journal 目录（os.tmpdir()/agent-purge-restore），
// 进程正常退出 / 收到信号 / 下次启动时统一回滚。undo() 幂等。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JOURNAL_DIR = path.join(os.tmpdir(), "agent-purge-restore");
const ENTRY = "restore.json";

let installed = false;
const live = new Set();

function ensureDir() {
	try {
		fs.mkdirSync(JOURNAL_DIR, { recursive: true });
	} catch {}
}

function entryPath(file) {
	// 同一文件在 journal 里只应有一条；用稳定 hash 命名，避免路径分隔符
	const h = Buffer.from(file.toLowerCase()).toString("base64url").slice(0, 40);
	return path.join(JOURNAL_DIR, h + ".json");
}

/**
 * 原子写 + 记录 journal。返回幂等的 undo()。
 * @param {string} file 绝对路径
 * @param {string} content 新内容
 */
export function swapFile(file, content) {
	ensureDir();
	const exists = fs.existsSync(file);
	const backup = exists ? fs.readFileSync(file, "utf8") : null;
	const record = { file, exists, backup, at: new Date().toISOString() };
	fs.writeFileSync(entryPath(file), JSON.stringify(record), "utf8");

	const tmp = file + ".purge-tmp";
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, file);

	let done = false;
	const undo = () => {
		if (done) return;
		done = true;
		live.delete(undo);
		try {
			if (record.exists) fs.writeFileSync(file, record.backup, "utf8");
			else if (fs.existsSync(file)) fs.unlinkSync(file);
		} catch {}
		try {
			fs.rmSync(entryPath(file), { force: true });
		} catch {}
	};
	live.add(undo);
	return undo;
}

/** 回滚所有 journal 里残留的条目（上次进程没来得及 undo）。返回恢复的文件数。 */
export function recover() {
	ensureDir();
	let n = 0;
	for (const name of fs.readdirSync(JOURNAL_DIR)) {
		if (!name.endsWith(".json")) continue;
		const p = path.join(JOURNAL_DIR, name);
		try {
			const r = JSON.parse(fs.readFileSync(p, "utf8"));
			if (r.exists) fs.writeFileSync(r.file, r.backup, "utf8");
			else if (fs.existsSync(r.file)) fs.unlinkSync(r.file);
			fs.rmSync(p, { force: true });
			n++;
		} catch {}
	}
	return n;
}

/** 安装信号钩子：SIGINT/SIGTERM/SIGHUP/uncaughtException/exit 都回滚。幂等。 */
export function installCrashHandlers() {
	if (installed) return;
	installed = true;
	const flush = (code) => {
		for (const u of [...live]) {
			try {
				u();
			} catch {}
		}
		recover();
		process.exit(code);
	};
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
		try {
			process.on(sig, () => flush(sig === "SIGINT" ? 130 : 143));
		} catch {}
	}
	process.on("uncaughtException", (e) => {
		console.error("[restore] необработанное исключение, откатываю конфигурацию:", e?.message ?? e);
		flush(1);
	});
	process.on("exit", () => {
		for (const u of [...live]) {
			try {
				u();
			} catch {}
		}
	});
}

export const journalDir = JOURNAL_DIR;
