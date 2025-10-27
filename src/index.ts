import Client, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import dotenv from "dotenv";
import bs58 from "bs58";

dotenv.config();

async function main() {
  console.log(process.env.GRPC_ENDPOINT);
  const grpcEndpoint = process.env.GRPC_ENDPOINT;
  if (!grpcEndpoint) {
    throw new Error("GRPC_ENDPOINT not defined");
  }

  const commitment = CommitmentLevel.CONFIRMED;
  const grpcToken = process.env.GRPC_TOKEN;
  const client = new Client(grpcEndpoint, grpcToken, undefined);

  const stream = await client.subscribe();
  let count = 0;

  // Handle updates
  stream.on("data", (data) => {
    console.log(`This is the data ${data}`)

    if (data.transaction) {
      if (count === 1) {
        console.log("Received 1 transaction, exiting...");
        process.exit(0);
      }
      count++;
      const value = data.transaction.transaction;
      const signature = data.transaction.transaction.signature
      const sig = bs58.encode(signature)
      console.log("data", value);
      console.log("signature", sig);
    }
    return;
  });

  // Create subscribe request based on provided arguments.
  const request: SubscribeRequest = {
    accounts: {},
    slots: {},
    transactions: {
      jupiter: {
        vote: false,
        accountInclude: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    ping: undefined,
  };

  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: any) => {
      if (err === null || err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
  }).catch((reason) => {
    console.error(reason);
    throw reason;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
