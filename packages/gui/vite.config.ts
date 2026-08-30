import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = {
	target: "http://127.0.0.1:5537",
	changeOrigin: true,
};

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@ker-ai/client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
			"@ker-ai/protocol/routes": fileURLToPath(new URL("../protocol/src/routes.ts", import.meta.url)),
			"@ker-ai/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
		},
	},
	server: {
		proxy: {
			"/health": proxy,
			"/sessions": proxy,
			"/projects": proxy,
			"/openapi.json": proxy,
		},
	},
});
