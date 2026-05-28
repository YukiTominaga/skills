/**
 * Dify HITL (Human Input Node) Service API クライアント
 *
 * 対象: Dify v1.14.x / Service API (`/v1` namespace, Bearer `app-xxx` 認証)
 *
 * 一連のフロー:
 *   1. startWorkflow()        ワークフロー起動 (streaming で paused を検知)
 *   2. (paused 検知)          human_input_required イベントから form_token を得る
 *   3. getForm()              フォーム定義 (inputs/actions) を取得
 *   4. submitAction()         action (approve/reject 等) を送信して resume
 *   5. streamEvents()         再開後の出力を SSE で受信 / または pollUntilDone()
 *
 * 環境変数:
 *   DIFY_BASE_URL  例: https://api.dify.ai  (セルフホストならその URL)
 *   DIFY_API_KEY   app-xxx 形式の Service API キー
 *
 * Node.js 18+ (グローバル fetch / ReadableStream / TextDecoderStream 前提)
 */

export type WorkflowStatus =
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "stopped";

export interface DifyEvent {
  event: string;
  // human_input_required / workflow_paused / node_finished / workflow_finished など
  data?: Record<string, unknown>;
  // workflow 起動レスポンスでは task_id / workflow_run_id がトップレベルに来る場合がある
  task_id?: string;
  workflow_run_id?: string;
  [key: string]: unknown;
}

export interface FormDefinition {
  form_content: string;
  inputs: unknown[];
  resolved_default_values: Record<string, string>;
  user_actions: { id?: string; label?: string; [k: string]: unknown }[];
  expiration_time: number;
}

export interface WorkflowRunDetail {
  id: string;
  status: WorkflowStatus;
  outputs: Record<string, unknown>;
  elapsed_time?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export class DifyHitlClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /**
   * end-user 識別子。起動・フォーム送信・events 取得ですべて同じ値を使うこと。
   * ずれると正しい run_id でも 404 Workflow run not found になる。
   */
  private readonly user: string;

