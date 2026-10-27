import { detect } from "./detect.mjs";
export async function doctor(argv) {
	const found = detect({ versions: argv.includes("--versions") });
	console.log("harness      найден бинарник                               конфиг-каталог             версия");
	for (const [id, d] of Object.entries(found)) {
		console.log(id.padEnd(12) + " " + (d.found ? "да" : "нет").padEnd(7) + (d.bin ?? "—").padEnd(38).slice(0, 38) + " " + (d.home ?? "").padEnd(24).slice(0, 24) + " " + (d.version ?? "—"));
	}
}
