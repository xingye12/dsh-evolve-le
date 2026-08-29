#!/usr/bin/env node
/**
 * `dsh-evolve` bin entry (Gate 5): thin process wrapper around `cliMain`.
 * All command logic lives in cli.ts so tests can drive it in-process.
 * @module @dsh-evolve-le/cli/main
 */
import { cliMain } from './cli.js'

process.exitCode = await cliMain(process.argv.slice(2))
