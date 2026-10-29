import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSdkManifest } from '../agent-host/sdk-compat.mjs';

const SDK_ROOT = process.env.AYLACHI_SDK_ROOT;
const NODE = process.execPath;
assert.ok(SDK_ROOT, "set AYLACHI_SDK_ROOT to the selected Pi SDK package directory");
const ENV = "/usr/bin/env";
const SCRATCH_ROOT = "/tmp/aylachi-l06-skills-integration";
const TEST_FILE = fileURLToPath(import.meta.url);
const FIXTURE_FILE = fileURLToPath(new URL("./skills-sdk-fixture.md", import.meta.url));
const WORKER_ARG = "--skills-loader-worker";

async function runSdkWorker() {
  const envKeys = [
    "AYLACHI_SDK_ROOT", "HOME", "L06_AGENT_DIR", "L06_PROJECT_CWD", "L06_SCRATCH_ROOT",
    "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  ].sort();
  assert.deepEqual(Object.keys(process.env).sort(), envKeys, "env -i child must receive only explicit test variables");
  assert.equal(process.env.AYLACHI_SDK_ROOT, SDK_ROOT);
  assert.equal(path.resolve(process.env.L06_SCRATCH_ROOT), SCRATCH_ROOT);

  const scratch = path.resolve(process.env.L06_SCRATCH_ROOT);
  const home = path.resolve(process.env.HOME);
  const agentDir = path.resolve(process.env.L06_AGENT_DIR);
  const cwd = path.resolve(process.env.L06_PROJECT_CWD);
  assert.ok(home.startsWith(`${scratch}/`));
  assert.ok(agentDir.startsWith(`${scratch}/`));
  assert.ok(cwd.startsWith(`${scratch}/`));
  assert.equal(path.resolve(process.env.TMPDIR).startsWith(`${scratch}/`), true);
  assert.equal(path.resolve(process.env.XDG_CONFIG_HOME).startsWith(`${scratch}/`), true);
  assert.equal(path.resolve(process.env.XDG_DATA_HOME).startsWith(`${scratch}/`), true);
  assert.equal(path.resolve(process.env.XDG_CACHE_HOME).startsWith(`${scratch}/`), true);
  assert.equal(path.resolve(process.cwd()), cwd);
  assert.deepEqual(await readdir(home), [], "temporary HOME must contain no user skills or auth");

  const manifest = JSON.parse(await readFile(path.join(SDK_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
  assertSdkManifest(manifest);
  assert.equal(manifest.exports["."].import, "./dist/index.js");
  const entrypoint = path.join(SDK_ROOT, manifest.exports["."].import);
  const sdk = await import(pathToFileURL(entrypoint).href);
  assert.equal(typeof sdk.DefaultResourceLoader, "function");
  assert.equal(typeof sdk.SettingsManager?.inMemory, "function");

  const settingsManager = sdk.SettingsManager.inMemory();
  assert.deepEqual(settingsManager.getSkillPaths(), []);
  assert.deepEqual(settingsManager.getExtensionPaths(), []);
  assert.deepEqual(settingsManager.getPackages(), []);

  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [],
    additionalExtensionPaths: [],
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
    additionalThemePaths: [],
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Isolated L06 skills fixture",
    appendSystemPrompt: [],
  });
  await loader.reload();

  const { skills, diagnostics } = loader.getSkills();
  assert.deepEqual(diagnostics, []);
  assert.equal(skills.length, 1, "only the isolated project skill should be discovered");
  const [skill] = skills;
  const expectedSkillPath = path.join(cwd, ".pi", "skills", "l06-skills-fixture", "SKILL.md");
  assert.equal(skill.name, "l06-skills-fixture");
  assert.equal(skill.description, "Synthetic skill fixture for the selected Pi SDK loader test.");
  assert.equal(skill.filePath, expectedSkillPath);
  assert.equal(skill.baseDir, path.dirname(expectedSkillPath));
  assert.equal(skill.disableModelInvocation, true);
  assert.equal(skill.sourceInfo.scope, "project");
  assert.equal(skill.sourceInfo.path, expectedSkillPath);
  assert.deepEqual(Object.keys(skill).sort(), [
    "baseDir", "description", "disableModelInvocation", "filePath", "name", "sourceInfo",
  ]);
  assert.equal(skills.some((item) => item.name === "l06-global-decoy"), false);
  assert.equal(skills.some((item) => item.name === "l06-unselected-decoy"), false);
  assert.equal(globalThis.__AYLACHI_L06_SKILL_BODY_EXECUTED__, undefined, "skill body must remain inert Markdown");

  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.deepEqual(loader.getThemes().themes, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.equal(loader.getSystemPrompt(), "Isolated L06 skills fixture");
  assert.deepEqual(loader.getAppendSystemPrompt(), []);

  console.log(JSON.stringify({
    node: process.version,
    sdk: `${manifest.name}@${manifest.version}`,
    sdkRoot: SDK_ROOT,
    entrypoint,
    importUrl: pathToFileURL(entrypoint).href,
    discovered: skills.map(({ name, description, filePath, baseDir, disableModelInvocation, sourceInfo }) => ({
      name, description, filePath, baseDir, disableModelInvocation, sourceInfo,
    })),
    decoysExcluded: true,
    skillBodyExecuted: false,
    configuredPackages: 0,
    configuredSkillPaths: 0,
    configuredExtensionPaths: 0,
  }));
}

if (process.argv.at(-1) === WORKER_ARG) {
  await runSdkWorker();
} else {
  const { default: test } = await import("node:test");
  test("selected Pi SDK DefaultResourceLoader discovers only isolated inert skill data", async (t) => {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    const root = await mkdtemp(path.join(SCRATCH_ROOT, "run-"));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
      try {
        await rmdir(SCRATCH_ROOT);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      }
    });

    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const xdgConfig = path.join(root, "xdg-config");
    const xdgData = path.join(root, "xdg-data");
    const xdgCache = path.join(root, "xdg-cache");
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const selectedDir = path.join(cwd, ".pi", "skills", "l06-skills-fixture");
    const unselectedDir = path.join(cwd, "unselected", "skills");
    const globalDecoyDir = path.join(agentDir, "unselected-global");
    await Promise.all([
      home, tmp, xdgConfig, xdgData, xdgCache,
      path.join(agentDir, "skills"), selectedDir, unselectedDir, globalDecoyDir,
    ].map((dir) => mkdir(dir, { recursive: true })));

    await copyFile(FIXTURE_FILE, path.join(selectedDir, "SKILL.md"));
    await Promise.all([
      writeFile(path.join(unselectedDir, "SKILL.md"), "---\nname: l06-unselected-decoy\ndescription: Must not be discovered.\n---\n", "utf8"),
      writeFile(path.join(globalDecoyDir, "SKILL.md"), "---\nname: l06-global-decoy\ndescription: Must not be read from an unselected global path.\n---\n", "utf8"),
    ]);

    const envEntries = [
      `PATH=${path.dirname(NODE)}:/usr/bin:/bin`,
      `HOME=${home}`,
      `TMPDIR=${tmp}`,
      `XDG_CONFIG_HOME=${xdgConfig}`,
      `XDG_DATA_HOME=${xdgData}`,
      `XDG_CACHE_HOME=${xdgCache}`,
      `AYLACHI_SDK_ROOT=${SDK_ROOT}`,
      `L06_SCRATCH_ROOT=${SCRATCH_ROOT}`,
      `L06_AGENT_DIR=${agentDir}`,
      `L06_PROJECT_CWD=${cwd}`,
    ];
    const childArgs = ["-i", ...envEntries, NODE, TEST_FILE, WORKER_ARG];
    const result = spawnSync(ENV, childArgs, {
      cwd,
      env: {},
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, `isolated worker launch failed: ${result.error?.message}\n${result.stderr}`);
    assert.equal(result.signal, null, `isolated worker was signalled: ${result.signal}\n${result.stderr}`);
    assert.equal(result.status, 0, `isolated worker failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    const output = result.stdout.trim();
    assert.ok(output, "worker must report its exact SDK import identity and fixture result");
    const workerResult = JSON.parse(output.split("\n").at(-1));
    const manifest = JSON.parse(await readFile(path.join(SDK_ROOT, 'package.json'), 'utf8'));
    assertSdkManifest(manifest);
    assert.equal(workerResult.sdk, `${manifest.name}@${manifest.version}`);
    assert.equal(workerResult.node, process.version);
    assert.deepEqual(workerResult.discovered.map((skill) => skill.name), ["l06-skills-fixture"]);
    assert.equal(workerResult.decoysExcluded, true);
    assert.equal(workerResult.skillBodyExecuted, false);
    console.log(JSON.stringify({
      workerCommand: [ENV, ...childArgs],
      workerCwd: cwd,
      workerOutput: output,
    }));
  });
}
