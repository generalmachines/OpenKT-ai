const baseUrl = process.env.MEMMACHINE_URL ?? "http://127.0.0.1:8091";
const runId = `mm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const orgId = `openkt-${runId}`;
const projectId = `server-${runId}`;
const producer = `pratham-${runId}`;

async function post(path, body, expected = [200, 201, 204]) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!expected.includes(res.status)) {
    throw new Error(`${path} returned ${res.status}: ${text}`);
  }
  return { status: res.status, body: json };
}

function summarizeSearch(result) {
  const content = result.body?.content ?? {};
  const longEpisodes =
    content.episodic_memory?.long_term_memory?.episodes ??
    content.episodic_memory?.episodes ??
    [];
  const shortEpisodes = content.episodic_memory?.short_term_memory?.episodes ?? [];
  const semantic = content.semantic_memory ?? [];

  return {
    status: result.status,
    longEpisodes: longEpisodes.map((episode) => ({
      uid: episode.uid,
      score: episode.score,
      content: String(episode.content ?? "").slice(0, 180),
      metadata: episode.metadata,
    })),
    shortEpisodes: shortEpisodes.map((episode) => ({
      uid: episode.uid,
      score: episode.score,
      content: String(episode.content ?? "").slice(0, 180),
      metadata: episode.metadata,
    })),
    semantic: semantic.map((feature) => ({
      id: feature.metadata?.id,
      category: feature.category,
      tag: feature.tag,
      feature: feature.feature_name,
      value: feature.value,
      citations: feature.metadata?.citations,
    })),
  };
}

await post("/api/v2/projects", {
  org_id: orgId,
  project_id: projectId,
  description: "OpenKT MemMachine focused spike",
});

const userSet = await post("/api/v2/memories/semantic/set_id/get", {
  org_id: orgId,
  project_id: projectId,
  is_org_level: true,
  metadata_tags: ["producer_id"],
  set_metadata: { producer_id: producer },
});
const userSetId = userSet.body?.set_id;

const category = await post("/api/v2/memories/semantic/category", {
  org_id: orgId,
  project_id: projectId,
  set_id: userSetId,
  category_name: "OpenKT Profile",
  prompt:
    "Extract durable OpenKT user/project memory facts. Keep preferences, decisions, owned systems, and operational constraints. Ignore one-off wording. Use concise feature names.",
  description: "User profile facts for OpenKT agents",
});

const messages = [
  "Pratham prefers MiniMax M2.5 for local OpenKT tests because MiniMax M2.7 is denied by the current dev key.",
  "OpenKT uses RabbitMQ for memory pipeline synthesis and BGE-M3 for embedding generation.",
  "Pratham wants OpenKT Prime to return memories, project briefing, and activity context for agents, without skills or workflows in v1.",
  "OpenKT CLI init registers a repository project so the dashboard can show that project.",
  "OpenKT should keep embeddings behind a private internal service in production rather than exposing the local dev embedding host publicly.",
];

const add = await post("/api/v2/memories", {
  org_id: orgId,
  project_id: projectId,
  types: ["episodic", "semantic"],
  messages: messages.map((content) => ({
    content,
    role: "user",
    producer,
    metadata: {
      producer_id: producer,
      user_id: producer,
      source: "openkt-focused-spike",
      run_id: runId,
    },
  })),
});

// MemMachine semantic/profile extraction is async and batches on a
// five-message threshold by default.
await new Promise((resolve) => setTimeout(resolve, 12_000));

const recall = await post("/api/v2/memories/search", {
  org_id: orgId,
  project_id: projectId,
  query: "Which MiniMax model should OpenKT use locally and what does Prime return?",
  top_k: 5,
  types: ["episodic", "semantic"],
  set_metadata: { producer_id: producer },
  agent_mode: false,
});

const listEpisodic = await post("/api/v2/memories/list", {
  org_id: orgId,
  project_id: projectId,
  page_size: 10,
  page_num: 0,
  type: "episodic",
});

const listSemantic = await post("/api/v2/memories/list", {
  org_id: orgId,
  project_id: projectId,
  page_size: 10,
  page_num: 0,
  type: "semantic",
  set_metadata: { producer_id: producer },
});

console.log(
  JSON.stringify(
    {
      runId,
      orgId,
      projectId,
      producer,
      userSetId,
      categoryStatus: category.status,
      addResults: add.body?.results,
      recall: summarizeSearch(recall),
      listEpisodicCount:
        listEpisodic.body?.content?.episodic_memory?.length ??
        listEpisodic.body?.content?.episodic_memory?.long_term_memory?.episodes?.length ??
        null,
      listSemantic: summarizeSearch(listSemantic).semantic,
    },
    null,
    2,
  ),
);
