import {
  address,
  getAddressDecoder,
  getArrayDecoder,
  getStructDecoder,
  getU32Decoder,
  getU64Decoder,
  TransactionForFullJson,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { db } from "../database/client.js";

// Helper to compare Uint8Arrays
const arraysEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((val, i) => val === b[i]);

export async function parseTx(
  rpcTx: TransactionForFullJson<0>,
  slot: number,
): Promise<boolean> {
  if (!rpcTx) throw new Error("Unable to fetch transaction");

  // Extract signature and signer
  // @ts-ignore
  const signature = bs58.encode(Buffer.from(rpcTx.signature)); // @ts-ignore
  const signer = bs58.encode(
    Buffer.from(rpcTx.transaction.message.accountKeys[0]),
  );
  const JUPITER_AGGREGATOR_V6 = address(
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  );
  const SOL_MINT = address("So11111111111111111111111111111111111111112");

  // Jupiter V6 instruction discriminators
  const discriminators = {
    ROUTE: sha256(new TextEncoder().encode("global:route")).subarray(0, 8),
    ROUTE_V2: sha256(new TextEncoder().encode("global:route_v2")).subarray(
      0,
      8,
    ),
    SHARED_ACCOUNTS_ROUTE_V2: sha256(
      new TextEncoder().encode("global:shared_accounts_route_v2"),
    ).subarray(0, 8),
    SHARED_ACCOUNTS_ROUTE: sha256(
      new TextEncoder().encode("global:shared_accounts_route"),
    ).subarray(0, 8),
    EXACT_OUT_ROUTE_V2: sha256(
      new TextEncoder().encode("global:exact_out_route_v2"),
    ).subarray(0, 8),
  };

  let instructionFound = "";
  const swapIxIdx = rpcTx.transaction.message.instructions.findIndex(
    (ix, index) => {
      const data = rpcTx.transaction.message.instructions[index].data;
      // @ts-ignore
      const discriminator = new Uint8Array(data).subarray(0, 8); // @ts-ignore
      const program = rpcTx.transaction.message.accountKeys[ix.programIdIndex];
      const programBase58 = bs58.encode(Buffer.from(program));
      if (arraysEqual(discriminator, discriminators.ROUTE))
        instructionFound = "ROUTE";
      else if (arraysEqual(discriminator, discriminators.ROUTE_V2))
        instructionFound = "ROUTE_V2";
      else if (
        arraysEqual(discriminator, discriminators.SHARED_ACCOUNTS_ROUTE_V2)
      )
        instructionFound = "SHARED_ACCOUNTS_ROUTE_V2";
      else if (arraysEqual(discriminator, discriminators.SHARED_ACCOUNTS_ROUTE))
        instructionFound = "SHARED_ACCOUNTS_ROUTE";
      else if (arraysEqual(discriminator, discriminators.EXACT_OUT_ROUTE_V2))
        instructionFound = "EXACT_OUT_ROUTE_V2";
      return (
        programBase58 === JUPITER_AGGREGATOR_V6.toString() &&
        Boolean(instructionFound)
      );
    },
  );
  if (swapIxIdx === -1) return false;

  // Get inner instructions for Jupiter call
  const innerIxs = rpcTx.meta?.innerInstructions?.find(
    (innerIx) => innerIx.index === swapIxIdx,
  )?.instructions;
  if (!innerIxs) return false;

  // Event discriminators
  const SWAP_EVENT_DISCRIMINATOR = sha256(
    new TextEncoder().encode("event:SwapEvent"),
  ).subarray(0, 8);
  const SWAP_EVENT_DISCRIMINATOR_V2 = sha256(
    new TextEncoder().encode("event:SwapsEvent"),
  ).subarray(0, 8);

  // Decoders
  const SwapEventDecoder = getStructDecoder([
    ["amm", getAddressDecoder()],
    ["inputMint", getAddressDecoder()],
    ["inputAmount", getU64Decoder()],
    ["outputMint", getAddressDecoder()],
    ["outputAmount", getU64Decoder()],
  ]);
  const SwapEventV2Decoder = getStructDecoder([
    ["inputMint", getAddressDecoder()],
    ["inputAmount", getU64Decoder()],
    ["outputMint", getAddressDecoder()],
    ["outputAmount", getU64Decoder()],
  ]);
  const SwapsEventDecoder = getStructDecoder([
    [
      "swapEvents",
      getArrayDecoder(SwapEventV2Decoder, { size: getU32Decoder() }),
    ],
  ]);

  // Find SwapEvent logs in inner instructions
  let foundAny = false;
  for (const ix of innerIxs) {
    const data: Uint8Array = new Uint8Array((ix as any).data as any);
    const eventDiscriminator = data.subarray(8, 16);
    const isSwapEvent =
      arraysEqual(eventDiscriminator, SWAP_EVENT_DISCRIMINATOR) ||
      arraysEqual(eventDiscriminator, SWAP_EVENT_DISCRIMINATOR_V2);
    if (!isSwapEvent) continue;
    const eventData = data.subarray(16);

    if (
      ["ROUTE_V2", "SHARED_ACCOUNTS_ROUTE_V2", "EXACT_OUT_ROUTE_V2"].includes(
        instructionFound,
      )
    ) {
      const event = SwapsEventDecoder.decode(eventData);
      for (const swap of event.swapEvents) {
        // Verifies if SOL is involved
        if (
          swap.inputMint.toString() === SOL_MINT.toString() ||
          swap.outputMint.toString() === SOL_MINT.toString()
        ) {
          console.log("\nSWAP DETECTED (V2):");
          console.log("  Input Mint:", swap.inputMint.toString());
          console.log("  Input Amount:", swap.inputAmount.toString());
          console.log("  Output Mint:", swap.outputMint.toString());
          console.log("  Output Amount:", swap.outputAmount.toString());

          await db.prisma.transaction.upsert({
            where: { signature },
            create: {
              signature,
              slot,
              account: signer,
              input_mint: swap.inputMint.toString(),
              input_amount: Number(swap.inputAmount.toString()),
              output_mint: swap.outputMint.toString(),
              output_amount: Number(swap.outputAmount.toString()),
            },
            update: {
              slot,
              account: signer,
              input_mint: swap.inputMint.toString(),
              input_amount: Number(swap.inputAmount.toString()),
              output_mint: swap.outputMint.toString(),
              output_amount: Number(swap.outputAmount.toString()),
            },
          });
          foundAny = true;
        }
      }
    } else {
      const event = SwapEventDecoder.decode(eventData);

      // Verifies if SOL is involved
      if (
        event.inputMint.toString() === SOL_MINT.toString() ||
        event.outputMint.toString() === SOL_MINT.toString()
      ) {
        console.log("SWAP DETECTED:");
        console.log("  AMM:", event.amm.toString());
        console.log("  Input Mint:", event.inputMint.toString());
        console.log("  Input Amount:", event.inputAmount.toString());
        console.log("  Output Mint:", event.outputMint.toString());
        console.log("  Output Amount:", event.outputAmount.toString());

        await db.prisma.transaction.upsert({
          where: { signature },
          create: {
            signature,
            slot,
            account: signer,
            input_mint: event.inputMint.toString(),
            input_amount: Number(event.inputAmount.toString()),
            output_mint: event.outputMint.toString(),
            output_amount: Number(event.outputAmount.toString()),
          },
          update: {
            slot,
            account: signer,
            input_mint: event.inputMint.toString(),
            input_amount: Number(event.inputAmount.toString()),
            output_mint: event.outputMint.toString(),
            output_amount: Number(event.outputAmount.toString()),
          },
        });
        foundAny = true;
      }
    }
  }
  return foundAny;
}
