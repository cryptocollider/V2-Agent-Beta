import { JsonRpcClient } from "../core/rpc.js";
import type { GameListItem, Hex32, SimRunInput } from "./types.js";

export class ColliderClient {
  private readonly rpc: JsonRpcClient;

  constructor(url: string) {
    this.rpc = new JsonRpcClient(url);
  }

  async listGames(statusMask?: number): Promise<GameListItem[]> {
    return this.rpc.call<GameListItem[]>("colliderV2.listGames", statusMask == null ? [] : [statusMask]);
  }

  async getGame(gameId: Hex32): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.getGame", [gameId]);
  }

  async getSimInput(gameId: Hex32): Promise<SimRunInput> {
    return this.rpc.call<SimRunInput>("colliderV2.getSimInput", [gameId]);
  }

  async getGameReport(gameId: Hex32): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.getGameReport", [gameId]);
  }

  async getBalances(user: Hex32): Promise<Record<string, string>> {
    return this.rpc.call<Record<string, string>>("colliderV2.getBalances", [user]);
  }

  async getAssetsMeta(): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.getAssetsMeta", []);
  }

  async placeThrow(args: unknown): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.placeThrow", [args]);
  }

  async mirrorDeposit(
    asset: Hex32,
    beneficiary: Hex32,
    amount: string,
    noticeId: Hex32,
  ): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.mirrorDeposit", [
      asset,
      beneficiary,
      amount,
      noticeId,
    ]);
  }
}