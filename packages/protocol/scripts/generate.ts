import { writeFile } from "node:fs/promises";
import { createOpenApiJson } from "../src/openapi.ts";

await writeFile(new URL("../openapi.json", import.meta.url), createOpenApiJson());
