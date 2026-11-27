/**
 * Runs the eval: every case in cases.mjs is put to a headless coding agent
 * twice, once with the Lichess MCP server as its only tool and once with no
 * tools at all, and the final answer is graded against the live API.
 *
 *   npm run build && node eval/run.mjs [--model sonnet] [--only id,id] [--skip-baseline]
 *
 * It drives Claude Code in print mode (`claude -p`). Results are written to
 * eval/results/<model>.json and summarised on stdout.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = parseArgs(process.argv.slice(2));
const model = args.model ?? "sonnet";
const only = args.only ? new Set(args.only.split(",")) : null;
const selected = cases.filter((testCase) => !only || only.has(testCase.id));

const TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `You answer questions about chess on Lichess.
Finish with a last line of the form "ANSWER: <value>" holding only the value asked for, with no explanation.
If the thing asked about does not exist on Lichess, the last line is "ANSWER: NOT_FOUND".
If you have no way to look up the data needed, do not guess: the last line is "ANSWER: UNKNOWN".`;

const workDir = join(here, ".tmp");
mkdirSync(workDir, { recursive: true });
const systemPromptFile = join(workDir, "system-prompt.txt");
writeFileSync(systemPromptFile, SYSTEM_PROMPT);
const mcpConfigFile = join(workDir, "mcp.json");
writeFileSync(
  mcpConfigFile,
  JSON.stringify({ mcpServers: { lichess: { command: process.execPath, args: [join(root, "dist", "index.js")] } } }),
);
const emptyMcpConfigFile = join(workDir, "mcp-empty.json");
writeFileSync(emptyMcpConfigFile, JSON.stringify({ mcpServers: {} }));

const conditions = [
  { name: "with-server", mcpConfig: mcpConfigFile, allowed: ["mcp__lichess"] },
  ...(args["skip-baseline"] ? [] : [{ name: "no-tools", mcpConfig: emptyMcpConfigFile, allowed: [] }]),
];

const rows = [];
for (const testCase of selected) {
  for (const condition of conditions) {
    const before = await testCase.truth();
    const run = await askAgent(testCase.question, condition);
    const after = await testCase.truth();
    const accepted = [...new Set([...before, ...after].map(String))];

    const answer = extractAnswer(run.text);
    const correct = answer !== null && testCase.grade(answer, accepted);
    const usedExpectedTool = run.toolCalls.some((call) => call.name === testCase.tool);
    rows.push({
      id: testCase.id,
      condition: condition.name,
      modelId: run.modelId,
      correct,
      answer,
      accepted,
      expectedTool: testCase.tool,
      usedExpectedTool,
      toolCalls: run.toolCalls,
      toolErrors: run.toolErrors,
      turns: run.turns,
      seconds: run.seconds,
      costUsd: run.costUsd,
      failure: run.failure,
    });
    const mark = correct ? "PASS" : "FAIL";
    const calls = run.toolCalls.map((call) => call.name).join(" > ") || "-";
    console.log(`${mark}  ${condition.name.padEnd(11)}  ${testCase.id.padEnd(28)}  answer=${answer}  accepted=${accepted.join("|")}  tools=${calls}`);
  }
}

const summary = conditions.map((condition) => summarise(condition.name));
const output = {
  model,
  // What the agent reported it ran on, which is what "sonnet" or "haiku" resolved to that day.
  modelIds: [...new Set(rows.map((row) => row.modelId).filter(Boolean))],
  agent: "Claude Code (claude -p)",
  date: new Date().toISOString(),
  cases: selected.length,
  summary,
  rows,
};
const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${model.replace(/[^a-z0-9.-]/gi, "_")}.json`);
if (!only) writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);

console.log("");
console.table(summary);
if (!only) console.log(`Written to ${file}`);

// ---------------------------------------------------------------------------

function summarise(condition) {
  const subset = rows.filter((row) => row.condition === condition);
  const sum = (pick) => subset.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const round = (value, digits) => Number(value.toFixed(digits));
  return {
    condition,
    correct: `${subset.filter((row) => row.correct).length}/${subset.length}`,
    expectedTool: `${subset.filter((row) => row.usedExpectedTool).length}/${subset.length}`,
    toolCalls: sum((row) => row.toolCalls.length),
    toolErrors: sum((row) => row.toolErrors),
    medianSeconds: round(median(subset.map((row) => row.seconds)), 1),
    totalCostUsd: round(sum((row) => row.costUsd), 3),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function extractAnswer(text) {
  const matches = [...text.matchAll(/^\s*\**ANSWER:\**\s*(.+?)\s*$/gim)];
  const last = matches.at(-1);
  return last ? last[1].replace(/^[`*"']+|[`*"']+$/g, "") : null;
}

/** One headless agent run. The question goes in on stdin, so no shell quoting is involved. */
function askAgent(question, condition) {
  const cliArgs = [
    "-p",
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--system-prompt-file", systemPromptFile,
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", condition.mcpConfig,
    "--setting-sources", "",
    "--max-turns", "12",
  ];
  if (condition.allowed.length > 0) cliArgs.push("--allowedTools", condition.allowed.join(","));

  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn("claude", cliArgs, { cwd: workDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // A run that stalls must not stall the eval: it is killed and counted as a failure.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise(emptyRun(started, `could not start claude: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const run = emptyRun(started, timedOut ? `no answer within ${TIMEOUT_MS / 1000} s` : undefined);
      run.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      for (const line of stdout.split("\n")) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "system" && event.subtype === "init") {
          run.modelId = event.model;
        } else if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_use") {
              run.toolCalls.push({ name: block.name.replace(/^mcp__lichess__/, ""), input: block.input });
            }
          }
        } else if (event.type === "user") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_result" && block.is_error) run.toolErrors += 1;
          }
        } else if (event.type === "result") {
          run.text = typeof event.result === "string" ? event.result : "";
          run.turns = event.num_turns;
          run.costUsd = event.total_cost_usd;
          if (event.is_error) run.failure = event.subtype ?? "error";
        }
      }
      if (code !== 0 && !run.failure) run.failure = `claude exited with ${code}: ${stderr.slice(0, 300)}`;
      resolvePromise(run);
    });
    child.stdin.end(question);
  });
}

function emptyRun(started, failure) {
  return {
    text: "",
    modelId: undefined,
    toolCalls: [],
    toolErrors: 0,
    turns: 0,
    costUsd: 0,
    failure,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}
