// Sending a tab somewhere that isn't a tab.
//
// A "save" that means a bookmark just relocates the pile, so these go to the
// places things actually get read and done. Request shaping is separated from
// sending so the shapes can be tested without the network.

export interface OutboxTarget {
  url: string;
  title?: string;
}

export interface PreparedRequest {
  endpoint: string;
  init: RequestInit;
}

/** Readwise Reader's save endpoint. Tokens come from readwise.io/access_token. */
export function readwiseRequest(
  token: string,
  target: OutboxTarget,
): PreparedRequest {
  return {
    endpoint: "https://readwise.io/api/v3/save/",
    init: {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: target.url,
        ...(target.title ? { title: target.title } : {}),
        tags: ["tab-triage"],
      }),
    },
  };
}

/**
 * Todoist task creation. Uses api/v1, not rest/v2: the v2 endpoint is retired
 * and answers 410.
 */
export function todoistRequest(
  token: string,
  target: OutboxTarget,
): PreparedRequest {
  const content = target.title?.trim()
    ? `${target.title.trim()} ${target.url}`
    : target.url;
  return {
    endpoint: "https://api.todoist.com/api/v1/tasks",
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content, description: target.url }),
    },
  };
}

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function send(request: PreparedRequest): Promise<SendResult> {
  try {
    const response = await fetch(request.endpoint, request.init);
    if (response.ok) return { ok: true, status: response.status };
    // The body usually says why, and a silent failure here would lose the tab.
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    return {
      ok: false,
      status: response.status,
      error: detail || `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Readwise allows 50 saves a minute per token. */
export const READWISE_RATE_LIMIT_PER_MINUTE = 50;