  constructor(opts: { baseUrl?: string; apiKey?: string; user: string }) {
    this.baseUrl = (opts.baseUrl ?? process.env.DIFY_BASE_URL ?? "").replace(
      /\/+$/,
      "",
    );
    this.apiKey = opts.apiKey ?? process.env.DIFY_API_KEY ?? "";
    this.user = opts.user;
    if (!this.baseUrl) throw new Error("DIFY_BASE_URL is required");
    if (!this.apiKey) throw new Error("DIFY_API_KEY is required");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  // --- 1. ワークフロー起動 -------------------------------------------------

  /**
   * blocking モードで起動。レスポンスの status が "paused" なら Human Input 待ち。
   */
  async startWorkflowBlocking(
    inputs: Record<string, unknown>,
  ): Promise<DifyEvent> {
    const res = await fetch(`${this.baseUrl}/v1/workflows/run`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        inputs,
        response_mode: "blocking",
        user: this.user,
      }),
    });
    if (!res.ok) {
      throw new Error(`startWorkflow failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as DifyEvent;
  }

  /**
   * streaming モードで起動し、SSE をそのまま流す。
   * human_input_required / workflow_paused を検知したい場合はこちら。
   */
  async *startWorkflowStreaming(
    inputs: Record<string, unknown>,
  ): AsyncGenerator<DifyEvent> {
    const res = await fetch(`${this.baseUrl}/v1/workflows/run`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        inputs,
        response_mode: "streaming",
        user: this.user,
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`startWorkflow failed: ${res.status} ${await res.text()}`);
    }
    yield* parseSse(res.body);
  }

  // --- 2/3. フォーム取得 ---------------------------------------------------

  /** 一時停止中のフォーム定義 (inputs / user_actions) を取得。 */
  async getForm(formToken: string): Promise<FormDefinition> {
    const res = await fetch(
      `${this.baseUrl}/v1/form/human_input/${encodeURIComponent(formToken)}`,
      { method: "GET", headers: this.headers() },
    );
    if (!res.ok) {
      // 404: 無効な token / 412: 送信済み or 期限切れ
      throw new Error(`getForm failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as FormDefinition;
  }

  // --- 4. action 送信 (resume) --------------------------------------------

  /**
   * action を送信してワークフローを再開する。
   * 成功してもレスポンスは acknowledgment のみ。後続出力は streamEvents/poll で取得。
   */
  async submitAction(
    formToken: string,
    action: string,
    inputs: Record<string, unknown> = {},
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/v1/form/human_input/${encodeURIComponent(formToken)}`,
      {
        method: "POST",
        headers: this.headers(),
        // 3フィールドすべて必須: inputs / action / user
        body: JSON.stringify({ inputs, action, user: this.user }),
      },
    );
    if (!res.ok) {
      // 400: 不正な action/input, 404: 無効token, 412: 送信済み/期限切れ
      throw new Error(`submitAction failed: ${res.status} ${await res.text()}`);
    }
  }

  // --- 5a. 再開後の出力: SSE ストリーミング --------------------------------

  /**
   * 再開後のワークフローイベントを SSE で受信。
   * @param taskId 実体は workflow_run_id を渡す。
   * @param opts.includeStateSnapshot 接続前の実行済みノードを再生 (resume 後の途中接続で推奨)
   * @param opts.continueOnPause workflow_paused でも接続を維持 (複数回 pause/resume をまたぐ)
   */
  async *streamEvents(
    taskId: string,
    opts: { includeStateSnapshot?: boolean; continueOnPause?: boolean } = {},
  ): AsyncGenerator<DifyEvent> {
    const params = new URLSearchParams({ user: this.user });
    if (opts.includeStateSnapshot) params.set("include_state_snapshot", "true");
    if (opts.continueOnPause) params.set("continue_on_pause", "true");

    const res = await fetch(
      `${this.baseUrl}/v1/workflow/${encodeURIComponent(taskId)}/events?${params}`,
      { method: "GET", headers: this.headers({ Accept: "text/event-stream" }) },
    );
    if (!res.ok || !res.body) {
      // 401 "App token is missing" が出たら Web API (/api/...) を叩いている可能性
      throw new Error(`streamEvents failed: ${res.status} ${await res.text()}`);
    }
    yield* parseSse(res.body);
  }

  // --- 5b. 再開後の出力: ポーリング ----------------------------------------

  /** 実行状態を1回取得。paused の間は outputs は空 {}。 */
  async getRunDetail(workflowRunId: string): Promise<WorkflowRunDetail> {
    const res = await fetch(
      `${this.baseUrl}/v1/workflows/run/${encodeURIComponent(workflowRunId)}`,
      { method: "GET", headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`getRunDetail failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as WorkflowRunDetail;
  }

  /** status が succeeded/failed/stopped になるまでポーリングして返す。 */
  async pollUntilDone(
    workflowRunId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<WorkflowRunDetail> {
    const interval = opts.intervalMs ?? 1500;
    const timeout = opts.timeoutMs ?? 5 * 60_000;
    const start = Date.now();
    for (;;) {
      const detail = await this.getRunDetail(workflowRunId);
      if (
        detail.status === "succeeded" ||
        detail.status === "failed" ||
        detail.status === "stopped"
      ) {
        return detail;
      }
      // running / paused は継続。paused は人間の応答待ちなので timeout は長めに。
      if (Date.now() - start > timeout) {
        throw new Error(`pollUntilDone timed out (last status: ${detail.status})`);
      }
      await sleep(interval);
    }
  }

  /** 実行を停止。 */
  async stop(taskId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/v1/workflows/tasks/${encodeURIComponent(taskId)}/stop`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ user: this.user }),
      },
    );
    if (!res.ok) {
      throw new Error(`stop failed: ${res.status} ${await res.text()}`);
    }
  }
}

// --- ユーティリティ --------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SSE (text/event-stream) をパースして DifyEvent を yield する。
 * `data: {json}` 行を拾い、空行でメッセージ区切りとする。
 */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<DifyEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // 行単位で処理 (Dify は 1イベント = `data: {...}` + 空行)
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const json = line.slice("data:".length).trim();
        if (!json || json === "[DONE]") continue;
        try {
          yield JSON.parse(json) as DifyEvent;
        } catch {
          // 不完全な行は無視 (次チャンクで補完される想定)
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// --- 利用例 ----------------------------------------------------------------

/**
 * 起動 → paused 検知 → 承認 → 出力取得 (ストリーミング) の一連フロー例。
 */
export async function approveFlowExample() {
  const client = new DifyHitlClient({ user: "end-user-id-123" });

  // 1. streaming で起動し、form_token と run_id を拾う
  let formToken: string | undefined;
  let runId: string | undefined;
  for await (const ev of client.startWorkflowStreaming({ query: "..." })) {
    runId ??= ev.workflow_run_id ?? (ev.data?.workflow_run_id as string);
    if (ev.event === "human_input_required") {
      formToken = ev.data?.form_token as string | undefined;
    }
    if (ev.event === "workflow_paused") break; // 一時停止 = 承認待ち
  }
  if (!formToken || !runId) throw new Error("did not reach paused state");

  // 2. (任意) フォーム定義を確認して action ID を決める
  const form = await client.getForm(formToken);
  const actionId = (form.user_actions[0]?.id as string) ?? "Approve";

  // 3. 承認を送信 (resume)
  await client.submitAction(formToken, actionId, { review_comment: "OK" });

  // 4. 再開後の出力を SSE で受信 (履歴再生 + pause またぎ)
  for await (const ev of client.streamEvents(runId, {
    includeStateSnapshot: true,
    continueOnPause: true,
  })) {
    if (ev.event === "workflow_finished") {
      console.log("outputs:", ev.data?.outputs);
      break;
    }
  }

  // --- ポーリングで取得する場合は上記4の代わりに:
  // const detail = await client.pollUntilDone(runId, { timeoutMs: 30 * 60_000 });
  // console.log(detail.outputs);
}
