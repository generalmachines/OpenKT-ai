> Research report, 2026-09-19. Agent-gathered from primary sources; unverified items are listed at the end of each report.

Every job has a licence-clean small model with an MLX conversion, and the embedder should stay BGE-M3. All repo ids, licences, parameter counts and MLX weight sizes below come from the HF API and model cards today; every id resolves at `https://huggingface.co/<id>`. No model was run, so benchmark numbers are vendor-reported, including the two I rely on most (Liquid's and NuMind's cards).

The small-model field has moved since 2025. Current generations are Qwen3.5 (0.8/2/4/9B, all VLMs), Gemma 4 (E2B/E4B, now Apache-2.0), Granite 4.2, LFM2.5 and NuExtract3. Qwen3.6 and 3.8 have no small sizes.

### 1–3. Extract, classify, merge-decide
| Model | Params / licence / context | MLX 4-bit | Notes |
|---|---|---|---|
| **google/gemma-4-E4B-it (default)** | 8B (E4B = "effective 4B") / Apache-2.0 / 128K | `mlx-community/gemma-4-e4b-it-4bit`, 5.15 GB | IFStruct 76.7, Multi-IF 77.4. On NuMind's extraction bench it scored 0.538 with 31 unparseable outputs out of ~600. Supports 35+ languages and was pretrained on 140+; Thai/Hindi not checked on the card. |
| numind/NuExtract3 (extraction specialist) | 4.5B, a Qwen3.5-4B fine-tune / Apache-2.0 | `numind/NuExtract3-mlx-4bits`, 3.03 GB | Scored 0.651 on NuMind's own bench with 27 failures. Accepts text and images and handles enum-based classification. Its JSON template is passed via `chat_template_kwargs`, which is non-standard and hurts hot-swap. |
| Qwen/Qwen3.5-4B | 4.7B / Apache-2.0 / 262K | `mlx-community/Qwen3.5-4B-MLX-4bit`, 3.03 GB | Weak at structure when unconstrained: IFStruct 36.3, and 229 of ~600 failures on the same bench from thinking-mode loops. Only use it with thinking off and schema-constrained decoding. Covers 201 languages. |

- **LFM2.5-2.6B:** 1.58 GB at 4-bit with the best IFStruct (85.5), and Thai and Hindi are listed explicitly. It ships under the LFM Open License v1.0, which allows commercial use only below $10M annual revenue, so it can't be the default. It also always thinks before answering.
- **LFM2-1.2B-Extract / 350M-Extract / RAG / Tool:** same LFM licence, Sept 2025 vintage, 9 languages with no Thai or Hindi, single-turn only. No MLX repo found.
- **Osmosis-Structure-0.6B:** Apache-2.0 but stale (May 2025) with no MLX conversion.
- **Memory-specialised models:** driaforall/mem-agent (4B, MLX conversion exists) and Memalpha-4B carry no licence metadata. RL-MemoryAgent is 7B or larger. None are usable here.
- **fastino/gliner2.5-multi-v1:** 287M, Apache-2.0, multilingual tagging and classification with no generation. It would make a good cheap tagger, but no MLX route was found (not thoroughly searched).
- **ibm-granite/granite-4.2-3b:** Apache-2.0, official `granite-4.2-3b-q4-mlx` at 2.06 GB. Its tested languages exclude Thai and Hindi.

### 4. Summarise
**Default: Gemma-4-E4B**, the same resident model with 128K context. Qwen3.5-4B offers 262K. LFM2-2.6B-Transcript (`mlx-community/LFM2-2.6B-Transcript-4bit`) is purpose-built for meetings but is English-only and under the LFM licence.

### 5. Vision (VLM)
**Default: Qwen3.5-4B.** Per Liquid's card it leads at this size on MMMU-Pro (60.9), English OCRBench-v2 (58.8), MuirBench (67.0) and ChartQA (84.2), and scores 78.5 on ScreenSpot-v2.
- Gemma-4-E4B is weak on screens: ScreenSpot 50.9 and ChartQA 41.9.
- LFM2.5-VL-3B (2.37 GB) scores 80.7 on ScreenSpot with 32K context, but it is under the LFM licence.
- ibm-granite/granite-vision-4.1-4b is Apache-2.0 but English-only.

### 6. Embeddings: keep BGE-M3
BGE-M3 is MIT-licensed, 1024-d, 8K context and covers 100+ languages.

