import type { Readable, Writable } from "node:stream";

import {
  CancellationReceiverStrategy,
  createMessageConnection,
  Emitter,
  ParameterStructures,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
  CancellationStrategy,
  Message,
  MessageConnection,
  MessageStrategy,
} from "vscode-jsonrpc/node";

import { RpcErrorCode } from "../protocol/index.js";
import type { RpcMethodMap, RpcMethodName } from "../protocol/index.js";

import { fromResponseError } from "./errors.js";
import { DaemonDisconnectedError, REQUEST_TIMEOUTS_MS, RpcError } from "./types.js";
import type {
  DaemonConnection,
  DaemonFault,
  DaemonNotification,
  Event,
  RequestOptions,
} from "./types.js";

export type NotificationParser = (method: string, params: unknown) => DaemonNotification | undefined;

export interface DaemonConnectionOptions {
  readonly stdout: Readable;
  readonly stdin: Writable;
  /** Injected rather than imported so this module stays free of `vscode` and testable in plain Node. */
  readonly parseNotification: NotificationParser;
}

/** The daemon has no `$/cancelRequest` handler, so a timed-out request must never send one. */
const NO_CANCELLATION: CancellationStrategy = {
  receiver: CancellationReceiverStrategy.Message,
  sender: {
    sendCancellation: () => Promise.resolve(),
    cleanup: () => undefined,
  },
};

const PARSE_ERROR_FAULT =
  "The daemon rejected a frame as malformed. It stops reading after that, so only a respawn recovers.";

function isParseError(message: Message): boolean {
  return (message as { error?: { code?: unknown } }).error?.code === RpcErrorCode.ParseError;
}

class StreamDaemonConnection implements DaemonConnection {
  readonly #connection: MessageConnection;
  readonly #notifications = new Emitter<DaemonNotification>();
  readonly #faults = new Emitter<DaemonFault>();
  readonly #pending = new Set<(error: Error) => void>();

  #fault: DaemonFault | undefined;
  #disposed = false;

  constructor(options: DaemonConnectionOptions) {
    const parse = options.parseNotification;

    const messageStrategy: MessageStrategy = {
      handleMessage: (message, next) => {
        // A -32700 arrives with id null, which the library only logs; the latch has to see it here.
        if (isParseError(message)) {
          this.#latch({ reason: PARSE_ERROR_FAULT, code: RpcErrorCode.ParseError });
        }
        return next(message);
      },
    };

    this.#connection = createMessageConnection(
      new StreamMessageReader(options.stdout),
      new StreamMessageWriter(options.stdin),
      undefined,
      { cancellationStrategy: NO_CANCELLATION, messageStrategy },
    );

    this.#connection.onNotification((method: string, params: unknown) => {
      const notification = parse(method, params);
      if (notification !== undefined) {
        this.#notifications.fire(notification);
      }
    });

    this.#connection.onError(([error]) => {
      this.#latch({ reason: `The daemon stream failed: ${error.message}` });
    });

    this.#connection.onClose(() => {
      this.#latch({ reason: "The daemon closed the connection." });
    });

    this.#connection.listen();
  }

  get onNotification(): Event<DaemonNotification> {
    return this.#notifications.event;
  }

  get onFault(): Event<DaemonFault> {
    return this.#faults.event;
  }

  get fault(): DaemonFault | undefined {
    return this.#fault;
  }

  request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]["params"],
    options?: RequestOptions,
  ): Promise<RpcMethodMap[M]["result"]> {
    const latched = this.#fault;
    if (latched !== undefined) {
      return Promise.reject(new DaemonDisconnectedError(latched.reason));
    }

    const timeoutMs =
      options?.timeoutMs ?? REQUEST_TIMEOUTS_MS[method] ?? REQUEST_TIMEOUTS_MS.default;

    return new Promise<RpcMethodMap[M]["result"]>((resolve, reject) => {
      let settled = false;

      // A timeout kills the one request, never the stream: rpc.md §6.1 calls it a reconnect trigger.
      const timer = setTimeout(() => {
        abandon(
          new RpcError(
            RpcErrorCode.Network,
            `The daemon did not answer '${method}' within ${timeoutMs} ms.`,
            { category: "network" },
          ),
        );
      }, timeoutMs);

      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(abandon);
        return true;
      };

      const abandon = (error: Error): void => {
        if (finish()) reject(error);
      };

      this.#pending.add(abandon);

      let sent: Promise<RpcMethodMap[M]["result"]>;
      try {
        sent = this.#connection.sendRequest<RpcMethodMap[M]["result"]>(
          method,
          ParameterStructures.byName,
          params,
        );
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : "the write failed";
        abandon(new DaemonDisconnectedError(`Could not send '${method}': ${detail}`));
        return;
      }

      sent.then(
        (result) => {
          if (finish()) resolve(result);
        },
        (error: unknown) => {
          if (finish()) reject(fromResponseError(error));
        },
      );
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#latch({ reason: "The daemon connection was disposed." });
    this.#connection.dispose();
    this.#notifications.dispose();
    this.#faults.dispose();
  }

  #latch(fault: DaemonFault): void {
    if (this.#fault !== undefined) return;
    this.#fault = fault;

    const error = new DaemonDisconnectedError(fault.reason);
    for (const abandon of [...this.#pending]) {
      abandon(error);
    }
    this.#pending.clear();

    this.#faults.fire(fault);
  }
}

export function createDaemonConnection(options: DaemonConnectionOptions): DaemonConnection {
  return new StreamDaemonConnection(options);
}
