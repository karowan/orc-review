#!/usr/bin/env node
// Source-run launcher: registers tsx, then hands off to the TypeScript CLI.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
