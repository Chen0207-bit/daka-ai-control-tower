#!/usr/bin/env node
import { runCli } from "./commands";

process.exit(runCli(process.argv.slice(2)));
