import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const path = new URL("./registry.json", import.meta.url);
const registry = JSON.parse(await readFile(path, "utf8"));
const byId = new Map(registry.components.map((component) => [component.id, component]));

test("registry preserves historical probe scope and records only bounded current proofs", () => {
  assert.equal(registry.format, 1);
  assert.equal(byId.size, registry.components.length, "component IDs stay unique");

  assert.equal(byId.get("pi-sdk-helper-tree").status, "PRESENT_NOT_SELECTED_HOST");
  const host = byId.get("pi-native-session-host");
  assert.equal(host.status, "PASS_SCOPED");
  assert.deepEqual(host.historical_probe.not_verified_at_probe,
    ["tool execution", "MCP routing", "real provider", "extension execution", "OS isolation"]);
  assert.ok(host.verified.includes("actual selected-SDK tool execution through createPiAdapter with a synthetic ModelRuntime"));
  assert.ok(!host.not_verified.includes("tool execution"));
  assert.ok(host.not_verified.includes("general provider interoperability beyond the bounded live delegation record"));
  assert.equal(host.evidence.adapter_fixture.test_sha256,
    "af65ae1a683fe5b02de847af1fa42b0daf6b52dcb41f080bed994c15ea6360a1");

  const skills = byId.get("skills");
  assert.equal(skills.status, "PASS_SCOPED");
  assert.equal(skills.evidence.version, "1.3.0");
  assert.equal(skills.evidence.node, "22.23.2");
  assert.equal(skills.evidence.source_sha256, "974e16acfa8e01039f32d0e09ee742d912332f9ddc74fce9f688694304f4948f");
  assert.deepEqual(skills.evidence.parent_verification, {
    log: "ORCH/skills-sdk-parent-test.log",
    log_sha256: "0699911e164dafaf7aa80348ec89b9f3c9fd55cfabae48f6e72e98eb0136c2cc",
    node: "22.23.2",
    selected_sdk_test: "1/1",
    full_root_suite: "77/77",
    failures: 0,
    skips: 0,
  });
  assert.deepEqual(skills.not_verified, ["execution of skill instructions", "model invocation", "Desktop skill activation", "global profile parity"]);
  assert.ok(skills.verified.includes("skill Markdown remained inert and was not executed"));

  const explicitSkills = byId.get("pi-adapter-opt-in-skill-selection");
  assert.equal(explicitSkills.status, "PASS_SCOPED");
  assert.ok(explicitSkills.verified.some(value => value.includes("includeDefaults:false")));
  assert.ok(explicitSkills.verified.some(value => value.includes("default adapter loader leaves skills")));
  assert.ok(explicitSkills.not_verified.includes("global Pi profile or Desktop skill activation"));

  const surfaces = byId.get("mcp-tools-subagents-projects");
  assert.equal(surfaces.status, "PARTIAL_SCOPED_CURRENT_PROOFS");
  assert.equal(surfaces.historical_probe.status, "PARTIAL_NATIVE_MCP_SCOPED_PASS");
  assert.deepEqual(surfaces.historical_probe.surfaces_at_original_probe, {
    native_mcp: "PASS_SCOPED", external_adapters: "NOT_RUN", subagents: "NOT_RUN",
    project_adapter: "NOT_RUN", other_tools: "NOT_RUN",
  });
  assert.match(surfaces.historical_probe.meaning_at_original_probe, /only; it does not certify/);
  assert.equal(surfaces.surfaces.native_mcp, "PASS_SCOPED");
  assert.equal(surfaces.surfaces.pi_adapter_mcp_lifecycle, "PASS_SCOPED");
  assert.equal(surfaces.surfaces.pi_adapter_tool_execution, "PASS_SCOPED");
  assert.equal(surfaces.surfaces.provider, "PASS_BOUNDED_LIVE_SAME_PROCESS");
  assert.equal(surfaces.surfaces.delegate_task, "PASS_SCOPED");
  assert.equal(surfaces.surfaces.subagents, "PASS_SCOPED_DELEGATION_TOOL_ONLY");
  assert.equal(surfaces.surfaces.project_adapter, "PASS_ONE_SYNTHETIC_CANARY");
  assert.equal(surfaces.surfaces.external_adapters, "NOT_RUN");
  assert.ok(surfaces.limits.some(value => value.includes("not Pi subagents package parity")));
  assert.match(surfaces.historical_probe.evidence.historical_attempts, /default MCP config seam/);

  const adapterMcp = byId.get("pi-adapter-mcp-lifecycle");
  assert.equal(adapterMcp.status, "PASS_SCOPED");
  assert.equal(adapterMcp.evidence.test_sha256, "37fbddfa426ebf3695919b00d74e3a3a33358ac4ad2f757aa31e4d938dbdc8fb");
  assert.ok(adapterMcp.not_verified.includes("real provider behavior"));

  const delegation = byId.get("delegate-task-sdk-hub-sqlite");
  assert.equal(delegation.status, "PASS_SCOPED");
  assert.equal(delegation.evidence.integration_test_sha256, "0e8d4a07045fc4dadc2a8629b8e538a5f6abb16aa416f2fafd88aa5c59684e75");
  assert.match(delegation.evidence.result, /^33\/33 development tests passed/);
  assert.equal(delegation.evidence.sdk, "@earendil-works/pi-coding-agent@1.3.0");
  assert.ok(delegation.not_verified.includes("production grants, approvals, budget/model enforcement, or sandbox isolation"));

  const live = byId.get("delegate-task-bounded-live-run");
  assert.equal(live.status, "PASS_BOUNDED_LIVE_SAME_PROCESS");
  assert.equal(live.evidence.live_run_attempts, 1);
  assert.equal(live.evidence.sdk_stream_calls, 4);
  assert.equal(live.evidence.child_tool_calls, 1);
  assert.equal(live.evidence.backend_output_limit_verified, false);
  assert.equal(live.evidence.initial_runtime_receipt_history_status, "UNVERIFIED_NOT_ATTEMPTED");
  assert.match(live.evidence.later_public_sdk_history_reopen, /zero new model calls/);

  const canary = byId.get("project-context-fixed-helper-canary");
  assert.equal(canary.status, "PASS_ONE_SYNTHETIC_CANARY");
  assert.equal(canary.evidence.archive_sha256, "6120da07cc0fa479a120addb123242791ecfc94890d133a5100e00e9a26568d8");
  assert.equal(canary.evidence.archive_member_hashes_verified, true);
  assert.equal(canary.evidence.fixed_helper_path, "/home/ayla/.pi/agent/scripts/ayla_pi_baza.py");
  assert.equal(canary.evidence.fixed_helper_operation, "read");
  assert.equal(canary.evidence.helper_mode, "default createBazaReader execFile branch; no execFileForTest injection; fixed helper read only");
  assert.equal(canary.evidence.composition_test_sha256, "2447996ed5df76a6486608b211f1c88590779b78d248461a18e55b8de4d8dd61");
  assert.deepEqual(canary.evidence.counts, {
    helper_reads: 1, authorizations: 1, synthetic_model_calls: 2, real_model_calls: 0, note_writes_by_runtime: 0,
  });
  assert.equal(canary.evidence.history_reopen_did_not_repeat_helper, true);
  assert.ok(canary.not_verified.includes("project registry/prefix authority or FTS/search"));
  assert.ok(canary.not_verified.includes("native, production, or USE-02/V1 acceptance"));

  const hermes = byId.get("pi-hermes-memory-extension-source");
  assert.equal(hermes.status, "SOURCE_INSPECTED_HOST_COMPAT_NOT_RUN");
  assert.match(hermes.evidence.declared_sdk_gate, /0\.85\.1/);
  const memory = byId.get("memory-ownership");
  assert.equal(memory.status, "OWNER_APPROVED_DESIGN_NOT_RUNTIME_TESTED");
  assert.equal(registry.owner_decisions.old_stores, "no migration");
  assert.equal(registry.owner_decisions.review, "off");
  assert.equal(memory.review, undefined);
  assert.equal(memory.restriction.includes("migration"), true);
  assert.ok(registry.global_limits.some(value => value.includes("no whole-product PASS follows")));
});
