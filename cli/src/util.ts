import fs from "fs";

export function ensureNttRoot(pwd = ".") {
	if (
		!fs.existsSync(`${pwd}/evm/foundry.toml`) ||
		!fs.existsSync(`${pwd}/solana/Anchor.toml`)
	) {
		console.error("Run this command from the root of an NTT project.");
		process.exit(1);
	}
}
