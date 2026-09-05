import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = {
	target: "http://127.0.0.1:5537",
	changeOrigin: true,
};

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/health": proxy,
			"/sessions": proxy,
			"/projects": proxy,
			"/documents": proxy,
			"/openapi.json": proxy,
		},
	},
});
