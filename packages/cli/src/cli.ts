#!/usr/bin/env node
import { run } from "./index.ts";

run().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
