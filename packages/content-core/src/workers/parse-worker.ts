import { parentPort } from "node:worker_threads";
import { resolveParser, FrontmatterParseError, YamlParseError, JsonParseError } from "@keel/content-umbra";
import type { ParserPreset } from "@keel/content-umbra";

interface WorkerMessage {
  id: number;
  content: string;
  filePath: string;
  parserName: ParserPreset;
}

interface WorkerResult {
  id: number;
  success: true;
  data: Record<string, unknown>;
  content: string;
}

interface WorkerError {
  id: number;
  success: false;
  error: {
    name: string;
    message: string;
    filePath: string;
    cause?: unknown;
  };
}

if (!parentPort) {
  throw new Error("This module must be run as a worker thread");
}

parentPort.on("message", (message: WorkerMessage) => {
  try {
    const parser = resolveParser(message.parserName);
    const result = parser.parse(message.content, message.filePath);

    const response: WorkerResult = {
      id: message.id,
      success: true,
      data: result.data,
      content: result.content,
    };

    parentPort!.postMessage(response, []);
  } catch (error) {
    let errorResponse: WorkerError;

    if (
      error instanceof FrontmatterParseError ||
      error instanceof YamlParseError ||
      error instanceof JsonParseError
    ) {
      errorResponse = {
        id: message.id,
        success: false,
        error: {
          name: error.name,
          message: error.message,
          filePath: error.filePath,
          cause: error.cause,
        },
      };
    } else if (error instanceof Error) {
      errorResponse = {
        id: message.id,
        success: false,
        error: {
          name: error.name,
          message: error.message,
          filePath: message.filePath,
        },
      };
    } else {
      errorResponse = {
        id: message.id,
        success: false,
        error: {
          name: "UnknownError",
          message: String(error),
          filePath: message.filePath,
        },
      };
    }

    parentPort!.postMessage(errorResponse, []);
  }
});
