/**
 * Test doubles for the injected HTTP transport.
 *
 * These let every test drive the pure core off canned provider responses with no
 * network — the `@lesto/bench` `SampleSource`/`clock` injection applied to HTTP.
 */

import type { Transport } from "../src/types";

/** Build a JSON `Response` an Anthropic non-streamed parse will accept. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build an SSE `Response` whose body streams the given frames (each `\n\n`-terminated). */
export function sseResponse(frames: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A transport that always returns the same response, recording the requests it saw. */
export function constantTransport(response: Response): {
  transport: Transport;
  requests: Request[];
} {
  const requests: Request[] = [];

  const transport: Transport = async (request) => {
    requests.push(request);
    return response;
  };

  return { transport, requests };
}

/**
 * A transport that returns a scripted sequence of responses, one per call — for
 * the multi-turn agent loop. Running past the end of the script is a test bug, so
 * it throws rather than looping forever.
 */
export function scriptedTransport(responses: readonly Response[]): {
  transport: Transport;
  requests: Request[];
} {
  const requests: Request[] = [];
  let call = 0;

  const transport: Transport = async (request) => {
    requests.push(request);

    const response = responses[call];
    call += 1;

    if (response === undefined) {
      throw new Error(`scriptedTransport: no response for call ${call}`);
    }

    return response;
  };

  return { transport, requests };
}

/** Shorthand for a non-tool Anthropic message body with a single text block. */
export function textMessage(text: string): unknown {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 5 },
  };
}

/** Shorthand for an Anthropic message body that asks for one tool. */
export function toolUseMessage(id: string, name: string, input: Record<string, unknown>): unknown {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 4, output_tokens: 6 },
  };
}

/** Shorthand for a non-tool OpenAI chat-completion body with a single text answer. */
export function openaiTextMessage(text: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  };
}

/** Shorthand for an OpenAI chat-completion body that asks for one tool (arguments as a JSON string). */
export function openaiToolUseMessage(
  id: string,
  name: string,
  input: Record<string, unknown>,
): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(input) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 6 },
  };
}
