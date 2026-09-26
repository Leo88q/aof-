#!/usr/bin/env node
/**
 * [SECURITY_CHECKLIST #66] Blocking dependency audit for shipped code: any
 * high/critical vulnerability in the RUNTIME dependencies of frontend/,
 * aof_backend/ or the workspace root fails CI, unless every path to it ends in
 * an advisory reviewed in audit-allowlist.json (with a reason and an expiry).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TARGETS = ["frontend", "aof_backend", "."];
const HIGH = new Set(["high", "critical"]);
const allowlist = JSON.parse(readFileSync(new URL("../audit-allowlist.json", import.meta.url), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const allowed = new Set(allowlist.advisories.filter((a) => a.expires >= today).map((a) => a.url));
const failures = allowlist.advisories.filter((a) => a.expires < today).map((a) => `allowlist entry expired on ${a.expires}: ${a.url}`);

function audit(dir) {
  try {
    return JSON.parse(execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout); // npm exits non-zero when it finds anything
    throw e;
  }
}

for (const dir of TARGETS) {
  const vulns = audit(dir).vulnerabilities || {};
  const memo = new Map();
  const covered = (name, stack = new Set()) => {
    const v = vulns[name];
    if (!v || !HIGH.has(v.severity)) return true;
    if (memo.has(name)) return memo.get(name);
    if (stack.has(name)) return false;
    stack.add(name);
    const ok = v.via.every((via) => (typeof via === "string" ? covered(via, stack) : !HIGH.has(via.severity) || allowed.has(via.url)));
    stack.delete(name);
    memo.set(name, ok);
    return ok;
  };
  for (const [name, v] of Object.entries(vulns)) {
    if (HIGH.has(v.severity) && !covered(name)) failures.push(`${dir}: ${v.severity} ${name} (${v.range})`);
  }
}

if (failures.length) {
  console.error("audit gate FAILED - unreviewed high/critical runtime vulnerabilities:\n  " + failures.join("\n  "));
  console.error("Fix/upgrade, or add a reviewed entry (reason + expiry) to audit-allowlist.json.");
  process.exit(1);
}
console.log(`audit gate: no unreviewed high/critical runtime vulnerabilities in ${TARGETS.join(", ")}`);
