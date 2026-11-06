# RevenuePlug Backend Foundation - Setup Guide

This guide covers the complete setup of the RevenuePlug backend foundation.

## Architecture Overview

**Multi-Platform, Event-Driven SaaS Backend**

- **Postgres** → Source of truth (users, accounts, connections, Stripe/Polar/etc. data)
- **Kafka** → Event stream for business events (subscription.created, payment.failed, etc.)
- **ClickHouse** → Analytics database (reads only from Kafka events, never from Postgres)
- **Redis + BullMQ** → Background jobs (syncs, retries, async workflows)

**Key Architectural Patterns:**
- Platform Adapter Pattern for multi-platform support (Stripe, Polar, RevenueCat, LemonSqueezy)
- Event normalization across platforms
- Transactional outbox for reliable event publishing
- Encrypted credential storage

## Prerequisites

- Node.js 20+ (LTS)
- Docker and Docker Compose
- pnpm (recommended) or npm

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
# or
npm install
```

### 2. Start Infrastructure

Start all infrastructure services (Postgres, Redis, Kafka, ClickHouse):

```bash
pnpm docker:up
# or
docker compose up -d
```

Wait for all services to be healthy:

```bash
docker compose ps
```

### 3. Setup Database

Generate Prisma client:

```bash
pnpm prisma:generate
```

Run database migrations:

```bash
pnpm prisma:migrate:dev
```

### 4. Start Development Server

```bash
pnpm dev
```

The server will start on `http://localhost:3000`.

### 5. Verify Setup

Check health endpoints:

```bash
# Liveness (is server running?)
curl http://localhost:3000/health/liveness

# Readiness (are all dependencies ready?)
curl http://localhost:3000/health/readiness

# General health
curl http://localhost:3000/health
```

All checks should return `healthy` or `ready`.
