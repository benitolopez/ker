import { setTimeout as sleep } from "node:timers/promises";
import { acquireLock } from "../../src/lock.ts";

// Test helper: acquire the lock, print "held", hold it, then release, or exit still holding it
// when told "no-release" to simulate a crash. Usage: hold-lock.ts <path> <acquireMs> <holdMs> [no-release]
const [, , path, acquireMs, holdMs, mode] = process.argv;
const lock = await acquireLock(path, Number(acquireMs));
console.log("held");
await sleep(Number(holdMs));
if (mode !== "no-release") lock.release();
