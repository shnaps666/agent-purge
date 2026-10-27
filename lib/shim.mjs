// 裸命令接管：在你的 PATH 前面放一层同名 shim，敲 `codex` 等于敲 `agent-purge codex`。
//
// 关键点：shim 会把「真身路径」写进 AGENT_PURGE_REAL_BIN，spawn 时优先用它，
// 否则 resolver 会在 PATH 里先找到 shim 自己 → 无限套娃。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(homedir(), ".agent-purge", "bin");
const EXTS = WIN ? [".exe", ".cmd", ".bat", ".ps1"] : [""];

export function shimDir() {
	return DIR;
}

/** 本工具自己的调用前缀：bun 编译版直接用自身 exe，普通 node 版本带上脚本路径 */
function selfPrefix() {
	if (process.versions.bun) return { cmd: process.execPath, args: [] };
	return { cmd: process.execPath, args: [join(ROOT, "bin", "agent-purge.mjs")] };
}

/** PATH 里找同名可执行文件，跳过我们自己的 shim 目录 */
export function resolveReal(id) {
	const dirs = (process.env.PATH ?? "").split(WIN ? ";" : ":").filter(Boolean);
	for (const d of dirs) {
		if (resolve(d) === resolve(DIR)) continue;
		for (const ext of EXTS) {
			const p = join(d, id + ext);
			if (existsSync(p)) return p;
		}
	}
	return null;
}

export function installShim(root, id) {
	const real = resolveReal(id);
	if (!real) return { error: `в PATH не найден настоящий ${id}(результаты обнаружения — agent-purge doctor)` };
	mkdirSync(DIR, { recursive: true });
	const self = selfPrefix();
	const files = [];
	// 拼接时不能折叠空格：node.exe 常在 "C:\Program Files\..." 下
	const callLine = [`"${self.cmd}"`, ...self.args.map((a) => `"${a}"`), id].join(" ");

	if (WIN) {
		const cmdFile = join(DIR, `${id}.cmd`);
		writeFileSync(
			cmdFile,
			[
				"@echo off",
				"rem agent-purge shim — 删掉本文件即取消接管",
				`set "AGENT_PURGE_REAL_BIN=${real}"`,
				`${callLine} %*`,
				"",
			].join("\r\n"),
			"utf8",
		);
		files.push(cmdFile);

		const psFile = join(DIR, `${id}.ps1`);
		writeFileSync(
			psFile,
			[
				"# agent-purge shim — 删掉本文件即取消接管",
				`$env:AGENT_PURGE_REAL_BIN = '${real.replace(/'/g, "''")}'`,
				`& '${self.cmd}' ${self.args.map((a) => `'${a}'`).join(" ")} ${id} @args`,
				"exit $LASTEXITCODE",
				"",
			].join("\r\n"),
			"utf8",
		);
		files.push(psFile);
	} else {
		const sh = join(DIR, id);
		writeFileSync(
			sh,
			[
				"#!/bin/sh",
				"# agent-purge shim — 删掉本文件即取消接管",
				`AGENT_PURGE_REAL_BIN='${real.replace(/'/g, "'\\''")}' exec '${self.cmd}' ${self.args.map((a) => `'${a}'`).join(" ")} ${id} "$@"`,
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);
		files.push(sh);
	}

	return { file: files[0], files, real };
}

export function uninstallShim(_root, id) {
	if (!existsSync(DIR)) return { error: `каталог shim не существует: ${DIR}` };
	const removed = [];
	for (const f of readdirSync(DIR)) {
		const base = f.replace(/\.(cmd|ps1|bat|exe)$/i, "");
		if (base === id) {
			rmSync(join(DIR, f), { force: true });
			removed.push(join(DIR, f));
		}
	}
	if (!removed.length) return { error: `нет shim для ${id}` };
	return { file: removed[0], removed };
}

export function shimStatus() {
	if (!existsSync(DIR)) return [];
	const seen = new Map();
	for (const f of readdirSync(DIR)) {
		const id = f.replace(/\.(cmd|ps1|bat|exe)$/i, "");
		if (!seen.has(id)) seen.set(id, { id, installed: true, dir: DIR, files: [] });
		seen.get(id).files.push(join(DIR, f));
	}
	return [...seen.values()];
}

/** 只读：shim 目录是否已在用户 PATH（且在最前）。供 status 用，不写注册表。 */
export function pathState() {
	if (!WIN) {
		const parts = (process.env.PATH ?? "").split(":");
		return { dir: DIR, present: parts.includes(DIR), first: parts[0] === DIR };
	}
	const read = spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: "utf8" });
	const parts = (read.stdout ?? "").trim().split(";").filter(Boolean);
	const norm = (s) => resolve(s.trim().replace(/\\{2,}/g, "\\")).toLowerCase();
	const at = parts.findIndex((p) => norm(p) === norm(DIR));
	return { dir: DIR, present: at >= 0, first: at === 0 && parts[0].trim() === DIR };
}

/**
 * 把 shim 目录放到用户 PATH 最前面（幂等）。Windows 走 [Environment]::SetEnvironmentVariable，
 * 不用 setx（setx 在 >1024 字符时会截断）。
 */
export function ensureUserPath() {
	if (!WIN) return { changed: false, dir: DIR, how: `добавьте ${DIR} в начало PATH в rc-файле вашего shell: export PATH="${DIR}:$PATH"`, first: false };
	const read = spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: "utf8" });
	const current = (read.stdout ?? "").trim();
	const parts = current.split(";").filter(Boolean);
	// 合并连续反斜杠：上一版曾把 "C:\\Users\\..." 这种双反斜杠写进 PATH，
	// 归一后才能认出它是同一条并顺手清掉
	const norm = (s) => resolve(s.trim().replace(/\\{2,}/g, "\\"));
	const at = parts.findIndex((p) => norm(p).toLowerCase() === norm(DIR).toLowerCase());
	// 位置对还不够：得确认存的就是干净路径（曾被写成 "C:\\\\Users\\\\..."，位置对但 where 找不到）
	const clean = at === 0 && parts[0].trim() === DIR;
	if (clean) return { changed: false, dir: DIR, first: true, how: "уже в начале" };

	const next = [DIR, ...parts.filter((p) => norm(p).toLowerCase() !== norm(DIR).toLowerCase())];
	// PowerShell 单引号是字面量：用 '' 包住，内部单引号翻倍。绝不能走 JSON.stringify
	// （JSON 会把 \\ 写成 \\\\，写进 PATH 就变成带双反斜杠的废路径）
	const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
	const write = spawnSync(
		"powershell",
		["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('Path', ${psQuote(next.join(";"))}, 'User')`],
		{ encoding: "utf8" },
	);
	if (write.status !== 0) return { changed: false, dir: DIR, first: false, how: `не удалось записать пользовательский PATH: ${(write.stderr ?? "").trim()}` };
	return { changed: true, dir: DIR, first: true, how: at === 0 ? "грязный путь в PATH исправлен на месте" : "записано в пользовательский PATH(действует в новом терминале; disarm сам не убирает)" };
}
