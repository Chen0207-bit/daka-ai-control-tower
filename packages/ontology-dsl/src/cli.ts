#!/usr/bin/env node
import { runCli } from "./validate";

process.exit(runCli(process.argv.slice(2)));
