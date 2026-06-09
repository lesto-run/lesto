import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ParserPreset } from "@keel/content-umbra";

const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);

export interface WorkerTask {
  content: string;
  filePath: string;
  parserName: ParserPreset;
}

export interface WorkerResult {
  data: Record<string, unknown>;
  content: string;
}

export interface WorkerPool {
  execute<T extends WorkerResult>(task: WorkerTask): Promise<T>;
  shutdown(): Promise<void>;
}

interface PendingTask {
  id: number;
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
}

function getWorkerPath(): string {
  const builtPath = path.join(currentDirname, "parse-worker.js");
  if (existsSync(builtPath)) {
    return builtPath;
  }

  const sourcePath = path.join(currentDirname, "parse-worker.ts");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  throw new Error("Worker script not found");
}

class WorkerPoolImpl implements WorkerPool {
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private pendingTasks: Array<{ task: WorkerTask; pending: PendingTask }> = [];
  private taskIdCounter = 0;
  private taskMap = new Map<number, PendingTask>();
  private shutdownRequested = false;

  constructor(size: number) {
    const workerPath = getWorkerPath();

    if (workerPath.endsWith(".ts")) {
      throw new Error("Worker threads require built JavaScript files");
    }

    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath);

      worker.on(
        "message",
        (message: {
          id: number;
          success: boolean;
          data?: Record<string, unknown>;
          content?: string;
          error?: { name: string; message: string; filePath: string };
        }) => {
          const pending = this.taskMap.get(message.id);
          if (!pending) return;

          this.taskMap.delete(message.id);

          if (message.success && message.data !== undefined && message.content !== undefined) {
            pending.resolve({ data: message.data, content: message.content });
          } else if (message.error) {
            const error = new Error(message.error.message);
            error.name = message.error.name;
            pending.reject(error);
          } else {
            pending.reject(new Error("Invalid worker response"));
          }

          this.availableWorkers.push(worker);
          this.processNextTask();
        },
      );

      worker.on("error", (error) => {
        for (const [id, pending] of this.taskMap.entries()) {
          pending.reject(error);
          this.taskMap.delete(id);
        }

        const workerIndex = this.workers.indexOf(worker);
        if (workerIndex !== -1) {
          this.workers.splice(workerIndex, 1);
        }
        const availableIndex = this.availableWorkers.indexOf(worker);
        if (availableIndex !== -1) {
          this.availableWorkers.splice(availableIndex, 1);
        }
      });

      worker.on("exit", (code) => {
        if (code !== 0 && !this.shutdownRequested) {
          console.error(`Worker stopped with exit code ${code}`);
        }
      });

      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }
  }

  private processNextTask(): void {
    if (this.pendingTasks.length === 0 || this.availableWorkers.length === 0) {
      return;
    }

    const worker = this.availableWorkers.pop()!;
    const { task, pending } = this.pendingTasks.shift()!;

    this.taskMap.set(pending.id, pending);

    worker.postMessage(
      {
        id: pending.id,
        content: task.content,
        filePath: task.filePath,
        parserName: task.parserName,
      },
      [],
    );
  }

  execute<T extends WorkerResult>(task: WorkerTask): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.shutdownRequested) {
        reject(new Error("Worker pool is shutting down"));
        return;
      }

      const id = this.taskIdCounter++;
      const pending: PendingTask = {
        id,
        resolve: resolve as (value: WorkerResult) => void,
        reject,
      };

      if (this.availableWorkers.length > 0) {
        const worker = this.availableWorkers.pop()!;
        this.taskMap.set(id, pending);

        worker.postMessage(
          {
            id,
            content: task.content,
            filePath: task.filePath,
            parserName: task.parserName,
          },
          [],
        );
      } else {
        this.pendingTasks.push({ task, pending });
      }
    });
  }

  async shutdown(): Promise<void> {
    // Set flag first to prevent new tasks from being accepted
    this.shutdownRequested = true;

    // Collect all pending tasks before clearing to avoid iteration during modification
    const pendingToReject = [...this.pendingTasks];
    this.pendingTasks = [];

    // Reject all pending tasks (queued but not yet sent to workers)
    for (const { pending } of pendingToReject) {
      pending.reject(new Error("Worker pool shutdown"));
    }

    // Also reject any active tasks in the taskMap (already sent to workers)
    for (const pending of this.taskMap.values()) {
      pending.reject(new Error("Worker pool shutdown"));
    }
    this.taskMap.clear();

    // Terminate workers with a timeout to prevent hanging
    const TERMINATION_TIMEOUT = 5000; // 5 seconds
    const terminateWithTimeout = (worker: Worker) =>
      Promise.race([
        worker.terminate(),
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), TERMINATION_TIMEOUT)),
      ]);

    await Promise.all(this.workers.map(terminateWithTimeout));
    this.workers = [];
    this.availableWorkers = [];
  }
}

export function createWorkerPool(size?: number): WorkerPool {
  const poolSize = size ?? Math.max(1, cpus().length - 1);
  return new WorkerPoolImpl(poolSize);
}
