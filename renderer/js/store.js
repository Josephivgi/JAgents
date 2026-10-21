// Shared renderer state: the agent catalogs, model catalogs per ACP agent, and
// a tiny event bus. Every view reads from here so two chat panes for the same
// agent show the same model list.

export const store = {
  info: null,
  acpAgents: [],
  terminalAgents: [],
  modelCache: {}, // harnessId -> {models, preferred, probing, error}
  chats: [],
  panes: [],
  hubAgents: [],
};

const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}

export function fire(type, payload) {
  for (const fn of listeners.get(type) || []) {
    try {
      fn(payload);
    } catch (error) {
      console.error(type, error);
    }
  }
}

export async function refreshAgents() {
  const out = await window.jagents.agents.list();
  store.acpAgents = out.acp;
  store.terminalAgents = out.terminal;
  fire("agents", store);
}

export async function refreshChats() {
  store.chats = await window.jagents.chats.list();
  fire("chats", store.chats);
}

export function mergeModelInfo(id, info) {
  const prev = store.modelCache[id] || {};
  const merged = Object.assign({}, prev, info);
  const prevHas = prev.models && prev.models.availableModels && prev.models.availableModels.length;
  const nextHas = info.models && info.models.availableModels && info.models.availableModels.length;
  if (prevHas && !nextHas) merged.models = prev.models;
  store.modelCache[id] = merged;
}

export async function refreshModelInfo(agentId) {
  try {
    const cached = store.modelCache[agentId];
    const hasModels = cached && cached.models && cached.models.availableModels && cached.models.availableModels.length;
    const agent = store.acpAgents.find((a) => a.id === agentId);
    let info = agent && agent.available && !hasModels ? await window.jagents.agents.probe(agentId) : await window.jagents.agents.modelInfo(agentId);
    // Effort levels not known yet (an agent not started since v0.5): probe
    // once for them, so threads can show the Effort picker before starting.
    if (agent && agent.available && info && info.efforts == null && !info.probing && !info.error) info = await window.jagents.agents.probe(agentId);
    mergeModelInfo(agentId, info);
    fire("models", agentId);
  } catch {
    /* probe results arrive through acp-models */
  }
}

export function agentName(id) {
  const a = store.acpAgents.find((x) => x.id === id) || store.terminalAgents.find((x) => x.id === id);
  return a ? a.name : id;
}
