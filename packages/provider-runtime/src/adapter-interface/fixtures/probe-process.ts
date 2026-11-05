// The probe adapter served in a process of its own (`own-process.test.ts`).
import { serveModelAdapterProcess } from "../own-process.ts";
import { createProbeAdapter } from "./probe-adapter.ts";

await serveModelAdapterProcess(createProbeAdapter);
