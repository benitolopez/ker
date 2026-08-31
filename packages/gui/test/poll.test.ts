import { assert, test } from "vitest";
import { type PollEnvironment, startVisiblePoll } from "../src/store/poll.ts";

test("polls while visible and refetches on focus and visibility changes", async () => {
	let visible = true;
	let interval: (() => void) | undefined;
	let focus: (() => void) | undefined;
	let visibility: (() => void) | undefined;
	let cleared = false;
	let count = 0;
	const environment: PollEnvironment = {
		isVisible: () => visible,
		setInterval: (callback, intervalMs) => {
			assert.equal(intervalMs, 25);
			interval = callback;
			return "timer";
		},
		clearInterval: (handle) => {
			assert.equal(handle, "timer");
			cleared = true;
		},
		onFocus: (callback) => {
			focus = callback;
			return () => {
				focus = undefined;
			};
		},
		onVisibilityChange: (callback) => {
			visibility = callback;
			return () => {
				visibility = undefined;
			};
		},
	};
	const stop = startVisiblePoll(
		() => {
			count++;
		},
		{ intervalMs: 25, environment },
	);
	await Promise.resolve();
	assert.equal(count, 1);
	interval?.();
	await Promise.resolve();
	assert.equal(count, 2);
	visible = false;
	focus?.();
	visibility?.();
	interval?.();
	await Promise.resolve();
	assert.equal(count, 2);
	visible = true;
	visibility?.();
	await Promise.resolve();
	assert.equal(count, 3);

	stop();
	assert.equal(cleared, true);
	assert.equal(focus, undefined);
	assert.equal(visibility, undefined);
	interval?.();
	assert.equal(count, 3);
});

test("does not overlap a slow refetch", async () => {
	const pending = Promise.withResolvers<void>();
	let interval: (() => void) | undefined;
	let count = 0;
	const environment: PollEnvironment = {
		isVisible: () => true,
		setInterval: (callback) => {
			interval = callback;
			return 1;
		},
		clearInterval: () => undefined,
		onFocus: () => () => undefined,
		onVisibilityChange: () => () => undefined,
	};
	const stop = startVisiblePoll(
		async () => {
			count++;
			await pending.promise;
		},
		{ environment },
	);
	interval?.();
	assert.equal(count, 1);
	pending.resolve();
	await pending.promise;
	await Promise.resolve();
	interval?.();
	assert.equal(count, 2);
	stop();
});