Faithful routes on Mac:
- **mlx-swift-lm** `MLXEmbedders` registers `BAAI/bge-m3` and maps xlm-roberta to its BERT path, so it runs in-process. Its pooling default for BGE-M3 was not checked.
- **`mlx-community/bge-m3-mlx-fp16`** is 1.14 GB.
- **llama.cpp or Ollama GGUF** (`ggml-org/bge-m3-Q8_0-GGUF`) run with `--pooling cls`.
- **The official ONNX export** lives inside `BAAI/bge-m3/onnx`.

Two traps:
- The mlx-community card's sample code uses mean pooling, while BGE-M3 dense vectors use CLS pooling plus L2 normalisation.
- Bit-exact parity across runtimes is impossible, so gate releases on a golden-vector test (cosine ≥0.999, including Thai and Hindi strings). I did not measure parity.
- Use fp16, not 4/8-bit, to stay close to the server's vectors.

Alternatives and why not:
- **Qwen3-Embedding-0.6B:** the only migration worth a full reindex. Apache-2.0, also 1024-d, 32K context, `…-4bit-DWQ` at 0.34 GB. It scores 64.3 on multilingual MTEB against BGE-M3's 59.6, by Qwen's own table.
- **EmbeddingGemma:** 768-d and under the Gemma licence, not Apache.
- **jina-embeddings-v5:** CC-BY-NC. NVIDIA's embed model uses its own licence.
- **granite-embedding-311m-multilingual-r2:** Apache-2.0, 768-d, Thai and Hindi both listed. No MLX conversion found.

The embedder must not be user-swappable; pin the model id and dimension in the index metadata.

### 7. Reranker
**Default: Qwen3-Reranker-0.6B.** Apache-2.0, 32K context, `mlx-community/Qwen3-Reranker-0.6B-4bit` at 0.34 GB. Multilingual retrieval score is 66.4, and bge-reranker-v2-m3's is 58.4 (both as I recall Qwen's table; the fetch confirmed only the bge row).
- BAAI/bge-reranker-v2-m3 is Apache-2.0 and runs natively on llama.cpp `/v1/rerank`.
- jina-reranker-v3 is CC-BY-NC, so avoid it.

### RAM budgets
| Bundle | Text | Vision | Embeddings | Reranker | Peak with KV cache |
|---|---|---|---|---|---|
| 16 GB Mac | Gemma-4-E4B, 5.15 GB | Qwen3.5-4B, 3.03 GB, loaded on demand | BGE-M3 fp16, 1.14 GB | Qwen3-Reranker, 0.34 GB | ≈8 GB with the two large models never co-resident (≈11 GB if both load). A single-model variant with Qwen3.5-4B doing everything is ≈5.5 GB. |
| 8 GB Mac | Qwen3.5-2B for text and vision, 1.72 GB | same model | BGE-M3 fp16, 1.14 GB | Qwen3-Reranker, 0.34 GB | ≈4 GB |

### Hot-swap mechanism
| Runtime | `json_schema` constrained output | `/v1/embeddings` | Rerank |
|---|---|---|---|
| llama.cpp server | Yes, grammar-based | Yes, with `--pooling` | `/v1/rerank` |
| LM Studio | Yes (Outlines on MLX models) | Yes | No |
| Ollama | Docs mention only "JSON mode"; open issue #10001 covers `json_schema` on `/v1` | Yes | No |
| mlx-lm server | `response_format` was reported as ignored in a third-party issue (not checked in source) | Unverified | Unverified |

Others, not verified: oMLX exposes `/v1/embeddings` per a model card, and vllm-mlx has `json_schema` per an issue.

`ml-explore/mlx-swift-lm` v3.31.4 can serve every role in-process inside a Swift engine: `MLXLLM`, `MLXVLM` (Qwen35, Gemma4, LFM2VL), `MLXEmbedders`, `MLXRerankers` (Qwen3, bge-v2-m3, Jina) and `MLXGuidedGeneration` (XGrammar, JSON-Schema or EBNF). It has no HTTP server.

The cleanest design is one Swift provider protocol with two backends: in-process mlx-swift-lm by default, and any user-supplied OpenAI base URL. Always validate returned JSON and retry on failure, and send the schema in the prompt as well for runtimes that ignore it.

### Not verified
- Thai and Hindi quality for any model, beyond the language lists on the cards.
- BGE-M3 cross-runtime cosine parity.
- Whether the server uses BGE-M3's sparse or ColBERT heads.
- Whether Ollama currently supports `json_schema` on `/v1`.
- Whether the mlx-swift-lm `Gemma4` and `Qwen35` implementations load those exact mlx-community quantised repos.
- The licence flags on `mlx-community/gemma-4-*` show "gemma" while upstream is Apache-2.0 per Google's card; confirm before shipping.
