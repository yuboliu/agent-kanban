import type { BoardAction } from "@agent-kanban/shared";
import { createLogger } from "./logger";
import { getBoardActions, getBoardActionsByBoardId } from "./taskRepo";
import type { AppServices } from "./types";

const INITIAL_LOOKBACK_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

interface BoardSSEEvent {
  id: string;
  data: string;
  created_at: string;
}

const logger = createLogger("boardSSE");

// Long-lived board SSE: polls until the client disconnects (no Cloudflare
// 25s ceiling), with a comment heartbeat and abort handling.
export async function createBoardSSEResponse(env: AppServices, boardId: string, ownerId: string, signal?: AbortSignal): Promise<Response> {
  return runBoardSSE(env, boardId, async (lastSeen) => getBoardActions(env.DB, boardId, ownerId, lastSeen), signal);
}

export async function createPublicBoardSSEResponse(env: AppServices, boardId: string, signal?: AbortSignal): Promise<Response> {
  return runBoardSSE(env, boardId, async (lastSeen) => getBoardActionsByBoardId(env.DB, boardId, lastSeen), signal);
}

async function runBoardSSE(
  env: AppServices,
  boardId: string,
  fetchNotes: (lastSeen: string) => Promise<BoardAction[]>,
  signal?: AbortSignal,
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", close);
    writer.close().catch(() => {});
  };

  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(": ping\n\n")).catch(close);
  }, HEARTBEAT_INTERVAL_MS);

  signal?.addEventListener("abort", close);

  const write = (event: BoardSSEEvent) => {
    let msg = `id: ${event.id}\n`;
    msg += `event: board_note\n`;
    msg += `data: ${event.data}\n\n`;
    return writer.write(encoder.encode(msg));
  };

  const toEvent = (note: BoardAction): BoardSSEEvent => ({
    id: note.id,
    data: JSON.stringify(note),
    created_at: note.created_at,
  });

  const run = async () => {
    let lastSeen = new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();

    const initial = await fetchNotes(lastSeen);
    for (const note of initial) {
      await write(toEvent(note));
    }
    if (initial.length > 0) {
      lastSeen = initial[initial.length - 1].created_at;
    }

    // Poll every 2s until the client disconnects.
    while (!signal?.aborted && !closed) {
      await new Promise((r) => setTimeout(r, 2000));

      const notes = await fetchNotes(lastSeen);
      for (const note of notes) {
        await write(toEvent(note));
      }
      if (notes.length > 0) {
        lastSeen = notes[notes.length - 1].created_at;
      }
    }

    close();
  };

  run().catch((err) => {
    logger.error(`board SSE error boardId=${boardId}: ${err.message}`);
    close();
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
