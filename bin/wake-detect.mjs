#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROMPT_LINE = /^\s*[❯›»]\s?/u;
const PANE_SEPARATOR = /[─━═-]{4,}.*(?:hub|spk)\.[A-Za-z0-9._-]+/u;

function normalize(text) {
  return String(text || "").replaceAll("\r", "");
}

function containsPrefix(lines, prefix) {
  if (!prefix) return false;
  const text = lines.join("\n");
  if (text.includes(prefix)) return true;
  const compactText = lines.join(" ").replace(/\s+/gu, " ");
  const compactPrefix = prefix.replace(/\s+/gu, " ");
  return compactText.includes(compactPrefix);
}

// Returns the zero-based first line of the input region, or null when this
// viewport has no recognized boundary. Claude uses ❯ and Codex uses ›. Kimi's
// marker remains unverified; the pane-title separator is the generic fallback.
export function locateInputLine(screen) {
  const lines = normalize(screen).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (PROMPT_LINE.test(lines[index])) return index;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (PANE_SEPARATOR.test(lines[index])) return index + 1;
  }
  return null;
}

export function detectWake(screen, prefix) {
  const lines = normalize(screen).split("\n");
  const inputLine = locateInputLine(screen);
  if (inputLine === null) return { inputLine: null, draft: false, submitted: false };
  return {
    inputLine,
    draft: containsPrefix(lines.slice(inputLine), prefix),
    submitted: containsPrefix(lines.slice(0, inputLine), prefix),
  };
}

function runSelfTest() {
  const prefix = "A durable GSB contract or mailbox message is available for coder.";
  const cases = [
    {
      name: "Claude prompt detects a draft",
      screen: `history\n──── spk.demo.coder ────\n❯ ${prefix}\n────`,
      expected: { inputLine: 2, draft: true, submitted: false },
    },
    {
      name: "Codex prompt detects a draft",
      screen: `history\n› ${prefix}\nstatus`,
      expected: { inputLine: 1, draft: true, submitted: false },
    },
    {
      name: "history occurrence is submitted",
      screen: `${prefix}\nresponse\n──── spk.demo.coder ────\n❯ \nstatus`,
      expected: { inputLine: 3, draft: false, submitted: true },
    },
    {
      name: "history and input occurrences are distinguished",
      screen: `${prefix}\nresponse\n──── spk.demo.coder ────\n❯ ${prefix}\nstatus`,
      expected: { inputLine: 3, draft: true, submitted: true },
    },
    {
      name: "separator fallback handles an unverified prompt marker",
      screen: `history\n──── spk.demo.coder ────\n$ ${prefix}\nstatus`,
      expected: { inputLine: 2, draft: true, submitted: false },
    },
    {
      name: "wrapped prefix is detected in the input region",
      screen: `history\n❯ A durable GSB contract or mailbox message is\n  available for coder.\nstatus`,
      expected: { inputLine: 1, draft: true, submitted: false },
    },
    {
      name: "no prefix reports neither state",
      screen: "history\n──── spk.demo.coder ────\n❯ \nstatus",
      expected: { inputLine: 2, draft: false, submitted: false },
    },
    {
      name: "empty screen is unsupported",
      screen: "",
      expected: { inputLine: null, draft: false, submitted: false },
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    const actual = detectWake(testCase.screen, prefix);
    if (JSON.stringify(actual) === JSON.stringify(testCase.expected)) {
      console.log(`ok: ${testCase.name}`);
    } else {
      failed += 1;
      console.error(`FAIL: ${testCase.name}`);
      console.error(`  expected ${JSON.stringify(testCase.expected)}`);
      console.error(`  actual   ${JSON.stringify(actual)}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} self-test(s) failed`);
    process.exit(1);
  }
  console.log("\nall wake-detect self-tests passed");
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === "--selftest") {
  runSelfTest();
} else if (isMain) {
  const prefix = process.argv[2] || "";
  if (!prefix) {
    console.error("Usage: node bin/wake-detect.mjs PREFIX < screen.txt");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(detectWake(await readStdin(), prefix))}\n`);
}
