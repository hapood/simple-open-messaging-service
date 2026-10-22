#!/usr/bin/env node
// Shim so the Tauri Android gradle plugin can invoke the JS CLI.
//
// gen/android/buildSrc/.../BuildTask.kt runs `node tauri android android-studio-script` with
// workingDir = src-tauri, so node resolves the entry `tauri` to THIS file. This repo isn't laid out
// like a stock `create-tauri-app` project (which puts @tauri-apps/cli at the workspace root, i.e. the
// parent of src-tauri): here the repo-root package.json is the NestJS backend, and the @tauri-apps/cli
// install lives in the frontend's node_modules (../web). A bare `tauri` package therefore can't resolve
// from src-tauri, so forward every invocation to the CLI's bin entry. The CLI parses process.argv from
// index 2 — gradle's own args (`android android-studio-script …`) populate that slice unchanged.
//
// The repo root is `"type": "module"`, so this file is ESM; createRequire bridges into the CLI's
// CommonJS bin entry (it runs the CLI as a side effect of the require).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
require('../web/node_modules/@tauri-apps/cli/tauri.js')
