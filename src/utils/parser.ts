import {
  getAddressDecoder,
  getArrayDecoder,
  getStructDecoder,
  getU32Decoder,
  getU64Decoder,
} from "@solana/kit";
import type { SubscribeUpdateTransactionInfo } from "@triton-one/yellowstone-grpc";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { db } from "../database/client.js";

const JUPITER_AGGREGATOR_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const discriminator = (preimage: string) =>
  sha256(new TextEncoder().encode(preimage)).subarray(0, 8);

// Jupiter V6 swap instructions, identified by their Anchor discriminator
const ROUTE_INSTRUCTIONS = {
  ROUTE: discriminator("global:route"),
  ROUTE_V2: discriminator("global:route_v2"),
  SHARED_ACCOUNTS_ROUTE: discriminator("global:shared_accounts_route"),
  SHARED_ACCOUNTS_ROUTE_V2: discriminator("global:shared_accounts_route_v2"),
  EXACT_OUT_ROUTE_V2: discriminator("global:exact_out_route_v2"),
  ROUTE_WITH_TOKEN_LEDGER: discriminator("global:route_with_token_ledger"),
  SHARED_ACCOUNTS_ROUTE_WITH_TOKEN_LEDGER: discriminator(
    "global:shared_accounts_route_with_token_ledger",
  ),
};

// Event discriminators (bytes 8..16 of Anchor's self-CPI event instruction)
const SWAP_EVENT_DISCRIMINATOR = discriminator("event:SwapEvent");
const SWAPS_EVENT_DISCRIMINATOR = discriminator("event:SwapsEvent");

const SwapEventDecoder = getStructDecoder([
  ["amm", getAddressDecoder()],
  ["inputMint", getAddressDecoder()],
  ["inputAmount", getU64Decoder()],
  ["outputMint", getAddressDecoder()],
  ["outputAmount", getU64Decoder()],
]);

// Each SwapsEvent entry is 112 bytes on-chain: the four documented fields plus the
// AMM program id. The published IDL omits `amm`, and decoding with that 80-byte
// layout misaligns every entry after the first.
const SwapEventV2Decoder = getStructDecoder([
  ["inputMint", getAddressDecoder()],
  ["inputAmount", getU64Decoder()],
  ["outputMint", getAddressDecoder()],
  ["outputAmount", getU64Decoder()],
  ["amm", getAddressDecoder()],
]);

const SwapsEventDecoder = getStructDecoder([
  ["swapEvents", getArrayDecoder(SwapEventV2Decoder, { size: getU32Decoder() })],
]);

export type JupiterSwap = {
  amm: string;
  inputMint: string;
  inputAmount: bigint;
  outputMint: string;
  outputAmount: bigint;
};

export type DecodedJupiterSwaps = {
  instruction: keyof typeof ROUTE_INSTRUCTIONS;
  swaps: JupiterSwap[];
};

const arraysEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((val, i) => val === b[i]);

const toSwap = (event: {
  amm: string;
  inputMint: string;
  inputAmount: bigint;
  outputMint: string;
  outputAmount: bigint;
}): JupiterSwap => ({
  amm: event.amm.toString(),
  inputMint: event.inputMint.toString(),
  inputAmount: event.inputAmount,
  outputMint: event.outputMint.toString(),
  outputAmount: event.outputAmount,
});

/**
 * Finds the top-level Jupiter V6 route instruction and decodes the SwapEvent or
 * SwapsEvent that Jupiter emits through a self-CPI inside it. Pure: no I/O.
 */
export function decodeJupiterSwaps(
  tx: SubscribeUpdateTransactionInfo,
): DecodedJupiterSwaps | null {
  const message = tx.transaction?.message;
  if (!message) return null;

  // Program ids of inner instructions may come from address lookup tables.
  const accountKeys = [
    ...message.accountKeys,
    ...(tx.meta?.loadedWritableAddresses ?? []),
    ...(tx.meta?.loadedReadonlyAddresses ?? []),
  ].map((key) => bs58.encode(key));

  let instruction: DecodedJupiterSwaps["instruction"] | undefined;
  const swapIxIdx = message.instructions.findIndex((ix) => {
    if (accountKeys[ix.programIdIndex] !== JUPITER_AGGREGATOR_V6) return false;
    const ixDiscriminator = ix.data.subarray(0, 8);
    instruction = (
      Object.keys(ROUTE_INSTRUCTIONS) as Array<keyof typeof ROUTE_INSTRUCTIONS>
    ).find((name) => arraysEqual(ixDiscriminator, ROUTE_INSTRUCTIONS[name]));
    return instruction !== undefined;
  });
  if (swapIxIdx === -1 || !instruction) return null;

  const innerIxs = tx.meta?.innerInstructions?.find(
    (innerIx) => innerIx.index === swapIxIdx,
  )?.instructions;
  if (!innerIxs) return null;

  for (const ix of innerIxs) {
    if (accountKeys[ix.programIdIndex] !== JUPITER_AGGREGATOR_V6) continue;

    const eventDiscriminator = ix.data.subarray(8, 16);
    const eventData = ix.data.subarray(16);

    if (arraysEqual(eventDiscriminator, SWAPS_EVENT_DISCRIMINATOR)) {
      const event = SwapsEventDecoder.decode(eventData);
      return { instruction, swaps: event.swapEvents.map(toSwap) };
    }

    if (arraysEqual(eventDiscriminator, SWAP_EVENT_DISCRIMINATOR)) {
      return { instruction, swaps: [toSwap(SwapEventDecoder.decode(eventData))] };
    }
  }

  return null;
}

export const involvesSol = (swap: JupiterSwap) =>
  swap.inputMint === SOL_MINT || swap.outputMint === SOL_MINT;

/** Decodes a streamed transaction and upserts its SOL swaps. Returns true if any was stored. */
export async function parseTx(
  tx: SubscribeUpdateTransactionInfo,
  slot: string | number | bigint,
): Promise<boolean> {
  const decoded = decodeJupiterSwaps(tx);
  if (!decoded) return false;

  const solSwaps = decoded.swaps.filter(involvesSol);
  if (solSwaps.length === 0) return false;

  const signature = bs58.encode(tx.signature);
  const signer = bs58.encode(tx.transaction!.message!.accountKeys[0]);

  for (const swap of solSwaps) {
    console.log(`\nSWAP DETECTED (${decoded.instruction}):`);
    console.log("  AMM:", swap.amm);
    console.log("  Input Mint:", swap.inputMint);
    console.log("  Input Amount:", swap.inputAmount.toString());
    console.log("  Output Mint:", swap.outputMint);
    console.log("  Output Amount:", swap.outputAmount.toString());

    // Amounts stay bigint end to end: u64 values can exceed Number.MAX_SAFE_INTEGER.
    const row = {
      slot: BigInt(slot),
      account: signer,
      input_mint: swap.inputMint,
      input_amount: swap.inputAmount,
      output_mint: swap.outputMint,
      output_amount: swap.outputAmount,
    };

    await db.prisma.transaction.upsert({
      where: { signature },
      create: { signature, ...row },
      update: row,
    });
  }

  return true;
}
