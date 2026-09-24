// Provider-driver registry (ADR-0005): the one place `agent-exec` looks up a
// model runtime. A driver is a module under this directory exposing the
// provider interface (id, displayName, binaryEnvVar, defaultBinary,
// resolveBinary, checkVersion, readPolicy, renderPrompt, buildArgv, execute,
// parseTranscript, countToolCalls, normalizeUsage, normalizeResult,
// transcriptFilename, supportsMaxTurns, optional annotate — see claude.cjs,
// the reference driver). Adding a runtime is a registry entry plus a driver
// plus fixtures; agent-exec.cjs never changes.
//
// AMENDED by ADR-0031 (stage 94): that sentence covers making a runtime
// USABLE, not TRUSTED. This registry is the REACHABILITY gate — presence here
// makes a driver invocable by an explicit, interactive
// `verity agent-exec --agent <id>`. Whether the UNATTENDED worker may select it,
// whether it may run under `mode: autonomous`, and whether its review verdict
// may reach a merge are decided by a SEPARATE, ADR-gated entry in the
// engine-owned trust table (./tiers.cjs), backed by committed evidence of the
// runtime's real enforcement behavior. A runtime may ship registry-only —
// usable, un-trusted, refused by the worker — and that is the correct state for
// an incoming host contribution. Do NOT infer trust from membership here.
//
// `claude` (stage 7) is the reference driver and the DEFAULT agent; `codex`
// (stage 8, ADR-0005/0009) runs only on an explicit `--agent codex` — the
// worker cannot select it until stage 9.
const { AgentExecError } = require('./result-contract.cjs');

// Object.hasOwn needs Node 16.9 and engines allows 16.7, so own-key checks call
// the prototype method through this reference (Biome 2 flags the inline form).
const hasOwn = Object.prototype.hasOwnProperty;

const PROVIDERS = {
  claude: require('./claude.cjs'),
  codex: require('./codex.cjs'),
};

function listProviders() {
  return Object.keys(PROVIDERS);
}

// Unknown id → stable user-facing error naming the valid providers. Thrown as
// an AgentExecError so agent-exec maps it onto the existing unsupported-agent
// infra path (exit 30 + one stderr line), never a stack trace.
function getProvider(id) {
  if (!hasOwn.call(PROVIDERS, id)) {
    throw new AgentExecError(
      `unsupported agent '${id}' — supported providers: ${listProviders().join(', ')}`,
      'unsupported-agent',
    );
  }
  return PROVIDERS[id];
}

module.exports = { getProvider, listProviders };
