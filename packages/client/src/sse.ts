import type { ReadableStream } from "node:stream/web";

// Parse an SSE byte stream into data payloads across chunks, line endings, and multi-line frames.
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i).replace(/\r$/, "");
			buffer = buffer.slice(i + 1);
			if (line === "") {
				if (data.length > 0) yield data.join("\n");
				data = [];
				continue;
			}
			if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
	}
}
