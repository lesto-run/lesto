import type { ValidationError, TransformError, SerializationError } from "./types";

export type BuildEventType =
  | "build:start"
  | "build:end"
  | "build:error"
  | "collect:start"
  | "collect:end"
  | "parse:start"
  | "parse:end"
  | "transform:start"
  | "transform:end"
  | "write:start"
  | "write:end"
  | "validation:warning"
  | "transform:error"
  | "serialization:warning";

export interface BaseEventPayload {
  timestamp: number;
}

export interface BuildStartPayload extends BaseEventPayload {
  cwd: string;
  collectionCount: number;
}

export interface BuildEndPayload extends BaseEventPayload {
  duration: number;
  entryCount: number;
  collections: string[];
}

export interface BuildErrorPayload extends BaseEventPayload {
  error: Error;
}

export interface CollectEventPayload extends BaseEventPayload {
  collection: string;
}

export interface CollectEndPayload extends CollectEventPayload {
  fileCount: number;
}

export interface ParseEventPayload extends BaseEventPayload {
  collection: string;
  filePath: string;
}

export interface ParseEndPayload extends ParseEventPayload {
  success: boolean;
}

export interface TransformEventPayload extends BaseEventPayload {
  collection: string;
  entryId: string;
}

export interface TransformEndPayload extends TransformEventPayload {
  success: boolean;
  skipped: boolean;
}

export interface WriteEventPayload extends BaseEventPayload {
  outDir: string;
}

export interface WriteEndPayload extends WriteEventPayload {
  files: string[];
}

export interface ValidationWarningPayload extends BaseEventPayload {
  error: ValidationError;
}

export interface TransformErrorPayload extends BaseEventPayload {
  error: TransformError;
}

export interface SerializationWarningPayload extends BaseEventPayload {
  error: SerializationError;
}

export interface EventPayloadMap {
  "build:start": BuildStartPayload;
  "build:end": BuildEndPayload;
  "build:error": BuildErrorPayload;
  "collect:start": CollectEventPayload;
  "collect:end": CollectEndPayload;
  "parse:start": ParseEventPayload;
  "parse:end": ParseEndPayload;
  "transform:start": TransformEventPayload;
  "transform:end": TransformEndPayload;
  "write:start": WriteEventPayload;
  "write:end": WriteEndPayload;
  "validation:warning": ValidationWarningPayload;
  "transform:error": TransformErrorPayload;
  "serialization:warning": SerializationWarningPayload;
}

export type EventListener<T extends BuildEventType> = (
  payload: EventPayloadMap[T],
) => void | Promise<void>;

export type WildcardListener = (
  type: BuildEventType,
  payload: EventPayloadMap[BuildEventType],
) => void | Promise<void>;

export interface EventEmitter {
  on<T extends BuildEventType>(type: T, listener: EventListener<T>): () => void;
  onAny(listener: WildcardListener): () => void;
  emit<T extends BuildEventType>(
    type: T,
    payload: Omit<EventPayloadMap[T], "timestamp">,
  ): Promise<void>;
  removeAllListeners(): void;
}

export function createEventEmitter(): EventEmitter {
  const listeners = new Map<BuildEventType, Set<EventListener<BuildEventType>>>();
  const wildcardListeners = new Set<WildcardListener>();

  function on<T extends BuildEventType>(type: T, listener: EventListener<T>): () => void {
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    listeners.get(type)!.add(listener as EventListener<BuildEventType>);

    return () => {
      listeners.get(type)?.delete(listener as EventListener<BuildEventType>);
    };
  }

  function onAny(listener: WildcardListener): () => void {
    wildcardListeners.add(listener);

    return () => {
      wildcardListeners.delete(listener);
    };
  }

  async function emit<T extends BuildEventType>(
    type: T,
    payload: Omit<EventPayloadMap[T], "timestamp">,
  ): Promise<void> {
    const fullPayload = {
      ...payload,
      timestamp: Date.now(),
    } as EventPayloadMap[T];

    const typeListeners = listeners.get(type);
    const promises: Promise<void>[] = [];

    if (typeListeners) {
      for (const listener of typeListeners) {
        const result = listener(fullPayload);
        if (result instanceof Promise) {
          promises.push(result);
        }
      }
    }

    for (const listener of wildcardListeners) {
      const result = listener(type, fullPayload);
      if (result instanceof Promise) {
        promises.push(result);
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  function removeAllListeners(): void {
    listeners.clear();
    wildcardListeners.clear();
  }

  return {
    on,
    onAny,
    emit,
    removeAllListeners,
  };
}

export function createNoopEmitter(): EventEmitter {
  return {
    on: () => () => {},
    onAny: () => () => {},
    emit: async () => {},
    removeAllListeners: () => {},
  };
}
