import { PROTOCOL_VERSION, RpcErrorCode } from "../protocol/index.js";
import type {
  AccountDto,
  CapabilitiesDto,
  FolderDto,
  HealthDto,
  RpcMethodMap,
  RpcMethodName,
  StatsDto,
} from "../protocol/index.js";

import { CLIENT_INTERFACE, CLIENT_NAME, RpcError } from "./types.js";
import type { DaemonConnection, MailcodedClient, RequestOptions } from "./types.js";

/** The daemon speaks a protocol this build does not: docs/rpc.md §8 says refuse, never guess. */
export class ProtocolMismatchError extends Error {
  readonly daemonProtocolVersion: number;
  readonly clientProtocolVersion: number;
  readonly daemonVersion: string;

  constructor(daemonProtocolVersion: number, daemonVersion: string) {
    super(
      `The daemon speaks protocol version ${daemonProtocolVersion}; this extension speaks ` +
        `${PROTOCOL_VERSION}. Update whichever of the two is older.`,
    );
    this.name = "ProtocolMismatchError";
    this.daemonProtocolVersion = daemonProtocolVersion;
    this.clientProtocolVersion = PROTOCOL_VERSION;
    this.daemonVersion = daemonVersion;
  }
}

class NegotiatedClient implements MailcodedClient {
  readonly capabilities: CapabilitiesDto;
  readonly daemonVersion: string;

  readonly #connection: DaemonConnection;
  readonly #methods: ReadonlySet<string>;

  constructor(connection: DaemonConnection, capabilities: CapabilitiesDto, daemonVersion: string) {
    this.#connection = connection;
    this.capabilities = capabilities;
    this.daemonVersion = daemonVersion;
    this.#methods = new Set(capabilities.methods);
  }

  supports(method: RpcMethodName): boolean {
    return this.#methods.has(method);
  }

  request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]["params"],
    options?: RequestOptions,
  ): Promise<RpcMethodMap[M]["result"]> {
    if (!this.supports(method)) {
      return Promise.reject(
        new RpcError(
          RpcErrorCode.Unsupported,
          `This daemon does not advertise '${method}'. An absent capability is an absent feature.`,
          { category: "unsupported", detail: `Method '${method}' is not in this daemon's capabilities.` },
        ),
      );
    }
    return this.#connection.request(method, params, options);
  }

  async accountList(): Promise<readonly AccountDto[]> {
    const result = await this.request("account.list", {});
    return result.accounts;
  }

  async folderList(accountId: number): Promise<readonly FolderDto[]> {
    const result = await this.request("folder.list", { accountId });
    return result.folders;
  }

  async stats(): Promise<StatsDto> {
    const result = await this.request("stats", {});
    return result.stats;
  }

  async health(): Promise<HealthDto> {
    const result = await this.request("health", {});
    return result.health;
  }

  /** The daemon answers `{}` before it drains, so the 2 s budget from the timeout table is enough. */
  async shutdown(): Promise<void> {
    await this.request("shutdown", {});
  }

  dispose(): void {
    this.#connection.dispose();
  }
}

/** `initialize` first, then the version check, then a client that knows what this build can do. */
export async function initializeClient(
  connection: DaemonConnection,
  clientVersion: string,
): Promise<MailcodedClient> {
  const result = await connection.request("initialize", {
    clientName: CLIENT_NAME,
    clientVersion,
    protocolVersion: PROTOCOL_VERSION,
    interface: CLIENT_INTERFACE,
  });

  if (result.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolMismatchError(result.protocolVersion, result.daemonVersion);
  }

  return new NegotiatedClient(connection, result.capabilities, result.daemonVersion);
}
