# Solana Jupiter Indexer

A real-time Solana transaction indexer that monitors and parses Jupiter DEX swap transactions, storing SOL-involved trades in a PostgreSQL database.

## What it does

- **Real-time monitoring** of Jupiter V6 swap transactions on Solana
- **Filters SOL trades** - only indexes swaps involving SOL (native Solana token)
- **Database storage** - saves transaction details (amounts, mints, signatures) to PostgreSQL
- **gRPC streaming** - uses Yellowstone gRPC for efficient transaction streaming

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL database
- Yellowstone gRPC access (endpoint + token)

### Setup

1. **Clone and install**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   # Create .env file
   DATABASE_URL="postgresql://username:password@localhost:5432/solana_indexer"
   GRPC_ENDPOINT="your-yellowstone-grpc-endpoint"
   GRPC_TOKEN="your-grpc-token"
   ```

3. **Setup database**
   ```bash
   npm run db:generate  # Generate Prisma client
   npm run db:push      # Create database tables
   ```

4. **Test connection**
   ```bash
   npm run test:connection
   ```

5. **Run indexer**
   ```bash
   npm run dev
   ```

## Database Schema

The indexer stores transactions in a `Transaction` table:

| Field | Type | Description |
|-------|------|-------------|
| `signature` | String | Transaction signature (unique) |
| `slot` | BigInt | Solana slot number |
| `account` | String | Signer account address |
| `input_mint` | String | Input token mint address |
| `input_amount` | BigInt | Input token amount |
| `output_mint` | String | Output token mint address |
| `output_amount` | BigInt | Output token amount |

## How it works

1. **Connects** to Yellowstone gRPC stream
2. **Filters** for transactions involving Jupiter V6 program
3. **Parses** swap events from transaction logs
4. **Validates** that SOL is either input or output token
5. **Stores** swap data in PostgreSQL database

## Scripts

```bash
npm run build           # Compile TypeScript
npm run dev             # Build and run indexer
npm run test:connection # Test database connectivity
npm run db:generate     # Generate Prisma client
npm run db:push         # Push schema to database
```

## Dependencies

- **@triton-one/yellowstone-grpc** - Solana transaction streaming
- **@solana/kit** - Solana transaction parsing utilities  
- **@prisma/client** - Database ORM
- **@noble/hashes** - Cryptographic hashing for event parsing

---

*Built for monitoring SOL trading activity on Jupiter DEX* 🪐
